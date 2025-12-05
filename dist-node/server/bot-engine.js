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
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { getMarket } from '../utils/fetch-data.util.js';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util.js';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// --- Local Enum Definition for SignatureType (Missing in export) ---
var SignatureType;
(function (SignatureType) {
    SignatureType[SignatureType["EOA"] = 0] = "EOA";
    SignatureType[SignatureType["POLY_GNOSIS_SAFE"] = 1] = "POLY_GNOSIS_SAFE";
    SignatureType[SignatureType["POLY_PROXY"] = 2] = "POLY_PROXY";
})(SignatureType || (SignatureType = {}));
// --- ADAPTER: ZeroDev (Viem) -> Ethers.js Signer ---
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
        const signature = await this.kernelClient.signMessage({
            message: typeof message === 'string' ? message : { raw: message }
        });
        return signature;
    }
    async signTypedData(domain, types, value) {
        return await this.kernelClient.signTypedData({
            domain,
            types,
            primaryType: Object.keys(types)[0],
            message: value
        });
    }
    // --- COMPATIBILITY SHIM ---
    // The Polymarket SDK (built for Ethers v5) calls _signTypedData.
    // Ethers v6 removed the underscore. We map it here to prevent "is not a function" errors.
    async _signTypedData(domain, types, value) {
        return this.signTypedData(domain, types, value);
    }
    async signTransaction(tx) {
        throw new Error("signTransaction is not supported for KernelEthersSigner. Use sendTransaction to dispatch UserOperations.");
    }
    async sendTransaction(tx) {
        // IMPORTANT: We cast to 'any' to avoid strict Viem type checks on the tx object
        // The kernel client handles the UserOp construction internally.
        const hash = await this.kernelClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value.toString()) : BigInt(0)
        });
        // Return an object compatible with Ethers TransactionResponse.wait()
        return {
            hash,
            wait: async () => {
                // Use ethers provider to wait for receipt, safer than relying on kernelClient
                if (this.provider) {
                    return await this.provider.waitForTransaction(hash);
                }
                throw new Error("Provider missing in KernelEthersSigner");
            }
        };
    }
    connect(provider) {
        return new KernelEthersSigner(this.kernelClient, this.address, provider || this.provider);
    }
}
const USDC_ABI_MINIMAL = [
    'function approve(address spender, uint256 amount) returns (bool)'
];
export class BotEngine {
    constructor(config, registryService, callbacks) {
        this.config = config;
        this.registryService = registryService;
        this.callbacks = callbacks;
        this.isRunning = false;
        // Use in-memory logs as a buffer (optional backup)
        this.activePositions = [];
        this.stats = {
            totalPnl: 0,
            totalVolume: 0,
            totalFeesPaid: 0,
            winRate: 0,
            tradesCount: 0,
            allowanceApproved: false
        };
        if (config.activePositions) {
            this.activePositions = config.activePositions;
        }
        if (config.stats) {
            this.stats = config.stats;
        }
    }
    getStats() { return this.stats; }
    // Async log writing to DB
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
    async revokePermissions() {
        if (this.executor) {
            await this.executor.revokeAllowance();
            this.stats.allowanceApproved = false;
            this.addLog('warn', 'Permissions Revoked by User.');
        }
    }
    // --- DEPOSIT GATED ACTIVATION ---
    // The bot will effectively "Pause" until it sees funds.
    // Once funds arrive, it sends a self-transaction to initialize the chain state
    // and THEN attempts the Handshake.
    async waitForFunds(wallet, usdcAddress) {
        // Native USDC Address (for warning users who bridge wrong token)
        const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
        const checkBalances = async () => {
            try {
                // Check Bridged USDC (USDC.e) - Required
                const balance = await getUsdBalanceApprox(wallet, usdcAddress);
                // Check Native USDC - Informational
                let nativeBalance = 0;
                try {
                    nativeBalance = await getUsdBalanceApprox(wallet, NATIVE_USDC);
                }
                catch (e) { /* ignore */ }
                // Check POL - Informational
                let polBalance = 0;
                try {
                    polBalance = await getPolBalance(wallet);
                }
                catch (e) { /* ignore */ }
                await this.addLog('info', `💰 Balance Scan: ${balance.toFixed(2)} USDC.e | ${nativeBalance.toFixed(2)} USDC (Native) | ${polBalance.toFixed(4)} POL`);
                // Valid if we have at least $0.50 bridged USDC
                if (balance >= 0.5) {
                    return true;
                }
                if (nativeBalance >= 1.0 && balance < 0.5) {
                    await this.addLog('warn', `⚠️ Found Native USDC ($${nativeBalance}) but no Bridged USDC.e. Polymarket requires Bridged USDC.e (0x2791...). Please swap/bridge.`);
                }
            }
            catch (e) {
                console.error("Balance check error:", e);
                await this.addLog('error', `Balance Check Failed: ${e.message || 'RPC Error'}`);
            }
            return false;
        };
        // Initial Check
        if (await checkBalances())
            return;
        await this.addLog('warn', '💰 Account Empty (USDC.e < 0.50). Waiting for funds...');
        return new Promise((resolve) => {
            const checkInterval = setInterval(async () => {
                if (!this.isRunning) {
                    clearInterval(checkInterval);
                    return;
                }
                const funded = await checkBalances();
                if (funded) {
                    clearInterval(checkInterval);
                    await this.addLog('success', `✅ Funds detected. Initializing Bot...`);
                    resolve();
                }
            }, 15000); // Check every 15s
        });
    }
    // Force On-Chain Key Registration (only once funded)
    async activateOnChain(signer, walletAddress, usdcAddress) {
        try {
            await this.addLog('info', '🔄 Syncing Session Key on-chain...');
            const usdc = new Contract(usdcAddress, USDC_ABI_MINIMAL, signer);
            // Approve 0 USDC to self. Valid UserOp that initializes the account.
            const tx = await usdc.approve(walletAddress, 0);
            await this.addLog('info', `🚀 Activation Tx Sent: ${tx.hash?.slice(0, 10)}... Waiting for block...`);
            await tx.wait();
            await this.addLog('success', '✅ Smart Account Deployed & Key Active.');
        }
        catch (e) {
            // It might already be active, or paymaster might have handled it differently
            // We log but proceed cautiously as handshakes often work even if this "explicit" activation hiccups
            console.log("Activation Tx Note:", e.message);
        }
    }
    async start() {
        if (this.isRunning)
            return;
        try {
            this.isRunning = true;
            await this.addLog('info', 'Starting Server-Side Bot Engine...');
            const logger = {
                info: (msg) => { console.log(`[${this.config.userId}] ${msg}`); this.addLog('info', msg); },
                warn: (msg) => { console.warn(`[${this.config.userId}] ${msg}`); this.addLog('warn', msg); },
                error: (msg, err) => { console.error(`[${this.config.userId}] ${msg}`, err); this.addLog('error', `${msg} ${err?.message || ''}`); },
                debug: () => { }
            };
            const env = {
                rpcUrl: this.config.rpcUrl,
                tradeMultiplier: this.config.multiplier,
                fetchIntervalSeconds: 2,
                aggregationWindowSeconds: 300,
                enableNotifications: this.config.enableNotifications,
                adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET || '0x0000000000000000000000000000000000000000',
                // FIX: Forced Update to Bridged USDC (USDC.e) address for Polygon.
                // Polymarket CLOB only accepts this specific token (0x2791...).
                // Native USDC (0x3c49...) cannot be used for trading.
                usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            };
            // --- ACCOUNT STRATEGY SELECTION ---
            let signerImpl;
            let walletAddress;
            let clobCreds = undefined;
            let signatureType = SignatureType.EOA; // Default
            // 1. Smart Account Strategy
            if (this.config.walletConfig?.type === 'SMART_ACCOUNT' && this.config.walletConfig.serializedSessionKey) {
                await this.addLog('info', '🔐 Initializing ZeroDev Smart Account Session...');
                const rpcUrl = this.config.zeroDevRpc || process.env.ZERODEV_RPC;
                if (!rpcUrl || rpcUrl.includes('your-project-id') || rpcUrl.includes('DEFAULT')) {
                    throw new Error("CRITICAL: ZERODEV_RPC is missing or invalid in .env.");
                }
                const aaService = new ZeroDevService(rpcUrl);
                const { address, client: kernelClient } = await aaService.createBotClient(this.config.walletConfig.serializedSessionKey);
                walletAddress = address;
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                signerImpl = new KernelEthersSigner(kernelClient, address, provider);
                signatureType = SignatureType.POLY_PROXY;
                // --- DEPOSIT GATE: Block here if empty ---
                await this.waitForFunds(signerImpl, env.usdcContractAddress);
                if (!this.isRunning)
                    return; // If stopped while waiting
                // --- ON-CHAIN ACTIVATION ---
                // Now that we have funds (or just woke up), ensure we are deployed/active
                // This prevents the 401 Invalid L1 Headers error
                await this.activateOnChain(signerImpl, walletAddress, env.usdcContractAddress);
                // --- L2 AUTHENTICATION ---
                const dbCreds = this.config.l2ApiCredentials;
                const hasValidCreds = dbCreds
                    && typeof dbCreds.key === 'string' && dbCreds.key.length > 5
                    && typeof dbCreds.secret === 'string' && dbCreds.secret.length > 5;
                if (hasValidCreds) {
                    clobCreds = dbCreds;
                }
                else {
                    await this.addLog('info', '🤝 Performing Polymarket L2 Handshake...');
                    try {
                        const tempClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, signerImpl, undefined, signatureType);
                        // Retry Logic for Handshake (Deals with Indexer Lag)
                        let newCreds = null;
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            try {
                                newCreds = await tempClient.createApiKey();
                                if (newCreds && newCreds.key)
                                    break;
                            }
                            catch (e) {
                                await sleep(2000); // Wait for indexer
                            }
                        }
                        if (!newCreds || !newCreds.key) {
                            throw new Error(`CLOB Handshake Failed. Ensure account is funded and deployed.`);
                        }
                        clobCreds = newCreds;
                        // Persist to DB
                        await User.findOneAndUpdate({ address: this.config.userId }, { "proxyWallet.l2ApiCredentials": newCreds });
                        await this.addLog('success', '✅ L2 Login Successful.');
                    }
                    catch (e) {
                        const msg = e?.message || JSON.stringify(e);
                        await this.addLog('error', `CRITICAL: Auth Failed. Bot cannot trade. Error: ${msg}`);
                        throw new Error(`L2 Handshake Failed: ${msg}`);
                    }
                }
            }
            else {
                // 2. Legacy EOA Strategy
                await this.addLog('info', 'Using Standard EOA Wallet');
                const activeKey = this.config.privateKey || this.config.walletConfig?.sessionPrivateKey;
                if (!activeKey)
                    throw new Error("No valid signing key found for EOA.");
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                signerImpl = new Wallet(activeKey, provider);
                walletAddress = signerImpl.address;
                if (this.config.polymarketApiKey && this.config.polymarketApiSecret && this.config.polymarketApiPassphrase) {
                    clobCreds = {
                        key: this.config.polymarketApiKey,
                        secret: this.config.polymarketApiSecret,
                        passphrase: this.config.polymarketApiPassphrase
                    };
                }
            }
            // --- FINAL CHECK ---
            if (!clobCreds || !clobCreds.secret) {
                throw new Error("Bot failed to initialize valid trading credentials. Please try 'Revoke' then 'Start' again.");
            }
            // --- BUILDER PROGRAM INTEGRATION ---
            let builderConfig;
            if (process.env.POLY_BUILDER_API_KEY && process.env.POLY_BUILDER_SECRET && process.env.POLY_BUILDER_PASSPHRASE) {
                const builderCreds = {
                    key: process.env.POLY_BUILDER_API_KEY,
                    secret: process.env.POLY_BUILDER_SECRET,
                    passphrase: process.env.POLY_BUILDER_PASSPHRASE
                };
                builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
            }
            // Initialize Polymarket Client
            const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, signerImpl, clobCreds, signatureType, undefined, // funderAddress
            undefined, // ...
            undefined, // ...
            builderConfig);
            this.client = Object.assign(clobClient, { wallet: signerImpl });
            await this.addLog('success', `Bot Online: ${walletAddress.slice(0, 6)}...`);
            const notifier = new NotificationService(env, logger);
            const fundManagerConfig = {
                enabled: this.config.autoCashout?.enabled || false,
                maxRetentionAmount: this.config.autoCashout?.maxAmount || 0,
                destinationAddress: this.config.autoCashout?.destinationAddress || '',
                usdcContractAddress: env.usdcContractAddress
            };
            const fundManager = new FundManagerService(this.client.wallet, fundManagerConfig, logger, notifier);
            const feeDistributor = new FeeDistributorService(this.client.wallet, env, logger, this.registryService);
            this.executor = new TradeExecutorService({
                client: this.client,
                proxyWallet: walletAddress,
                env,
                logger
            });
            // await this.addLog('info', 'Checking Token Allowances...');
            const approved = await this.executor.ensureAllowance();
            this.stats.allowanceApproved = approved;
            try {
                const cashoutResult = await fundManager.checkAndSweepProfits();
                if (cashoutResult && this.callbacks?.onCashout)
                    await this.callbacks.onCashout(cashoutResult);
            }
            catch (e) { /* ignore start up cashout error */ }
            // Start Trade Monitor
            this.monitor = new TradeMonitorService({
                client: this.client,
                logger,
                env,
                userAddresses: this.config.userAddresses,
                onDetectedTrade: async (signal) => {
                    let shouldExecute = true;
                    let aiReasoning = "Legacy Mode (No AI Key)";
                    let riskScore = 5;
                    const apiKeyToUse = this.config.geminiApiKey || process.env.API_KEY;
                    if (apiKeyToUse) {
                        await this.addLog('info', `[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price} ($${signal.sizeUsd.toFixed(0)}) from ${signal.trader.slice(0, 4)}`);
                        const analysis = await aiAgent.analyzeTrade(`Market: ${signal.marketId}`, signal.side, signal.outcome, signal.sizeUsd, signal.price, this.config.riskProfile, apiKeyToUse // Pass dynamic key
                        );
                        shouldExecute = analysis.shouldCopy;
                        aiReasoning = analysis.reasoning;
                        riskScore = analysis.riskScore;
                    }
                    else {
                        await this.addLog('warn', '⚠️ No Gemini API Key found. Skipping AI Analysis.');
                    }
                    if (shouldExecute) {
                        try {
                            let executedSize = 0;
                            if (this.executor) {
                                executedSize = await this.executor.copyTrade(signal);
                            }
                            if (executedSize > 0) {
                                let realPnl = 0;
                                if (signal.side === 'BUY') {
                                    const newPosition = {
                                        marketId: signal.marketId,
                                        tokenId: signal.tokenId,
                                        outcome: signal.outcome,
                                        entryPrice: signal.price,
                                        sizeUsd: executedSize,
                                        timestamp: Date.now()
                                    };
                                    this.activePositions.push(newPosition);
                                }
                                else if (signal.side === 'SELL') {
                                    const posIndex = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                                    if (posIndex !== -1) {
                                        const entry = this.activePositions[posIndex];
                                        const yieldPercent = (signal.price - entry.entryPrice) / entry.entryPrice;
                                        realPnl = entry.sizeUsd * yieldPercent;
                                        await this.addLog('success', `✅ Realized PnL: $${realPnl.toFixed(2)} (${(yieldPercent * 100).toFixed(1)}%)`);
                                        this.activePositions.splice(posIndex, 1);
                                    }
                                    else {
                                        realPnl = 0;
                                    }
                                }
                                if (this.callbacks?.onPositionsUpdate)
                                    await this.callbacks.onPositionsUpdate(this.activePositions);
                                await this.recordTrade({
                                    marketId: signal.marketId,
                                    outcome: signal.outcome,
                                    side: signal.side,
                                    price: signal.price,
                                    size: signal.sizeUsd,
                                    executedSize: executedSize,
                                    aiReasoning: aiReasoning,
                                    riskScore: riskScore,
                                    pnl: realPnl,
                                    status: signal.side === 'SELL' ? 'CLOSED' : 'OPEN'
                                });
                                await notifier.sendTradeAlert(signal);
                                if (signal.side === 'SELL' && realPnl > 0) {
                                    const feeEvent = await feeDistributor.distributeFeesOnProfit(signal.marketId, realPnl, signal.trader);
                                    if (feeEvent) {
                                        this.stats.totalFeesPaid += (feeEvent.platformFee + feeEvent.listerFee);
                                        if (this.callbacks?.onFeePaid)
                                            await this.callbacks.onFeePaid(feeEvent);
                                    }
                                }
                                if (this.callbacks?.onStatsUpdate)
                                    await this.callbacks.onStatsUpdate(this.stats);
                                setTimeout(async () => {
                                    const cashout = await fundManager.checkAndSweepProfits();
                                    if (cashout && this.callbacks?.onCashout)
                                        await this.callbacks.onCashout(cashout);
                                }, 15000);
                            }
                        }
                        catch (err) {
                            await this.addLog('error', `Execution Failed: ${err.message}`);
                        }
                    }
                    else {
                        await this.recordTrade({
                            marketId: signal.marketId,
                            outcome: signal.outcome,
                            side: signal.side,
                            price: signal.price,
                            size: signal.sizeUsd,
                            executedSize: 0,
                            aiReasoning: aiReasoning,
                            riskScore: riskScore,
                            status: 'SKIPPED'
                        });
                    }
                }
            });
            await this.monitor.start(this.config.startCursor);
            this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000);
        }
        catch (e) {
            this.isRunning = false;
            await this.addLog('error', `Startup Failed: ${e.message}`);
        }
    }
    async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.client || this.activePositions.length === 0)
            return;
        const positionsToCheck = [...this.activePositions];
        for (const pos of positionsToCheck) {
            try {
                let isClosed = false;
                try {
                    const market = await getMarket(pos.marketId);
                    if (market.closed || market.active === false || market.enable_order_book === false) {
                        isClosed = true;
                    }
                }
                catch (e) {
                    continue;
                }
                if (isClosed) {
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
                        await this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} is up +${gainPercent.toFixed(1)}%`);
                        const success = await this.executor.executeManualExit(pos, bestBid);
                        if (success) {
                            this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                            if (this.callbacks?.onPositionsUpdate)
                                await this.callbacks.onPositionsUpdate(this.activePositions);
                            const realPnl = pos.sizeUsd * (gainPercent / 100);
                            await this.recordTrade({
                                marketId: pos.marketId,
                                outcome: pos.outcome,
                                side: 'SELL',
                                price: bestBid,
                                size: pos.sizeUsd,
                                executedSize: pos.sizeUsd,
                                aiReasoning: 'Auto Take-Profit Trigger',
                                riskScore: 0,
                                pnl: realPnl,
                                status: 'CLOSED'
                            });
                        }
                    }
                }
            }
            catch (e) {
                if (e.message?.includes('404') || e.response?.status === 404 || e.status === 404) {
                    this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                    if (this.callbacks?.onPositionsUpdate)
                        await this.callbacks.onPositionsUpdate(this.activePositions);
                }
            }
        }
    }
    async recordTrade(data) {
        const entry = {
            id: Math.random().toString(36).substring(7),
            timestamp: new Date().toISOString(),
            ...data
        };
        if (data.status !== 'SKIPPED') {
            this.stats.tradesCount = (this.stats.tradesCount || 0) + 1;
            this.stats.totalVolume = (this.stats.totalVolume || 0) + data.executedSize;
            if (data.pnl) {
                this.stats.totalPnl = (this.stats.totalPnl || 0) + data.pnl;
            }
        }
        if (this.callbacks?.onTradeComplete) {
            await this.callbacks.onTradeComplete(entry);
        }
        if (data.status !== 'SKIPPED' && this.callbacks?.onStatsUpdate) {
            await this.callbacks.onStatsUpdate(this.stats);
        }
    }
    stop() {
        this.isRunning = false;
        if (this.monitor)
            this.monitor.stop();
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.addLog('warn', 'Bot Engine Stopped.');
    }
}
