import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ZeroDevService } from '../services/zerodev.service.js';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { Wallet, AbstractSigner, JsonRpcProvider } from 'ethers';
import { BotLog } from '../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
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
        // Log initial wakeup
        this.addLog('info', 'Bot Engine Initialized');
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
                usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            };
            // --- ACCOUNT STRATEGY SELECTION ---
            let signerImpl;
            let walletAddress;
            let clobCreds = undefined;
            // 1. Smart Account Strategy
            if (this.config.walletConfig?.type === 'SMART_ACCOUNT' && this.config.walletConfig.serializedSessionKey) {
                await this.addLog('info', '🔐 Initializing ZeroDev Smart Account Session...');
                const aaService = new ZeroDevService(this.config.zeroDevRpc || 'https://rpc.zerodev.app/api/v2/bundler/DEFAULT');
                const { address, client: kernelClient } = await aaService.createBotClient(this.config.walletConfig.serializedSessionKey);
                walletAddress = address;
                await this.addLog('success', `Smart Account Active: ${walletAddress.slice(0, 6)}... (Session Key)`);
                const provider = new JsonRpcProvider(this.config.rpcUrl);
                signerImpl = new KernelEthersSigner(kernelClient, address, provider);
                clobCreds = undefined;
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
                    await this.addLog('info', '⚡ API Keys Loaded (High Performance Mode)');
                    clobCreds = {
                        key: this.config.polymarketApiKey,
                        secret: this.config.polymarketApiSecret,
                        passphrase: this.config.polymarketApiPassphrase
                    };
                }
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
                await this.addLog('info', '👷 Builder Program Attribution Active (Stamping Trades)');
            }
            // Initialize Polymarket Client with Builder Attribution
            const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, signerImpl, clobCreds, undefined, // signatureType
            undefined, // funderAddress
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
            await this.addLog('info', 'Checking Token Allowances...');
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
                        await this.addLog('info', '🤖 AI Analyzing signal...');
                        const analysis = await aiAgent.analyzeTrade(`Market: ${signal.marketId}`, signal.side, signal.outcome, signal.sizeUsd, signal.price, this.config.geminiApiKey, this.config.riskProfile);
                        shouldExecute = analysis.shouldCopy;
                        aiReasoning = analysis.reasoning;
                        riskScore = analysis.riskScore;
                    }
                    if (shouldExecute) {
                        await this.addLog('info', `Executing Copy: ${signal.side} ${signal.outcome}`);
                        try {
                            let executedSize = 0;
                            if (this.executor) {
                                executedSize = await this.executor.copyTrade(signal);
                            }
                            await this.addLog('success', `Trade Executed Successfully!`);
                            let realPnl = 0;
                            if (signal.side === 'BUY') {
                                const newPosition = {
                                    marketId: signal.marketId,
                                    tokenId: signal.tokenId,
                                    outcome: signal.outcome,
                                    entryPrice: signal.price,
                                    sizeUsd: executedSize, // Track executed size for PnL
                                    timestamp: Date.now()
                                };
                                this.activePositions.push(newPosition);
                            }
                            else if (signal.side === 'SELL') {
                                const posIndex = this.activePositions.findIndex(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                                if (posIndex !== -1) {
                                    const entry = this.activePositions[posIndex];
                                    const yieldPercent = (signal.price - entry.entryPrice) / entry.entryPrice;
                                    realPnl = entry.sizeUsd * yieldPercent; // Calculate PnL on actual size
                                    await this.addLog('info', `Realized PnL: $${realPnl.toFixed(2)} (${(yieldPercent * 100).toFixed(1)}%)`);
                                    this.activePositions.splice(posIndex, 1);
                                }
                                else {
                                    await this.addLog('warn', `Closing tracked position (Entry lost or manual). PnL set to 0.`);
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
                                size: signal.sizeUsd, // Whale Size
                                executedSize: executedSize, // Bot Size
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
                            await this.addLog('error', `Execution Failed: ${err.message}`);
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
                            executedSize: 0,
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
            await this.addLog('success', 'Bot Engine Active & Monitoring 24/7');
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
            catch (e) { /* silent fail */ }
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
            this.stats.totalVolume = (this.stats.totalVolume || 0) + data.executedSize; // Update stats with REAL volume
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
