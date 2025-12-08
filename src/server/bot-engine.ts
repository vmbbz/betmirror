
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService, FundManagerConfig } from '../services/fund-manager.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { TradeHistoryEntry, ActivePosition } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { ProxyWalletConfig, L2ApiCredentials } from '../domain/wallet.types.js'; 
import { BotLog, User } from '../database/index.js';
import { getMarket } from '../utils/fetch-data.util.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { Logger } from '../utils/logger.util.js';

// Define the correct USDC.e address on Polygon
const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export interface BotConfig {
    userId: string;
    privateKey?: string;
    walletConfig?: ProxyWalletConfig;
    userAddresses: string[];
    rpcUrl: string;
    geminiApiKey?: string;
    riskProfile: 'conservative' | 'balanced' | 'degen';
    multiplier: number;
    autoTp?: number;
    enableNotifications: boolean;
    userPhoneNumber?: string;
    autoCashout?: { enabled: boolean; maxAmount: number; destinationAddress: string; };
    activePositions?: ActivePosition[];
    stats?: UserStats;
    zeroDevRpc?: string;
    zeroDevPaymasterRpc?: string;
    l2ApiCredentials?: L2ApiCredentials;
    startCursor?: number;
    builderApiKey?: string;
    builderApiSecret?: string;
    builderApiPassphrase?: string;
}

export interface BotCallbacks {
    onCashout?: (record: CashoutRecord) => Promise<void>;
    onFeePaid?: (record: FeeDistributionEvent) => Promise<void>;
    onTradeComplete?: (trade: TradeHistoryEntry) => Promise<void>;
    onStatsUpdate?: (stats: UserStats) => Promise<void>;
    onPositionsUpdate?: (positions: ActivePosition[]) => Promise<void>;
}

export class BotEngine {
    public isRunning = false;
    private monitor?: TradeMonitorService;
    private executor?: TradeExecutorService;
    private exchange?: PolymarketAdapter;
    
    private fundWatcher?: NodeJS.Timeout;
    private watchdogTimer?: NodeJS.Timeout;
    private activePositions: ActivePosition[] = [];
    private stats: UserStats = {
        totalPnl: 0, totalVolume: 0, totalFeesPaid: 0, winRate: 0, tradesCount: 0, allowanceApproved: false
    };

    constructor(
        private config: BotConfig,
        private registryService: IRegistryService,
        private callbacks?: BotCallbacks
    ) {
        if (config.activePositions) this.activePositions = config.activePositions;
        if (config.stats) this.stats = config.stats;
    }

