import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService, ExecutionResult } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { TradeHistoryEntry, ActivePosition, TradeSignal } from '../domain/trade.types.js';
import { CashoutRecord, FeeDistributionEvent, IRegistryService } from '../domain/alpha.types.js';
import { UserStats } from '../domain/user.types.js';
import { TradingWalletConfig, L2ApiCredentials } from '../domain/wallet.types.js'; 
import { BotLog, User, Trade } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { Logger } from '../utils/logger.util.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { EvmWalletService } from '../services/evm-wallet.service.js';
import { TOKENS } from '../config/env.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
import { MarketMakingScanner, MarketOpportunity } from '../services/arbitrage-scanner.js';
import { ArbitrageOpportunity } from '../adapters/interfaces.js';
import { PortfolioTrackerService } from '../services/portfolio-tracker.service.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { AutoCashoutConfig } from '../domain/trade.types.js';
import { MarketIntelligenceService, FlashMoveEvent } from '../services/market-intelligence.service.js';
import { FomoRunnerService, ActiveSnipe } from '../services/fomo-runner.services.js';
import crypto from 'crypto';
import axios from 'axios';


export interface BotConfig {
    userId: string;
    walletConfig?: TradingWalletConfig;
    userAddresses: string[];
    rpcUrl: string;
    geminiApiKey?: string;
    riskProfile: 'conservative' | 'balanced' | 'degen';
    multiplier: number;
    minLiquidityFilter?: 'HIGH' | 'MEDIUM' | 'LOW'; 
    autoTp?: number;
    enableNotifications: boolean;
    userPhoneNumber?: string;
    autoCashout?: AutoCashoutConfig;
    enableAutoCashout?: boolean; 
    maxRetentionAmount?: number; 
    coldWalletAddress?: string; 
    enableCopyTrading: boolean;
    enableMoneyMarkets: boolean;
    enableFomoRunner: boolean;
    enableAutoArb?: boolean;
    activePositions?: ActivePosition[];
    stats?: UserStats;
    l2ApiCredentials?: L2ApiCredentials;
    startCursor?: number;
    builderApiKey?: string;
    builderApiSecret?: string;
    builderApiPassphrase?: string;
    mongoEncryptionKey: string;
    maxTradeAmount?: number;
}

export interface BotCallbacks {
    onCashout?: (record: CashoutRecord) => Promise<void>;
    onFeePaid?: (record: FeeDistributionEvent) => Promise<void>;
    onTradeComplete?: (trade: TradeHistoryEntry) => Promise<void>;
    onStatsUpdate?: (stats: UserStats) => Promise<void>;
    onPositionsUpdate?: (positions: ActivePosition[]) => Promise<void>;
    onArbUpdate?: (opportunities: ArbitrageOpportunity[]) => Promise<void>;
    onFomoVelocity?: (moves: FlashMoveEvent[]) => void;
    onFomoSnipes?: (snipes: ActiveSnipe[]) => void;
}

export class BotEngine {
    public isRunning = false;
    private monitor?: TradeMonitorService;
    private executor?: TradeExecutorService;
    private arbScanner?: MarketMakingScanner;
    private intelligence?: MarketIntelligenceService;
    private fomoRunner?: FomoRunnerService;
    private exchange?: PolymarketAdapter;
    private portfolioService?: PortfolioService;
    private portfolioTracker?: PortfolioTrackerService;
    private positionMonitor?: PositionMonitorService;
    private runtimeEnv: any;
    
    private fundWatcher?: NodeJS.Timeout;
    private activePositions: ActivePosition[] = [];
    private updateLoop: NodeJS.Timeout | null = null;
    private stats: UserStats = {
        totalPnl: 0, 
        totalVolume: 0, 
        totalFeesPaid: 0, 
        winRate: 0, 
        tradesCount: 0, 
        winCount: 0, 
        lossCount: 0, 
        allowanceApproved: false,
        portfolioValue: 0,
        cashBalance: 0
    };

