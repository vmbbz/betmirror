import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ZeroDevService } from '../services/zerodev.service.js';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { Wallet, AbstractSigner, JsonRpcProvider } from 'ethers';
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
    async signTransaction(tx) {
        throw new Error("signTransaction is not supported for KernelEthersSigner. Use sendTransaction to dispatch UserOperations.");
    }
    async sendTransaction(tx) {
        const hash = await this.kernelClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value.toString()) : BigInt(0)
        });
        return {
            hash,
            wait: async () => this.provider?.getTransactionReceipt(hash)
        };
    }
    connect(provider) {
        return new KernelEthersSigner(this.kernelClient, this.address, provider || this.provider);
    }
}
export class BotEngine {
    constructor(config, callbacks) {
        this.config = config;
        this.callbacks = callbacks;
        this.isRunning = false;
        this.logs = [];
        // History is now primarily stored in DB, we only keep recent logs here if needed
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
    getLogs() { return this.logs; }
    getStats() { return this.stats; }
    addLog(type, message) {
        const log = {
            id: Math.random().toString(36) + Date.now(),
            time: new Date().toLocaleTimeString(),
            type,
            message
        };
        this.logs.unshift(log);
        if (this.logs.length > 200)
            this.logs.pop();
    }
    async recordTrade(entry) {
        const historyItem = {
            id: Math.random().toString(36).substr(2, 9),
            timestamp: new Date().toISOString(),
            ...entry
        };
        if (entry.status !== 'SKIPPED') {
            this.stats.tradesCount++;
            this.stats.totalVolume += entry.size;
            if (entry.pnl) {
                this.stats.totalPnl += entry.pnl;
            }
        }
        if (this.callbacks?.onTradeComplete)
            await this.callbacks.onTradeComplete(historyItem);
        if (this.callbacks?.onStatsUpdate)
            await this.callbacks.onStatsUpdate(this.stats);
    }
    async revokePermissions() {
        if (this.executor) {
            await this.executor.revokeAllowance();
            this.stats.allowanceApproved = false;
            this.addLog('warn', 'Permissions Revoked by User.');
        }
    }
    async start() {
        if (this.isRunning)
            return;
        try {
            this.isRunning = true;
            this.addLog('info', 'Starting Server-Side Bot Engine...');
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
                usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                registryApiUrl: this.config.registryApiUrl || 'http://localhost:3000/api'
            };
            // --- ACCOUNT STRATEGY SELECTION ---
            let signerImpl;
            let walletAddress;
            let clobCreds = undefined;
            // 1. Smart Account Strategy
            if (this.config.walletConfig?.type === 'SMART_ACCOUNT' && this.config.walletConfig.serializedSessionKey) {
                this.addLog('info', '🔐 Initializing ZeroDev Smart Account Session...');
                const aaService = new ZeroDevService(this.config.zeroDevRpc || 'https://rpc.zerodev.app/api/v2/bundler/DEFAULT');
                const { address, client: kernelClient } = await aaService.createBotClient(this.config.walletConfig.serializedSessionKey);
                walletAddress = address;
                this.addLog('success', `Smart Account Active: ${walletAddress.slice(0, 6)}... (Session Key)`);
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                signerImpl = new KernelEthersSigner(kernelClient, address, provider);
                clobCreds = undefined;
            }
            else {
                // 2. Legacy EOA Strategy
                this.addLog('info', 'Using Standard EOA Wallet');
                const activeKey = this.config.privateKey || this.config.walletConfig?.sessionPrivateKey;
                if (!activeKey)
                    throw new Error("No valid signing key found for EOA.");
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                signerImpl = new Wallet(activeKey, provider);
                walletAddress = signerImpl.address;
                if (this.config.polymarketApiKey && this.config.polymarketApiSecret && this.config.polymarketApiPassphrase) {
                    this.addLog('info', '⚡ API Keys Loaded (High Performance Mode)');
                    clobCreds = {
                        key: this.config.polymarketApiKey,
                        secret: this.config.polymarketApiSecret,
                        passphrase: this.config.polymarketApiPassphrase
                    };
                }
            }
            // Initialize Polymarket Client
            const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, signerImpl, clobCreds);
            this.client = Object.assign(clobClient, { wallet: signerImpl });
            this.addLog('success', `Bot Online: ${walletAddress.slice(0, 6)}...`);
            const notifier = new NotificationService(env, logger);
            const fundManagerConfig = {
                enabled: this.config.autoCashout?.enabled || false,
                maxRetentionAmount: this.config.autoCashout?.maxAmount || 0,
                destinationAddress: this.config.autoCashout?.destinationAddress || '',
                usdcContractAddress: env.usdcContractAddress
            };
            const fundManager = new FundManagerService(this.client.wallet, fundManagerConfig, logger, notifier);
            const feeDistributor = new FeeDistributorService(this.client.wallet, env, logger);
            this.executor = new TradeExecutorService({
                client: this.client,
                proxyWallet: walletAddress,
                env,
                logger
            });
            this.addLog('info', 'Checking Token Allowances...');
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
                    if (this.config.geminiApiKey && this.config.geminiApiKey.length > 10) {
                        this.addLog('info', '🤖 AI Analyzing signal...');
                        const analysis = await aiAgent.analyzeTrade(`Market: ${signal.marketId}`, signal.side, signal.outcome, signal.sizeUsd, signal.price, this.config.geminiApiKey, this.config.riskProfile);
                        shouldExecute = analysis.shouldCopy;
                        aiReasoning = analysis.reasoning;
                        riskScore = analysis.riskScore;
                    }
                    if (shouldExecute) {
                        this.addLog('info', `Executing Copy: ${signal.side} ${signal.outcome}`);
                        try {
                            if (this.executor)
                                await this.executor.copyTrade(signal);
                            this.addLog('success', `Trade Executed Successfully!`);
                            let realPnl = 0;
                            if (signal.side === 'BUY') {
                                const newPosition = {
                                    marketId: signal.marketId,
                                    tokenId: signal.tokenId,
                                    outcome: signal.outcome,
                                    entryPrice: signal.price,
                                    sizeUsd: signal.sizeUsd,
                                    timestamp: Date.now()
                                };
                                this.activePositions.push(newPosition);
                            }
                            else if (signal.side === 'SELL') {
                                const posIndex = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                                if (posIndex !== -1) {
                                    const entry = this.activePositions[posIndex];
                                    const yieldPercent = (signal.price - entry.entryPrice) / entry.entryPrice;
                                    realPnl = signal.sizeUsd * yieldPercent;
                                    this.addLog('info', `Realized PnL: $${realPnl.toFixed(2)} (${(yieldPercent * 100).toFixed(1)}%)`);
                                    this.activePositions.splice(posIndex, 1);
                                }
                                else {
                                    this.addLog('warn', `Closing tracked position (Entry lost or manual). PnL set to 0.`);
                                    realPnl = 0;
                                }
                            }
                            if (this.callbacks?.onPositionsUpdate)
                                await this.callbacks.onPositionsUpdate(this.activePositions);
                            // Log History (Database)
                            await this.recordTrade({
                                marketId: signal.marketId,
                                outcome: signal.outcome,
                                side: signal.side,
                                price: signal.price,
                                size: signal.sizeUsd,
                                aiReasoning: aiReasoning,
                                riskScore: riskScore,
                                pnl: realPnl,
                                status: signal.side === 'SELL' ? 'CLOSED' : 'OPEN'
                            });
                            // Notify User
                            await notifier.sendTradeAlert(signal);
                            // Distribute Fees on PROFIT ONLY
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
                            // Check for cashout after a profitable trade
                            setTimeout(async () => {
                                const cashout = await fundManager.checkAndSweepProfits();
                                if (cashout && this.callbacks?.onCashout)
                                    await this.callbacks.onCashout(cashout);
                            }, 15000);
                        }
                        catch (err) {
                            this.addLog('error', `Execution Failed: ${err.message}`);
                        }
                    }
                    else {
                        // Log Skipped Trade
                        await this.recordTrade({
                            marketId: signal.marketId,
                            outcome: signal.outcome,
                            side: signal.side,
                            price: signal.price,
                            size: signal.sizeUsd,
                            aiReasoning: aiReasoning,
                            riskScore: riskScore,
                            status: 'SKIPPED'
                        });
                    }
                }
            });
            // Pass the startCursor to monitor to prevent replaying old trades
            await this.monitor.start(this.config.startCursor);
            // Watchdog for Auto-Take Profit
            this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000);
            this.addLog('success', 'Bot Engine Active & Monitoring 24/7');
        }
        catch (e) {
            this.isRunning = false;
            this.addLog('error', `Startup Failed: ${e.message}`);
        }
    }
    async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.client || this.activePositions.length === 0)
            return;
        const positionsToCheck = [...this.activePositions];
        for (const pos of positionsToCheck) {
            try {
                const orderBook = await this.client.getOrderBook(pos.tokenId);
                if (orderBook.bids && orderBook.bids.length > 0) {
                    const bestBid = parseFloat(orderBook.bids[0].price);
                    const gainPercent = ((bestBid - pos.entryPrice) / pos.entryPrice) * 100;
                    if (gainPercent >= this.config.autoTp) {
                        this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} is up +${gainPercent.toFixed(1)}%`);
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
                                aiReasoning: 'Auto Take-Profit Trigger',
                                riskScore: 0,
                                pnl: realPnl,
                                status: 'CLOSED'
                            });
                        }
                    }
                }
            }
            catch (e) { /* silent fail */ }
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