    private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string) {
        try {
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() });
        } catch (e) { console.error("Log failed", e); }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            await this.addLog('info', '🚀 Starting Engine...');

            // --- STEP 1: INITIALIZE ADAPTER ---
            const engineLogger: Logger = {
                info: (m: string) => console.log(m),
                warn: (m: string) => console.warn(m),
                error: (m: string, e?: any) => console.error(m, e),
                debug: () => {},
                success: (m: string) => console.log(`✅ ${m}`)
            };

            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig!,
                userId: this.config.userId,
                l2ApiCredentials: this.config.l2ApiCredentials,
                zeroDevRpc: this.config.zeroDevRpc,
                zeroDevPaymasterRpc: this.config.zeroDevPaymasterRpc,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase
            }, engineLogger);

            await this.exchange.initialize();

            // --- STEP 2: CHECK FUNDING (Non-Blocking) ---
            const isFunded = await this.checkFunding();
            
            if (!isFunded) {
                await this.addLog('warn', '💰 Account Empty (Checking USDC.e). Engine standby. Waiting for deposit...');
                this.startFundWatcher();
                return; 
            }

            await this.proceedWithPostFundingSetup();

        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Startup Failed: ${e.message}`);
            this.isRunning = false;
        }
    }

    private async checkFunding(): Promise<boolean> {
        try {
            if(!this.exchange) return false;
            // Use Adapter to check balance
            const funderAddr = this.exchange.getFunderAddress();
            if (!funderAddr) return false;
            const balance = await this.exchange.fetchBalance(funderAddr);
            console.log(`💰 Funding Check for ${funderAddr}: ${balance}`);
            return balance >= 0.01; 
        } catch (e) {
            return false;
        }
    }

    private startFundWatcher() {
        if (this.fundWatcher) clearInterval(this.fundWatcher);
        this.fundWatcher = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(this.fundWatcher);
                return;
            }
            const funded = await this.checkFunding();
            if (funded) {
                clearInterval(this.fundWatcher);
                this.fundWatcher = undefined;
                await this.addLog('success', '💰 Funds detected. Resuming startup...');
                await this.proceedWithPostFundingSetup();
            }
        }, 30000); 
    }

    private async proceedWithPostFundingSetup() {
        try {
            if(!this.exchange) return;

            // 1. Ensure Deployed
            await this.exchange.validatePermissions();

            // 2. Authenticate (Handshake)
            await this.exchange.authenticate();

            // 3. Start Services
            this.startServices();

        } catch (e: any) {
            console.error(e);
            await this.addLog('error', `Setup Failed: ${e.message}`);
            this.isRunning = false; 
        }
    }

    private async startServices() {
        if(!this.exchange) return;

        const runtimeEnv: any = {
            tradeMultiplier: this.config.multiplier,
            usdcContractAddress: USDC_BRIDGED_POLYGON,
            adminRevenueWallet: process.env.ADMIN_REVENUE_WALLET,
            enableNotifications: this.config.enableNotifications,
            userPhoneNumber: this.config.userPhoneNumber,
            twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
            twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
            twilioFromNumber: process.env.TWILIO_FROM_NUMBER
        };
        
        const serviceLogger: Logger = {
            info: (m: string) => console.log(m),
            warn: (m: string) => console.warn(m),
            error: (m: string, e?: any) => console.error(m, e),
            debug: () => {},
            success: (m: string) => console.log(`✅ ${m}`)
        };

        // EXECUTOR - Uses Adapter
        const signer = this.exchange.getSigner(); 
        const funder = this.exchange.getFunderAddress();

        if (!signer || !funder) {
            throw new Error("Adapter initialization incomplete. Missing client components.");
        }

        this.executor = new TradeExecutorService({
            adapter: this.exchange,
            proxyWallet: funder,
            env: runtimeEnv,
            logger: serviceLogger
        });

        this.stats.allowanceApproved = true; 

        // FUND MANAGER - Uses generic signer for now
        const fundManager = new FundManagerService(
            signer, 
            {
                enabled: this.config.autoCashout?.enabled || false,
                maxRetentionAmount: this.config.autoCashout?.maxAmount,
                destinationAddress: this.config.autoCashout?.destinationAddress,
                usdcContractAddress: USDC_BRIDGED_POLYGON
            },
            serviceLogger,
            new NotificationService(runtimeEnv, serviceLogger)
        );

        try {
            const cashout = await fundManager.checkAndSweepProfits();
            if (cashout && this.callbacks?.onCashout) await this.callbacks.onCashout(cashout);
        } catch(e) {}

        // MONITOR - Uses Adapter
        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            env: { ...runtimeEnv, fetchIntervalSeconds: 2, aggregationWindowSeconds: 300 },
            logger: serviceLogger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal) => {
                if (!this.isRunning) return;
                
                const geminiKey = this.config.geminiApiKey || process.env.GEMINI_API_KEY;
                let shouldTrade = true;
                let reason = "AI Disabled";
                let score = 0;

                if (geminiKey) {
                    await this.addLog('info', `[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price}`);
                    const analysis = await aiAgent.analyzeTrade(
                        `Market: ${signal.marketId}`,
                        signal.side,
                        signal.outcome,
                        signal.sizeUsd,
                        signal.price,
                        this.config.riskProfile,
                        geminiKey
                    );
                    shouldTrade = analysis.shouldCopy;
                    reason = analysis.reasoning;
                    score = analysis.riskScore;
                }

                if (shouldTrade && this.executor) {
                    await this.addLog('info', `⚡ Executing ${signal.side}...`);
                    const size = await this.executor.copyTrade(signal);
                    if (size > 0) {
                        await this.addLog('success', `✅ Executed ${signal.marketId.slice(0,6)}...`);
                        
                        if (signal.side === 'BUY') {
                            this.activePositions.push({
                                marketId: signal.marketId,
                                tokenId: signal.tokenId,
                                outcome: signal.outcome,
                                entryPrice: signal.price,
                                sizeUsd: size,
                                timestamp: Date.now()
                            });
                        }
                        
                        this.stats.tradesCount = (this.stats.tradesCount || 0) + 1;
                        this.stats.totalVolume = (this.stats.totalVolume || 0) + size;

                        if (this.callbacks?.onTradeComplete) {
                            await this.callbacks.onTradeComplete({
                                id: Math.random().toString(36),
                                timestamp: new Date().toISOString(),
                                marketId: signal.marketId,
                                outcome: signal.outcome,
                                side: signal.side,
                                size: signal.sizeUsd,
                                executedSize: size,
                                price: signal.price,
                                status: 'CLOSED',
                                aiReasoning: reason,
                                riskScore: score
                            });
                        }
                        if(this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
                    }
                }
            }
        });

        await this.monitor.start(this.config.startCursor);
        this.watchdogTimer = setInterval(() => this.checkAutoTp(), 10000) as unknown as NodeJS.Timeout;

        await this.addLog('success', '🟢 Engine Online. Watching markets...');
    }

    private async checkAutoTp() {
        if (!this.config.autoTp || !this.executor || !this.exchange || this.activePositions.length === 0) return;
        
        const positionsToCheck = [...this.activePositions];
        
        for (const pos of positionsToCheck) {
            try {
                try {
                    const market = await getMarket(pos.marketId);
                    if ((market as any).closed || (market as any).active === false) {
                        this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                        if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                        continue;
                    }
                } catch (e) { continue; }
  
                // Use Adapter to get Orderbook for price check
                const orderBook = await this.exchange.getOrderBook(pos.tokenId);
                if (orderBook.bids && orderBook.bids.length > 0) {
                    const bestBid = orderBook.bids[0].price;
                    const gainPercent = ((bestBid - pos.entryPrice) / pos.entryPrice) * 100;
                    
                    if (gainPercent >= this.config.autoTp) {
                        await this.addLog('success', `🎯 Auto TP Hit! ${pos.outcome} is up +${gainPercent.toFixed(1)}%`);
                        const success = await this.executor.executeManualExit(pos, bestBid);
                        if (success) {
                            this.activePositions = this.activePositions.filter(p => p.tokenId !== pos.tokenId);
                            if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                            
                            const realPnl = pos.sizeUsd * (gainPercent / 100);
                            this.stats.totalPnl = (this.stats.totalPnl || 0) + realPnl;
                            if(this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
                        }
                    }
                }
            } catch (e: any) { 
                 // Ignore
            }
        }
    }

    public stop() {
        this.isRunning = false;
        if (this.monitor) this.monitor.stop();
        if (this.fundWatcher) clearInterval(this.fundWatcher);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.addLog('info', '🔴 Engine Stopped.');
    }
}