    private lastPositionSync = 0;
    private readonly POSITION_SYNC_INTERVAL = 30000; 
    
    private marketMetadataCache = new Map<string, {
        marketSlug: string;
        eventSlug: string;
        question: string;
        image: string;
        lastUpdated: number;
    }>();
    private readonly MARKET_METADATA_CACHE_TTL = 24 * 60 * 60 * 1000;

    constructor(
        private config: BotConfig,
        private registryService: IRegistryService,
        private callbacks?: BotCallbacks
    ) {
        if (config.activePositions) this.activePositions = config.activePositions;
        if (config.stats) this.stats = config.stats;
    }

    public getAdapter(): PolymarketAdapter | undefined {
        return this.exchange;
    }

    private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string) {
        try {
            const consoleMethod = type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'log';
            console[consoleMethod](`[ENGINE][${this.config.userId.slice(0, 8)}] ${message}`);
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() } as any);
        } catch (e) { console.error("Log failed", e); }
    }

    public updateConfig(newConfig: Partial<BotConfig>) {
        if (newConfig.userAddresses && this.monitor) {
            this.monitor.updateTargets(newConfig.userAddresses);
            this.config.userAddresses = newConfig.userAddresses;
        }

        if (newConfig.enableCopyTrading === false && this.monitor?.isActive()) {
            this.addLog('warn', '⏸️ Copy-Trading Module Standby.');
            this.monitor.stop();
        } else if (newConfig.enableCopyTrading === true && this.monitor && !this.monitor.isActive()) {
            this.addLog('success', '▶️ Copy-Trading Module Online.');
            this.monitor.start(this.config.startCursor || Math.floor(Date.now() / 1000));
        }

        if (newConfig.enableMoneyMarkets === false && this.arbScanner?.isScanning) {
            this.addLog('warn', '⏸️ Money Markets Standby.');
            this.arbScanner.stop(); 
        } else if (newConfig.enableMoneyMarkets === true && this.arbScanner && !this.arbScanner.isScanning) {
            this.addLog('success', '▶️ Money Markets Module Online.');
            this.arbScanner.start();
        }

        if (newConfig.enableFomoRunner !== undefined) {
            this.fomoRunner?.setConfig(newConfig.enableFomoRunner, (newConfig.autoTp || 20) / 100);
            if (newConfig.enableFomoRunner) {
                this.addLog('success', '▶️ FOMO Runner Online.');
            } else {
                this.addLog('warn', '⏸️ FOMO Runner Standby.');
            }
        }

        this.config = { ...this.config, ...newConfig };
    }

    private async fetchMarketMetadata(marketId: string): Promise<{
        marketSlug: string;
        eventSlug: string;
        question: string;
        image: string;
    }> {
        const cached = this.marketMetadataCache.get(marketId);
        if (cached && (Date.now() - cached.lastUpdated) < this.MARKET_METADATA_CACHE_TTL) {
            return {
                marketSlug: cached.marketSlug,
                eventSlug: cached.eventSlug,
                question: cached.question,
                image: cached.image
            };
        }

        try {
            if (this.exchange && 'getMarketData' in this.exchange) {
                const marketData = await (this.exchange as any).getMarketData?.(marketId);
                if (marketData) {
                    const result = {
                        marketSlug: marketData.slug || marketData.marketSlug || '',
                        eventSlug: marketData.eventSlug || '',
                        question: marketData.question || `Market ${marketId}`,
                        image: marketData.image || ''
                    };
                    this.marketMetadataCache.set(marketId, { ...result, lastUpdated: Date.now() });
                    return result;
                }
            }
            
            const trade = await Trade.findOne({ marketId }).sort({ timestamp: -1 });
            if (trade) {
                const result = {
                    marketSlug: (trade as any).marketSlug || '',
                    eventSlug: (trade as any).eventSlug || '',
                    question: (trade as any).marketQuestion || (trade as any).question || `Market ${marketId}`,
                    image: (trade as any).marketImage || (trade as any).image || ''
                };
                this.marketMetadataCache.set(marketId, { ...result, lastUpdated: Date.now() });
                return result;
            }
            
            return {
                marketSlug: marketId.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                eventSlug: 'unknown',
                question: `Market ${marketId}`,
                image: ''
            };
        } catch (error) {
            return {
                marketSlug: marketId.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                eventSlug: 'unknown',
                question: `Market ${marketId}`,
                image: ''
            };
        }
    }

    private async enrichPosition(position: any): Promise<ActivePosition> {
        if (position.tradeId && position.marketSlug && position.eventSlug) {
            return position as ActivePosition;
        }
        
        const { marketSlug, eventSlug, question, image } = await this.fetchMarketMetadata(position.marketId);
        
        return {
            tradeId: position.tradeId || `pos-${position.marketId}-${Date.now()}`,
            clobOrderId: position.clobOrderId || position.tokenId || '',
            marketId: position.marketId,
            conditionId: position.conditionId || position.marketId,
            tokenId: position.tokenId || position.marketId,
            outcome: (position.outcome || 'YES').toUpperCase() as 'YES' | 'NO',
            entryPrice: position.entryPrice || 0.5,
            shares: position.shares || position.balance || 0,
            sizeUsd: position.sizeUsd || position.valueUsd || 0,
            valueUsd: position.valueUsd || 0,
            investedValue: position.investedValue || 0,
            timestamp: position.timestamp || Date.now(),
            currentPrice: position.currentPrice || 0,
            unrealizedPnL: position.unrealizedPnL || 0,
            unrealizedPnLPercent: position.unrealizedPnLPercent || 0,
            question: position.question || question,
            image: position.image || image,
            marketSlug: position.marketSlug || marketSlug,
            eventSlug: position.eventSlug || eventSlug,
            marketState: 'ACTIVE',
            marketAcceptingOrders: true,
            marketActive: true,
            marketClosed: false,
            marketArchived: false,
            pnl: 0,
            pnlPercentage: 0,
            lastUpdated: Date.now(),
            autoCashout: undefined
        };
    }

    private async updateMarketState(position: ActivePosition): Promise<void> {
        if (!this.exchange) return;
        
        try {
            const client = (this.exchange as any).getRawClient?.();
            if (client) {
                const market = await client.getMarket(position.marketId);
                
                if (market) {
                    position.marketClosed = market.closed || false;
                    position.marketActive = market.active || false;
                    position.marketAcceptingOrders = market.accepting_orders || false;
                    position.marketArchived = market.archived || false;
                    
                    if (market.closed) {
                        position.marketState = 'CLOSED';
                    } else if (market.archived) {
                        position.marketState = 'ARCHIVED';
                    } else if (!market.active || !market.accepting_orders) {
                        position.marketState = 'RESOLVED'; 
                    } else {
                        position.marketState = 'ACTIVE';
                    }
                } else {
                    position.marketState = 'RESOLVED';
                    position.marketClosed = true;
                    position.marketActive = false;
                    position.marketAcceptingOrders = false;
                }
            }
        } catch (e: any) {
            if (String(e).includes("404") || String(e).includes("Not Found")) {
                position.marketState = 'RESOLVED';
                position.marketClosed = true;
                position.marketActive = false;
                position.marketAcceptingOrders = false;
            } else {
                this.addLog('warn', `Failed to check market state for ${position.marketId}: ${e.message}`);
            }
        }
    }

    public async syncPositions(forceChainSync = false): Promise<void> {
        if (!this.exchange) return;
        
        const now = Date.now();
        if (!forceChainSync && (now - this.lastPositionSync < this.POSITION_SYNC_INTERVAL)) {
            return;
        }
        
        this.lastPositionSync = now;

        try {
            const funder = this.exchange.getFunderAddress();
            const positions = await this.exchange.getPositions(funder);
            
            const enriched: ActivePosition[] = [];
            for (const p of positions) {
                const pos = await this.enrichPosition(p);
                await this.updateMarketState(pos);
                enriched.push(pos);
            }
            
            this.activePositions = enriched;
            if (this.callbacks?.onPositionsUpdate) {
                await this.callbacks.onPositionsUpdate(enriched);
            }
            await this.syncStats();

        } catch (e: any) {
            this.addLog('error', `Sync Positions Failed: ${e.message}`);
        }
    }

    private getAutoCashoutConfig(): AutoCashoutConfig | undefined {
        if (this.config.autoCashout) return this.config.autoCashout;
        
        const walletAutoCashout = (this.config.walletConfig as any)?.autoCashout as AutoCashoutConfig | undefined;
        if (walletAutoCashout?.enabled && walletAutoCashout.destinationAddress) {
            return {
                enabled: true,
                percentage: walletAutoCashout.percentage || 10,
                destinationAddress: walletAutoCashout.destinationAddress,
                sweepThreshold: walletAutoCashout.sweepThreshold ?? 1000
            };
        }
        return undefined;
    }
    
    private async handleAutoCashout(position: ActivePosition, reason: string) {
        if (!this.executor) return;
        this.addLog('info', `Auto-cashing out position: ${position.marketId} (${position.outcome}) - ${reason}`);
        
        try {
            const cashoutCfg = this.getAutoCashoutConfig();
            if (!cashoutCfg?.enabled) return;
            
            const result = await this.executor.executeManualExit(position, 0); 
            if (result) {
                this.addLog('success', `Successfully executed auto-cashout for position: ${position.marketId}`);
            } else {
                this.addLog('error', `Failed to execute auto-cashout for position: ${position.marketId}`);
            }
        } catch (error) {
            this.addLog('error', `Error in handleAutoCashout: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleInvalidPosition(marketId: string, reason: string): Promise<void> {
        this.addLog('warn', `Position ${marketId} is invalid: ${reason}. Cleaning up...`);
        this.activePositions = this.activePositions.filter(p => p.marketId !== marketId);
        if (this.callbacks?.onPositionsUpdate) {
            await this.callbacks.onPositionsUpdate(this.activePositions);
        }
    }

    public async syncStats(): Promise<void> {
        if (!this.exchange) return;
        try {
            const address = this.exchange.getFunderAddress();
            if(!address) return;
            
            const cashBalance = await this.exchange.fetchBalance(address);
            let positionValue = 0;
            this.activePositions.forEach(p => {
                if (p.shares && p.currentPrice && !isNaN(p.shares * p.currentPrice)) {
                    positionValue += (p.shares * p.currentPrice);
                }
            });

            this.stats.portfolioValue = cashBalance + positionValue;
            this.stats.cashBalance = cashBalance;
            if (this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
        } catch(e) {
            console.error("Sync Stats Error", e);
        }
    }

    public async emergencySell(tradeIdOrMarketId: string, outcome?: string): Promise<string> {
        if (!this.executor) throw new Error("Executor not initialized.");
        
        let positionIndex = this.activePositions.findIndex(p => p.tradeId === tradeIdOrMarketId);
        if (positionIndex === -1 && outcome) {
             positionIndex = this.activePositions.findIndex(p => p.marketId === tradeIdOrMarketId && p.outcome === outcome);
        }

        if (positionIndex === -1) throw new Error("Position not found in active database.");

        const position = this.activePositions[positionIndex];
        this.addLog('warn', `Executing Market Exit: Offloading ${position.shares} shares...`);

        try {
            const currentPrice = await this.exchange?.getMarketPrice(position.marketId, position.tokenId, 'SELL') || 0.5;
            const success = await this.executor.executeManualExit(position, currentPrice);
            
            if (success) {
                const exitValue = position.shares * currentPrice;
                const costBasis = position.investedValue || (position.shares * position.entryPrice);
                const realizedPnl = exitValue - costBasis;

                if (this.callbacks?.onTradeComplete) {
                    await this.callbacks.onTradeComplete({
                        id: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        marketId: position.marketId,
                        outcome: position.outcome,
                        side: 'SELL',
                        size: costBasis, 
                        executedSize: exitValue, 
                        price: currentPrice,
                        pnl: realizedPnl,
                        status: 'CLOSED',
                        aiReasoning: 'Manual Exit',
                        riskScore: 0,
                        clobOrderId: position.clobOrderId,
                        marketSlug: position.marketSlug,
                        eventSlug: position.eventSlug
                    });
                }

                if (position.tradeId && !position.tradeId.startsWith('imported')) {
                    await Trade.findByIdAndUpdate(position.tradeId, {
                        status: 'CLOSED',
                        pnl: realizedPnl,
                        executedSize: exitValue
                    });
                }

                this.activePositions.splice(positionIndex, 1);
                if (this.callbacks?.onPositionsUpdate) await this.callbacks.onPositionsUpdate(this.activePositions);
                this.addLog('success', `Exit summary: Liquidated ${position.shares.toFixed(2)} shares @ $${currentPrice.toFixed(3)}`);
                setTimeout(() => this.syncStats(), 2000);
                return "sold";
            } else {
                throw new Error("Execution failed at adapter level");
            }
        } catch (e: any) {
            this.addLog('error', `Manual Exit Failed: ${e.message}`);
            throw e;
        }
    }

    private async initializeServices() {
        if (!this.exchange) throw new Error('Exchange not initialized');

        const logger = {
            info: (m: string) => this.addLog('info', m),
            warn: (m: string) => this.addLog('warn', m),
            error: (m: string, e?: any) => this.addLog('error', `${m} ${e ? e.message : ''}`),
            debug: () => {},
            success: (m: string) => this.addLog('success', m)
        };

        const funder = this.exchange.getFunderAddress();

        this.positionMonitor = new PositionMonitorService(
            this.exchange,
            funder,
            { checkInterval: 30000, priceCheckInterval: 60000, orderBookValidationInterval: 3600000 },
            logger,
            this.handleAutoCashout.bind(this),
            this.handleInvalidPosition.bind(this)
        );

        this.portfolioTracker = new PortfolioTrackerService(
            this.exchange,
            funder,
            (this.config.maxTradeAmount || 1000) * 10, 
            logger,
            this.positionMonitor, 
            (positions) => {
                this.activePositions = positions;
                return this.callbacks?.onPositionsUpdate?.(positions) || Promise.resolve();
            }
        );

        await this.portfolioTracker.initialize();
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const engineLogger: Logger = {
            info: (m) => this.addLog('info', m),
            warn: (m) => this.addLog('warn', m),
            error: (m, e) => this.addLog('error', `${m} ${e?.message || ''}`),
            debug: () => {},
            success: (m) => this.addLog('success', m)
        };

        try {
            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig!,
                userId: this.config.userId,
                mongoEncryptionKey: this.config.mongoEncryptionKey,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase
            }, engineLogger);
            
            await this.exchange.initialize();
            await this.exchange.authenticate();

            this.intelligence = new MarketIntelligenceService(engineLogger);
            this.executor = new TradeExecutorService({
                adapter: this.exchange,
                proxyWallet: this.exchange.getFunderAddress(),
                env: { tradeMultiplier: this.config.multiplier, maxTradeAmount: this.config.maxTradeAmount || 100 } as any,
                logger: engineLogger
            });

            this.fomoRunner = new FomoRunnerService(this.intelligence, this.executor, this.exchange, engineLogger);
            this.fomoRunner.setConfig(this.config.enableFomoRunner, 0.20);

            // Forward trade events from the sniper to your database handler
            this.fomoRunner.on('fomo_trade_filled', (trade: TradeHistoryEntry) => 
                this.callbacks?.onTradeComplete?.(trade)
            );

            await this.syncPositions(true);
            await this.intelligence.start();
            
            // Start the internal sync loop for hooks (no io used)
            this.startFomoSync();
            
            this.addLog('success', 'Bot Engine Activated.');
        } catch (e: any) {
            this.addLog('error', `Startup failed: ${e.message}`);
            this.isRunning = false;
        }
    }

    private startFomoSync() {
        // Clear any existing interval
        if (this.updateLoop) {
            clearInterval(this.updateLoop);
            this.updateLoop = null;
        }
        
        // Set up new interval
        this.updateLoop = setInterval(() => {
            if (!this.isRunning) return;
            
            // Fire the hooks to the server listener
            if (this.intelligence && this.callbacks?.onFomoVelocity) {
                this.callbacks.onFomoVelocity(this.intelligence.getLatestMoves());
            }

            if (this.fomoRunner && this.callbacks?.onFomoSnipes) {
                this.callbacks.onFomoSnipes(this.fomoRunner.getActiveSnipes());
            }
        }, 2000);
    }

    public stop() {
        this.isRunning = false;
        this.arbScanner?.stop();
        this.intelligence?.stop();
        this.fomoRunner?.setConfig(false, 0.2);
        if (this.monitor) this.monitor.stop();
        if (this.portfolioService) this.portfolioService.stopSnapshotService();
        if (this.fundWatcher) {
            clearInterval(this.fundWatcher);
            this.fundWatcher = undefined;
        }
        this.addLog('warn', 'Engine Stopped.');
    }

    private async initializeCoreModules(logger: Logger) {
        if(!this.exchange) return;
        const funder = this.exchange.getFunderAddress();

        if (!this.positionMonitor) {
            this.positionMonitor = new PositionMonitorService(
                this.exchange,
                funder,
                { checkInterval: 30000, priceCheckInterval: 60000 },
                logger,
                this.handleAutoCashout.bind(this),
                this.handleInvalidPosition.bind(this)
            );
        }

        if (!this.portfolioTracker) {
            this.portfolioTracker = new PortfolioTrackerService(
                this.exchange,
                funder,
                (this.config.maxTradeAmount || 1000) * 10, 
                logger,
                this.positionMonitor,
                (positions) => {
                    this.activePositions = positions;
                    if (this.callbacks?.onPositionsUpdate) this.callbacks.onPositionsUpdate(positions);
                }
            );
        }

        this.runtimeEnv = { 
            tradeMultiplier: this.config.multiplier, 
            maxTradeAmount: this.config.maxTradeAmount || 100,
            usdcContractAddress: TOKENS.USDC_BRIDGED,
            minLiquidityFilter: this.config.minLiquidityFilter || 'LOW'
        };

        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            env: this.runtimeEnv,
            logger: logger,
            userAddresses: this.config.userAddresses,
            onDetectedTrade: async (signal: TradeSignal) => {
                if (!this.isRunning) return;

                const isManagedByMM = this.arbScanner?.getOpportunities().some(o => o.tokenId === signal.tokenId);
                if (isManagedByMM && (this.config.enableAutoArb || this.config.enableMoneyMarkets)) {
                    this.addLog('info', `🛡️ Signal Skipped: Market ${signal.marketId.slice(0,8)} is managed by MM Strategy.`);
                    return;
                }

                if (signal.side === 'SELL') {
                    const hasPosition = this.activePositions.some(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                    if (!hasPosition) return; 
                }

                const aiResult = await aiAgent.analyzeTrade(signal.marketId, signal.side, signal.outcome, signal.sizeUsd, signal.price, this.config.riskProfile);

                if (!aiResult.shouldCopy) {
                    this.addLog('info', `AI Skipped: ${aiResult.reasoning} (Score: ${aiResult.riskScore})`);
                    if (this.callbacks?.onTradeComplete) {
                        await this.callbacks.onTradeComplete({
                            id: crypto.randomUUID(),
                            timestamp: new Date().toISOString(),
                            marketId: signal.marketId,
                            outcome: signal.outcome,
                            side: signal.side,
                            size: signal.sizeUsd,
                            executedSize: 0,
                            price: signal.price,
                            status: 'SKIPPED',
                            aiReasoning: aiResult.reasoning,
                            riskScore: aiResult.riskScore
                        });
                    }
                    return;
                }

                if (this.executor) {
                    const result: ExecutionResult = await this.executor.copyTrade(signal);
                    if (result.status === 'FILLED') {
                        this.addLog('success', `Trade Executed! Size: $${result.executedAmount.toFixed(2)}`);
                        await this.syncPositions(true);
                        await this.syncStats();
                    }
                }
            }
        });
    }

    public async dispatchManualMM(marketId: string): Promise<boolean> {
        if (!this.executor) return false;
        const target = this.arbScanner?.getTrackedMarket(marketId);
        if (target) {
            await this.executor.executeMarketMakingQuotes(target as any);
            return true;
        }
        return false;
    }

    private async checkFunding(): Promise<boolean> {
        try {
            if(!this.exchange) return false;
            const funderAddr = this.exchange.getFunderAddress();
            const balanceUSDC = await this.exchange.fetchBalance(funderAddr);
            return balanceUSDC >= 1.0 || this.activePositions.length > 0;
        } catch (e) { return false; }
    }

    private startFundWatcher() {
        if (this.fundWatcher) clearInterval(this.fundWatcher);
        this.fundWatcher = setInterval(async () => {
            if (!this.isRunning) return;
            const funded = await this.checkFunding();
            if (funded) {
                clearInterval(this.fundWatcher);
                this.fundWatcher = undefined;
                await this.proceedWithPostFundingSetup({ info: console.log, warn: console.warn, error: console.error, debug: () => {}, success: console.log } as any);
            }
        }, 15000) as unknown as NodeJS.Timeout; 
    }

    private async proceedWithPostFundingSetup(logger: Logger) {
        try {
            this.portfolioService = new PortfolioService(logger);
            this.portfolioService.startSnapshotService(this.config.userId, async () => ({
                totalValue: this.stats.portfolioValue || 0,
                cashBalance: this.stats.cashBalance || 0,
                positions: this.activePositions,
                totalPnL: this.stats.totalPnl || 0
            }));

            if (this.intelligence) await this.intelligence.start();
            if (this.config.enableMoneyMarkets && this.arbScanner) await this.arbScanner.start();
            if (this.config.enableFomoRunner && this.fomoRunner) this.fomoRunner.setConfig(true, (this.config.autoTp || 20) / 100);
            
            // Fomo Runner service start

            if (this.config.enableCopyTrading && this.monitor) await this.monitor.start();

            await this.syncPositions(true); 
            await this.syncStats();
            this.addLog('success', 'Bot Modules Activated.');
        } catch (e: any) {
            this.addLog('error', `Setup Failed: ${e.message}`);
        }
    }

    public getActiveFomoMoves() {
        return this.intelligence?.getLatestMoves() || [];
    }

    public getActiveSnipes() {
        return this.fomoRunner?.getActiveSnipes() || [];
    }
    
    public getActivePositions(): ActivePosition[] { return this.activePositions; }
    public getArbOpportunities(): ArbitrageOpportunity[] { return this.arbScanner?.getOpportunities() || []; }
    public getActiveFomoChases(): any[] { return this.fomoRunner ? [] : []; }
    public getCallbacks(): BotCallbacks | undefined { return this.callbacks; }

    public async addMarketToMM(conditionId: string): Promise<boolean> { return this.arbScanner?.addMarketByConditionId(conditionId) || false; }
    public async addMarketBySlug(slug: string): Promise<boolean> { return this.arbScanner?.addMarketBySlug(slug) || false; }
    public bookmarkMarket(conditionId: string): void { this.arbScanner?.bookmarkMarket(conditionId); }
    public unbookmarkMarket(conditionId: string): void { this.arbScanner?.unbookmarkMarket(conditionId); }
    public getBookmarkedOpportunities(): ArbitrageOpportunity[] { return this.arbScanner?.getBookmarkedOpportunities() || []; }
}