import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ZeroDevService } from '../services/zerodev.service.js';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { Wallet, AbstractSigner, JsonRpcProvider, Contract } from 'ethers';
import { BotLog, User } from '../database/index.js';
import { getMarket } from '../utils/fetch-data.util.js';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util.js';
import { TOKENS } from '../config/env.js';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Polymarket Signature Types
// 0 = EOA (Metamask), 1 = PolyProxy (Legacy), 2 = Gnosis Safe (Smart Accounts/Kernel)
var SignatureType;
(function (SignatureType) {
    SignatureType[SignatureType["EOA"] = 0] = "EOA";
    SignatureType[SignatureType["POLY_PROXY"] = 1] = "POLY_PROXY";
    SignatureType[SignatureType["GNOSIS_SAFE"] = 2] = "GNOSIS_SAFE";
})(SignatureType || (SignatureType = {}));
// --- ADAPTER: ZeroDev (Viem) -> Ethers.js Signer ---
// This ensures compatibility with the ClobClient which expects an Ethers v5/v6 signer
// CRITICAL: Handles EIP-712 typing correctly for EIP-1271 validation by forcing primaryType.
class KernelEthersSigner extends AbstractSigner {
    constructor(kernelClient, address, provider) {
        super(provider);
        this.kernelClient = kernelClient;
        this.address = address;
    }
    async getAddress() {
        return this.address;
    }
    async signMessage(message) {
        // ZeroDev's signMessage handles EIP-1271 wrapping automatically
        return await this.kernelClient.signMessage({
            message: typeof message === 'string' ? message : { raw: message }
        });
    }
    // This method is called by ClobClient for L1 Headers (Auth) and Order Signing
    // It is the Critical Path for "Invalid L1 Request" errors.
    async signTypedData(domain, types, value) {
        // 1. CLEANUP: Viem does not want EIP712Domain in the types object
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { EIP712Domain, ...cleanTypes } = types;
        // 2. PRIMARY TYPE DETECTION (The Magic Fix)
        // Polymarket requires specific primary types. Viem infers them, but explicit is safer.
        let primaryType = Object.keys(cleanTypes)[0]; // Default Fallback
        // If it looks like an auth message (contains 'message' and 'timestamp')
        if (cleanTypes.ClobAuth || (value.message && value.timestamp && value.nonce)) {
            primaryType = 'ClobAuth';
        }
        // If it looks like an order (contains 'side' and 'size')
        else if (cleanTypes.Order || (value.side && value.size && value.maker)) {
            primaryType = 'Order';
        }
        // 3. CHAIN ID SANITIZATION
        const sanitizedDomain = { ...domain };
        if (sanitizedDomain.chainId) {
            sanitizedDomain.chainId = Number(sanitizedDomain.chainId);
        }
        // 4. SIGN VIA KERNEL
        return await this.kernelClient.signTypedData({
            domain: sanitizedDomain,
            types: cleanTypes,
            primaryType,
            message: value
        });
    }
    // Compatibility alias for Ethers v6
    async _signTypedData(domain, types, value) {
        return this.signTypedData(domain, types, value);
    }
    async signTransaction(tx) {
        throw new Error("signTransaction is not supported for Smart Accounts. Use sendTransaction.");
    }
    async sendTransaction(tx) {
        // Convert Ethers TX to Viem UserOp
        const hash = await this.kernelClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value.toString()) : BigInt(0)
        });
        return {
            hash,
            wait: async () => {
                if (this.provider) {
                    return await this.provider.waitForTransaction(hash);
                }
                return { hash };
            }
        };
    }
    connect(provider) {
        return new KernelEthersSigner(this.kernelClient, this.address, provider || this.provider);
    }
}
const USDC_ABI_MINIMAL = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function transfer(address to, uint256 amount) returns (bool)'
];
export class BotEngine {
    constructor(config, registryService, callbacks) {
        this.config = config;
        this.registryService = registryService;
        this.callbacks = callbacks;
        this.isRunning = false;
        this.activePositions = [];
        this.stats = {
            totalPnl: 0,
            totalVolume: 0,
            totalFeesPaid: 0,
            winRate: 0,
            tradesCount: 0,
            allowanceApproved: false
        };
        if (config.activePositions)
            this.activePositions = config.activePositions;
        if (config.stats)
            this.stats = config.stats;
    }
    getStats() { return this.stats; }
    async addLog(type, message) {
        try {
            await BotLog.create({
                userId: this.config.userId,
                type,
                message,
                timestamp: new Date()
            });
        }
        catch (e) {
            console.error("Failed to persist log to DB", e);
        }
    }
    // --- ROBUST STARTUP PIPELINE ---
    // Step 1: Wait for Funds (Blocking)
    async waitForFunds(wallet) {
        let attempts = 0;
        // Bridged USDC is what we need
        const USDC_ADDRESS = TOKENS.USDC_BRIDGED;
        while (attempts < 20 && this.isRunning) {
            try {
                const usdcBal = await getUsdBalanceApprox(wallet, USDC_ADDRESS);
                const polBal = await getPolBalance(wallet);
                await this.addLog('info', `💰 Balance Scan: ${usdcBal.toFixed(2)} USDC.e | ${polBal.toFixed(4)} POL`);
                if (usdcBal >= 0.5)
                    return true; // Enough to wake up and trade
                // Native USDC Warning
                try {
                    const nativeBal = await getUsdBalanceApprox(wallet, TOKENS.USDC_NATIVE);
                    if (nativeBal > 1.0) {
                        await this.addLog('warn', `⚠️ You have Native USDC ($${nativeBal}). Polymarket REQUIRES Bridged USDC.e (0x2791...). Please bridge/swap.`);
                    }
                }
                catch (e) { }
                if (attempts % 2 === 0)
                    await this.addLog('warn', '💰 Account Empty (USDC.e < 0.50). Waiting for deposit...');
            }
            catch (e) {
                console.error("Balance Check Failed", e);
            }
            await sleep(15000); // Check every 15s
            attempts++;
        }
        return false;
    }
    // Step 2: Ensure Contract is Deployed (The "Wake Up")
    // Uses 0.1 USDC self-transfer to force Paymaster deployment
    async ensureDeployed(signer, walletAddress) {
        try {
            if (!signer.provider)
                throw new Error("No provider");
            // Check for code
            const code = await signer.provider.getCode(walletAddress);
            if (code && code.length > 2) {
                await this.addLog('success', '✅ Smart Account Ready (Deployed).');
                return true; // Already deployed
            }
            // If not deployed, we force it with a 0.1 USDC transfer to self
            await this.addLog('info', '🔄 Undeployed Account Detected. Sending 0.1 USDC self-transfer to deploy...');
            // 0.1 USDC.e (Bridged) = 100000 units (6 decimals)
            const usdc = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI_MINIMAL, signer);
            const tx = await usdc.transfer(walletAddress, 100000);
            await this.addLog('info', `🚀 Wake-up Tx Sent: ${tx.hash?.slice(0, 10)}... Waiting for indexing...`);
            await tx.wait();
            // Verification Loop
            let attempts = 0;
            while (attempts < 10) {
                await sleep(3000);
                const newCode = await signer.provider.getCode(walletAddress);
                if (newCode && newCode.length > 2) {
                    await this.addLog('success', '✅ Smart Account Successfully Deployed.');
                    return true;
                }
                attempts++;
            }
            throw new Error("Deployment verification timed out. Indexer lagging?");
        }
        catch (e) {
            await this.addLog('warn', `Deployment Sync Note: ${e.message}. Proceeding to auth (might fail if truly undeployed)...`);
            return false;
        }
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        try {
            await this.addLog('info', '🚀 Initializing Bot Engine...');
            // 1. Setup Wallet / Signer
            let wallet;
            let signatureType = SignatureType.EOA;
            let funderAddress;
            if (this.config.walletConfig && this.config.walletConfig.type === 'SMART_ACCOUNT') {
                const { zeroDevRpc, zeroDevPaymasterRpc, walletConfig } = this.config;
                if (!zeroDevRpc)
                    throw new Error("Missing ZeroDev RPC URL");
                const zdService = new ZeroDevService(zeroDevRpc, zeroDevPaymasterRpc);
                const { address, client } = await zdService.createBotClient(walletConfig.serializedSessionKey);
                // Verify address matches config
                if (address.toLowerCase() !== walletConfig.address.toLowerCase()) {
                    await this.addLog('warn', `⚠️ Address mismatch: Config=${walletConfig.address}, Derived=${address}`);
                }
                // Wrap in Ethers Signer for ClobClient
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                wallet = new KernelEthersSigner(client, address, provider);
                // Set Critical AA Params
                signatureType = SignatureType.GNOSIS_SAFE; // 2
                funderAddress = address;
                await this.addLog('success', `🔐 Smart Session Loaded: ${address.slice(0, 6)}...`);
            }
            else if (this.config.privateKey) {
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                wallet = new Wallet(this.config.privateKey, provider);
                await this.addLog('success', `🔐 EOA Wallet Active: ${wallet.address.slice(0, 6)}...`);
            }
            else {
                throw new Error("No valid wallet configuration found.");
            }
            // 2. Wait for Funds
            const funded = await this.waitForFunds(wallet);
            if (!funded && this.isRunning) {
                await this.addLog('error', '❌ Startup Aborted: Insufficient Funds.');
                this.stop();
                return;
            }
            // 3. Ensure Deployment (Smart Accounts Only)
            if (signatureType === SignatureType.GNOSIS_SAFE && funderAddress) {
                await this.ensureDeployed(wallet, funderAddress);
            }
            // 4. Initialize Clob Client (Auth)
            await this.addLog('info', '🔌 Connecting to Polymarket CLOB...');
            // Construct credentials if available
            let creds;
            if (this.config.polymarketApiKey) {
                creds = {
                    key: this.config.polymarketApiKey,
                    secret: this.config.polymarketApiSecret,
                    passphrase: this.config.polymarketApiPassphrase
                };
            }
            else if (this.config.l2ApiCredentials) {
                creds = this.config.l2ApiCredentials;
            }
            // Initialize client
            // IMPORTANT: Explicitly pass signatureType (2) and funderAddress
            this.client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, creds, signatureType, funderAddress);
            // Attach wallet for convenience
            if (!this.client.wallet)
                this.client.wallet = wallet;
            // 5. L2 Handshake (If no creds)
            if (!creds) {
                await this.addLog('info', '🤝 Performing L2 Handshake (Deriving API Keys)...');
                try {
                    const newCreds = await this.client.createApiKey();
                    if (newCreds && newCreds.key) {
                        // Persist new credentials
                        await User.findOneAndUpdate({ address: this.config.userId }, { "proxyWallet.l2ApiCredentials": newCreds });
                        await this.addLog('success', '✅ L2 Login Successful. Credentials Saved.');
                        // CRITICAL FIX: Re-initialize client with the NEW credentials immediately.
                        // Without this, the next trade attempt will fail with HMAC signature errors (missing secret).
                        this.client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, newCreds, // Pass the fresh creds
                        signatureType, funderAddress);
                        if (!this.client.wallet)
                            this.client.wallet = wallet;
                    }
                }
                catch (e) {
                    console.error("Handshake Failed:", e);
                    // Extract useful error info
                    let errorMsg = e.message || "Unknown Error";
                    if (e?.response?.data)
                        errorMsg += ` | ${JSON.stringify(e.response.data)}`;
                    await this.addLog('error', `❌ L2 Auth Failed: ${errorMsg}`);
                    throw new Error(`L2 Handshake Failed.`);
                }
            }
            // 6. Setup Services
            const dummyLogger = {
                info: (m) => console.log(`[${this.config.userId}] ${m}`),
                warn: (m) => console.warn(`[${this.config.userId}] ${m}`),
                error: (m, e) => console.error(`[${this.config.userId}] ${m}`, e),
                debug: () => { }
            };
            // Fake Env for services
            const runtimeEnv = {
                tradeMultiplier: this.config.multiplier,
                usdcContractAddress: TOKENS.USDC_BRIDGED,
                adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0x0000000000000000000000000000000000000000',
                enableNotifications: this.config.enableNotifications,
                userPhoneNumber: this.config.userPhoneNumber,
                twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
                twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
                twilioFromNumber: process.env.TWILIO_FROM_NUMBER
            };
            // Services
            const notificationService = new NotificationService(runtimeEnv, dummyLogger);
            const fundManagerConfig = {
                enabled: this.config.autoCashout?.enabled || false,
                maxRetentionAmount: this.config.autoCashout?.maxAmount,
                destinationAddress: this.config.autoCashout?.destinationAddress,
                usdcContractAddress: TOKENS.USDC_BRIDGED
            };
            const fundManager = new FundManagerService(wallet, fundManagerConfig, dummyLogger, notificationService);
            const feeDistributor = new FeeDistributorService(wallet, runtimeEnv, dummyLogger, this.registryService);
            this.executor = new TradeExecutorService({
                client: this.client,
                proxyWallet: funderAddress || await wallet.getAddress(),
                env: runtimeEnv,
                logger: dummyLogger
            });
            // 7. Setup Monitor
            this.monitor = new TradeMonitorService({
                client: this.client,
                env: {
                    ...runtimeEnv,
                    fetchIntervalSeconds: 2,
                    aggregationWindowSeconds: 300
                },
                logger: dummyLogger,
                userAddresses: this.config.userAddresses,
                onDetectedTrade: async (signal) => {
                    if (!this.isRunning)
                        return;
                    // AI Filter
                    let riskScore = 0;
                    let aiReasoning = "AI Disabled";
                    let shouldTrade = true;
                    const geminiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY;
                    if (geminiKey) {
                        await this.addLog('info', `🤖 Analyzing trade on market ${signal.marketId}...`);
                        const analysis = await aiAgent.analyzeTrade(`Market ID: ${signal.marketId}`, signal.side, signal.outcome, signal.sizeUsd, signal.price, this.config.riskProfile, geminiKey);
                        aiReasoning = analysis.reasoning;
                        riskScore = analysis.riskScore;
                        shouldTrade = analysis.shouldCopy;
                        if (!shouldTrade) {
                            await this.addLog('warn', `🛑 AI Blocked Trade: ${aiReasoning}`);
                        }
                    }
                    let executedSize = 0;
                    let status = 'SKIPPED';
                    let txHash = '';
                    if (shouldTrade) {
                        await this.addLog('info', `⚡ Executing: ${signal.side} ${signal.outcome} ($${signal.sizeUsd.toFixed(2)})`);
                        executedSize = await this.executor.copyTrade(signal);
                        if (executedSize > 0) {
                            status = 'CLOSED'; // Or OPEN
                            await this.addLog('success', `✅ Trade Filled! Size: $${executedSize.toFixed(2)}`);
                            // Fee Distribution (on sell)
                            if (signal.side === 'SELL') {
                                const estProfit = signal.sizeUsd * 0.1; // Estimated PnL for fee calc
                                const feeEvent = await feeDistributor.distributeFeesOnProfit(signal.marketId, estProfit, signal.trader);
                                if (feeEvent && this.callbacks?.onFeePaid) {
                                    await this.callbacks.onFeePaid(feeEvent);
                                }
                            }
                            // Auto Cashout
                            const cashout = await fundManager.checkAndSweepProfits();
                            if (cashout && this.callbacks?.onCashout) {
                                await this.callbacks.onCashout(cashout);
                            }
                        }
                        else {
                            status = 'FAILED';
                            // Detailed log already inside executor
                        }
                    }
                    // Record History
                    const historyEntry = {
                        id: Math.random().toString(36).substring(7),
                        timestamp: new Date().toISOString(),
                        marketId: signal.marketId,
                        outcome: signal.outcome,
                        side: signal.side,
                        size: signal.sizeUsd,
                        executedSize,
                        price: signal.price,
                        status: status,
                        txHash,
                        aiReasoning,
                        riskScore
                    };
                    if (this.callbacks?.onTradeComplete) {
                        await this.callbacks.onTradeComplete(historyEntry);
                    }
                    if (executedSize > 0) {
                        this.stats.tradesCount++;
                        this.stats.totalVolume += executedSize;
                        if (this.callbacks?.onStatsUpdate) {
                            await this.callbacks.onStatsUpdate(this.stats);
                        }
                    }
                }
            });
            // Start Monitoring
            const startCursor = this.config.startCursor || Math.floor(Date.now() / 1000);
            await this.monitor.start(startCursor);
            await this.addLog('success', '🟢 Engine Online. Monitoring targets...');
            // Start Watchdog
            this.watchdogTimer = setInterval(() => this.checkAutoTp(), 15000);
        }
        catch (e) {
            console.error("Bot Start Error:", e);
            await this.addLog('error', `❌ Start Failed: ${e.message}`);
            this.isRunning = false;
        }
    }
    async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.client || this.activePositions.length === 0)
            return;
        const positionsToCheck = [...this.activePositions];
        for (const pos of positionsToCheck) {
            try {
                const market = await getMarket(pos.marketId);
                if (market.closed || market.active === false) {
                    this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                    if (this.callbacks?.onPositionsUpdate)
                        await this.callbacks.onPositionsUpdate(this.activePositions);
                    continue;
                }
                const orderBook = await this.client.getOrderBook(pos.tokenId);
                if (orderBook.bids && orderBook.bids.length > 0) {
                    const bestBid = parseFloat(orderBook.bids[0].price);
                    const gainPercent = ((bestBid - pos.entryPrice) / pos.entryPrice) * 100;
                    if (gainPercent >= this.config.autoTp) {
                        await this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} +${gainPercent.toFixed(1)}%`);
                        const success = await this.executor.executeManualExit(pos, bestBid);
                        if (success) {
                            this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                            if (this.callbacks?.onPositionsUpdate)
                                await this.callbacks.onPositionsUpdate(this.activePositions);
                        }
                    }
                }
            }
            catch (e) {
                // Ignore 404s
            }
        }
    }
    stop() {
        this.isRunning = false;
        if (this.monitor) {
            this.monitor.stop();
            this.monitor = undefined;
        }
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        this.addLog('info', '🔴 Engine Stopped.');
    }
}
