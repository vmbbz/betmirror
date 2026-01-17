import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.util.js';
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { BotLog, Trade, User } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { MarketMakingScanner } from '../services/arbitrage-scanner.js';
import { PortfolioTrackerService } from '../services/portfolio-tracker.service.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { WebSocketManager } from '../services/websocket-manager.service.js';
import { FlashMoveService } from '../services/flash-move.service.js';
import { MarketMetadataService } from '../services/market-metadata.service.js';
import { DEFAULT_FLASH_MOVE_CONFIG } from '../config/flash-move.config.js';
import { MarketIntelligenceService } from '../services/market-intelligence.service.js';
import crypto from 'crypto';

export interface BotConfig {
    userId: string;
    walletConfig: any;
    userAddresses: string[];
    rpcUrl?: string;
    geminiApiKey?: string;
    multiplier: number;
    riskProfile: string;
    enableNotifications: boolean;
    enableCopyTrading: boolean;
    enableMoneyMarkets: boolean;
    enableFomoRunner: boolean;
    maxTradeAmount: number;
    mongoEncryptionKey: string;
    l2ApiCredentials?: any;
    builderApiKey?: string;
    builderApiSecret?: string;
    builderApiPassphrase?: string;
    autoTp?: number;
    autoCashout?: boolean;
    userPhoneNumber?: string;
    targets?: string[];
    activePositions?: any[];
}

export interface BotEngineCallbacks {
    onFlashMoves?: (moves: any[]) => void;
    onPositionsUpdate?: (positions: any[]) => Promise<void>;
    onTradeComplete?: (trade: any) => Promise<void>;
    onStatsUpdate?: (stats: any) => Promise<void>;
    onLog?: (log: any) => void;
    onFeePaid?: (event: any) => Promise<void>;
}

export class BotEngine extends EventEmitter {
    private config: BotConfig;
    private intelligence: MarketIntelligenceService;
    private registryService: any;
    private callbacks: BotEngineCallbacks;
    public isRunning = false;
    private monitor: TradeMonitorService;
    private executor: TradeExecutorService;
    private arbScanner: MarketMakingScanner;
    private exchange: PolymarketAdapter;
    private portfolioService: PortfolioService;
    private portfolioTracker: PortfolioTrackerService;
    private positionMonitor: PositionMonitorService;
    private fundWatcher: any; 
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private activePositions: any[] = [];
    private stats = {
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
    private lastKnownBalance = 0;
    private readonly POSITION_SYNC_INTERVAL = 300000; // 5 minute standard cycle
    private marketMetadataCache = new Map(); 
    private readonly MARKET_METADATA_CACHE_TTL = 24 * 60 * 60 * 1000;
    
    // Flash Move Integration
    private flashMoveService: FlashMoveService;
    private privateWsManager: WebSocketManager; // Private WS for fills only
    private marketMetadataService: MarketMetadataService;
    private logger: Logger;

    constructor(config: any, intelligence: MarketIntelligenceService, registryService: any, callbacks: BotEngineCallbacks = {}) {
        super();
        this.config = config;
        this.intelligence = intelligence;
        this.registryService = registryService;
        this.callbacks = callbacks;
        
        // --- SCOPED LOGGER FACTORY ---
        // Every log from this bot's sub-services will pipe to DB and Socket simultaneously
        this.logger = {
            info: (m) => this.addLog('info', m),
            warn: (m) => this.addLog('warn', m),
            error: (m, e) => this.addLog('error', `${m} ${e?.message || ''}`),
            debug: (m) => console.debug(`[Bot ${config.userId.slice(0,6)}] ${m}`),
            success: (m) => this.addLog('success', m)
        };
        
        this.exchange = new PolymarketAdapter({
            ...config,
            rpcUrl: config.rpcUrl || 'https://polygon-rpc.com'
        }, this.logger);
        
        // PRIVATE WebSocket for this specific user (Fills/Auth channel only)
        this.privateWsManager = new WebSocketManager(this.logger, this.exchange);
        
        this.marketMetadataService = new MarketMetadataService(this.exchange, this.logger);
        
        this.executor = new TradeExecutorService({
            adapter: this.exchange,
            env: {} as any,
            logger: this.logger,
            proxyWallet: config.walletConfig?.address || '',
            wsManager: this.privateWsManager
        });
        
        this.flashMoveService = new FlashMoveService(
            this.intelligence,
            DEFAULT_FLASH_MOVE_CONFIG,
            this.executor,
            this.logger
        );
        
        this.portfolioService = new PortfolioService(this.logger);
        
        this.positionMonitor = new PositionMonitorService(
            this.exchange,
            config.userId || '',
            { checkInterval: 30000, priceCheckInterval: 10000 },
            this.logger,
            async (position, reason) => {
                this.logger.info(`[Bot] Auto-cashout triggered: ${position.marketId} - ${reason}`);
            }
        );
        
        this.portfolioTracker = new PortfolioTrackerService(
            this.exchange,
            config.userId || '',
            10000,
            this.logger,
            this.positionMonitor,
            this.marketMetadataService,
            async (positions) => {
                this.activePositions = positions;
                if (this.callbacks.onPositionsUpdate) await this.callbacks.onPositionsUpdate(positions);
            }
        );
        
        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            intelligence: this.intelligence,
            env: {} as any,
            logger: this.logger,
            userAddresses: config.userAddresses || [],
            onDetectedTrade: async (signal) => {
                if (this.isRunning && this.config.enableCopyTrading) {
                    this.logger.info(`🔄 Mirror Trade Signal: ${signal.side} ${signal.tokenId} @ ${signal.price}`);
                    try {
                        const res = await this.executor.copyTrade(signal);
                        if (res.status === 'FILLED' && this.callbacks.onTradeComplete) {
                            await this.callbacks.onTradeComplete({ ...signal, id: res.txHash, status: 'OPEN', serviceOrigin: 'COPY' });
                        }
                    } catch (error) {
                        this.logger.error(`❌ Mirror trade execution failed: ${error}`);
                    }
                }
            }
        });
        
        this.arbScanner = new MarketMakingScanner(
            this.exchange,
            this.logger,
            {
                minSpreadCents: 1,
                maxSpreadCents: 15,
                minVolume: 5000,
                minLiquidity: 1000,
                refreshIntervalMs: 300000,
                priceMoveThresholdPct: 5,
                maxInventoryPerToken: 500,
                autoMergeThreshold: 100,
                enableKillSwitch: true,
                preferRewardMarkets: true,
                preferNewMarkets: true,
                newMarketAgeMinutes: 60
            }
        );
        
        // Connect scanner to global intelligence feed
        this.arbScanner.setWebSocketManager(this.intelligence.wsManager!);

                // --- ARBITRAGE / MM EXECUTION LOOP ---
        this.arbScanner.on('opportunity', async (opp) => {
            if (this.isRunning && this.config.enableMoneyMarkets) {
                // Throttle: Don't execute MM quotes if we just placed one for this token in last 5s
                // (Logic handled inside executor for state persistence)
                await this.executor.executeMarketMakingQuotes(opp);
            }
        });
        
        if (config.activePositions) this.activePositions = config.activePositions;
        if (config.userAddresses) this.monitor.updateTargets(config.userAddresses);
        
        // --- FOMO RUNNER INTERNAL ROUTING ---
        this.flashMoveService.on('flash_move_executed', async (data) => {
            this.logger.success(`🔥 FOMO EXECUTED: ${data.event.question}`);
            if (this.callbacks.onTradeComplete) {
                await this.callbacks.onTradeComplete({
                    id: data.result.orderId,
                    marketId: data.event.conditionId,
                    outcome: data.event.velocity > 0 ? 'YES' : 'NO',
                    side: data.event.velocity > 0 ? 'BUY' : 'SELL',
                    price: data.result.priceFilled,
                    executedSize: data.result.sharesFilled,
                    serviceOrigin: 'FOMO',
                    timestamp: new Date(),
                    status: 'OPEN'
                });
            }
        });

        this.logger.info('🚀 Execution Core Online.');
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        
        try {
            this.addLog('info', 'Connecting to Polymarket CLOB...');
            await this.exchange.initialize();
            await this.exchange.authenticate();
            await this.privateWsManager.start();
            await this.executor.start();
            await this.portfolioTracker.syncPositions(true);
            
            if (this.config.enableCopyTrading) await this.monitor.start();
            if (this.config.enableMoneyMarkets) await this.arbScanner.start();
            if (this.config.enableFomoRunner) this.flashMoveService.setEnabled(true);

            this.logger.success(`✅ Bot online for user ${this.config.userId}`);
            this.emit('started');
            
        } catch (error) {
            this.logger.error(`❌ Startup sequence failed: ${error}`);
            this.isRunning = false;
        }
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) return;
        this.isRunning = false;
        try {
            await this.monitor.stop();
            await this.arbScanner.stop();
            await this.executor.stop();
            await this.privateWsManager.stop();
            this.flashMoveService.setEnabled(false);
            this.logger.warn(`🛑 Bot engine paused.`);
            this.emit('stopped');
        } catch (error) {
            this.logger.error(`❌ Shutdown error: ${error}`);
        }
    }

    /**
     * Runtime Service Toggle - Enables or disables strategy modules dynamically
     */
    public async toggleService(service: string, enabled: boolean): Promise<{ success: boolean; message: string }> {
        try {
            this.logger.info(`⚙️ Toggling service ${service} to ${enabled}`);
            switch (service.toLowerCase()) {
                case 'copytrading':
                    this.config.enableCopyTrading = enabled;
                    if (enabled) await this.monitor.start();
                    else await this.monitor.stop();
                    break;
                case 'moneymarkets':
                case 'arbitrage':
                    this.config.enableMoneyMarkets = enabled;
                    if (enabled) await this.arbScanner.start();
                    else await this.arbScanner.stop();
                    break;
                case 'flashmoves':
                case 'fomorunner':
                    this.config.enableFomoRunner = enabled;
                    this.flashMoveService.setEnabled(enabled);
                    break;
                default:
                    return { success: false, message: `Unknown service: ${service}` };
            }
            return { success: true, message: `${service} ${enabled ? 'enabled' : 'disabled'}` };
        } catch (error: any) {
            this.logger.error(`Failed to toggle ${service}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Returns the current running status of all strategy modules
     */
    public getServicesStatus(): any {
        return {
            copyTrading: {
                enabled: this.config.enableCopyTrading,
                running: this.config.enableCopyTrading && this.monitor.isActive(),
                targets: this.config.userAddresses.length
            },
            moneyMarkets: {
                enabled: this.config.enableMoneyMarkets,
                running: this.config.enableMoneyMarkets && this.arbScanner.getIsScanning()
            },
            flashMoves: {
                enabled: this.config.enableFomoRunner,
                running: this.config.enableFomoRunner && this.flashMoveService.getStatus().isEnabled,
                activePositions: this.flashMoveService.getActivePositions().size
            }
        };
    }

    public async performTick(): Promise<void> {
        if (!this.isRunning) return;
        try {
            await this.syncStats();
            this.emit('tick', {
                stats: this.stats,
                activePositions: this.activePositions.length,
                timestamp: Date.now()
            });
        } catch (error) {
            this.logger.error(`❌ Tick error: ${error}`);
        }
    }

    private async syncStats(): Promise<void> {
        try {
            const cash = await this.exchange.fetchBalance(this.exchange.getFunderAddress());
            const posValue = this.activePositions.reduce((s, p) => s + (p.valueUsd || 0), 0);
            this.stats.portfolioValue = cash + posValue;
            this.stats.cashBalance = cash;
            if (this.callbacks?.onStatsUpdate) await this.callbacks.onStatsUpdate(this.stats);
        } catch (error) {
            this.logger.error(`❌ Stats sync failed: ${error}`);
        }
    }

    /**
     * PERSISTENT LOGGING: Saves log to DB and notifies UI listeners.
     * This fixes the "detached logs" issue where logs were not persisted.
     */
    private async addLog(type: 'info' | 'warn' | 'error' | 'success', message: string): Promise<void> {
        const timestamp = new Date();
        
        // 1. Persist to MongoDB for detached retrieval across sessions
        try {
            await BotLog.create({
                userId: this.config.userId.toLowerCase(),
                type,
                message,
                timestamp
            });
        } catch (e) {
            console.error("Failed to persist bot log to DB", e);
        }

        // 2. Push to UI socket via callback for real-time streaming
        if (this.callbacks?.onLog) {
            this.callbacks.onLog({
                id: crypto.randomUUID(),
                time: timestamp.toLocaleTimeString(),
                type,
                message,
                timestamp: timestamp.getTime()
            });
        }
    }

    /**
     * LEGACY COMPATIBILITY: Method from original code used for post-funding activation
     */
    public async proceedWithPostFundingSetup(): Promise<void> {
        try {
            this.addLog('info', 'Funding detected. Activating bot modules...');
            this.portfolioService.startSnapshotService(this.config.userId, async () => ({
                totalValue: this.stats.portfolioValue || 0,
                cashBalance: this.stats.cashBalance || 0,
                positions: this.activePositions,
                totalPnL: this.stats.totalPnl || 0
            }));
            
            if (this.config.enableMoneyMarkets) await this.arbScanner.start();
            if (this.config.enableFomoRunner) this.flashMoveService.setEnabled(true);
            if (this.config.enableCopyTrading) await this.monitor.start();
            
            await this.portfolioTracker.syncPositions(true);
            await this.syncStats();
            this.addLog('success', 'Bot Modules Online.');
        } catch (e: any) {
            this.addLog('error', `Post-funding setup failed: ${e.message}`);
        }
    }

    public getStats(): any {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            activePositions: this.activePositions.length,
            flashMoveService: this.flashMoveService.getStatus(),
            uptime: this.isRunning ? Date.now() : 0
        };
    }

    public getActiveSnipes(): any[] {
        const positions = this.flashMoveService?.getActivePositions();
        return positions ? Array.from(positions.values()) : [];
    }

    public getFlashMoveService(): FlashMoveService {
        return this.flashMoveService;
    }

    public getArbitrageScanner(): MarketMakingScanner {
        return this.arbScanner;
    }

    public updateCopyTradingTargets(targets: string[]): void {
        if (this.monitor) {
            this.monitor.updateTargets(targets);
            this.logger.info(`🎯 Copy targets synchronized: ${targets.length} wallets`);
        }
    }

    public getActivePositions(): any[] {
        return this.activePositions || [];
    }

    public getPortfolioTracker(): PortfolioTrackerService {
        return this.portfolioTracker;
    }

    public getMarketMetadataService(): MarketMetadataService {
        return this.marketMetadataService;
    }

    public getAdapter(): PolymarketAdapter {
        return this.exchange;
    }

    public getTradeMonitor(): TradeMonitorService {
        return this.monitor;
    }

    public async emergencySell(marketId: string, outcome: string): Promise<any> {
        const position = this.activePositions.find(p => p.marketId === marketId);
        if (!position) throw new Error(`No position found for market ${marketId}`);
        return await this.executor.executeManualExit(position, position.currentPrice || 0);
    }

    public async addMarketToMM(marketId: string): Promise<boolean> {
        return await this.arbScanner.addMarketByConditionId(marketId);
    }

    public async addMarketBySlug(slug: string): Promise<boolean> {
        return await this.arbScanner.addMarketBySlug(slug);
    }

    public bookmarkMarket(marketId: string): void {
        this.arbScanner?.bookmarkMarket(marketId);
    }

    public unbookmarkMarket(marketId: string): void {
        this.arbScanner?.unbookmarkMarket(marketId);
    }

    public getOpportunitiesByCategory(category: string): any[] {
        if (!this.arbScanner) return [];
        const allOpps = this.arbScanner.getOpportunities();
        return allOpps.filter((opp: any) => opp.category?.toLowerCase() === category.toLowerCase());
    }

    public getArbOpportunities(): any[] {
        return this.arbScanner?.getOpportunities() || [];
    }

    public getActiveFomoChases(): any[] {
        return this.getActiveSnipes();
    }

    public dispatchManualMM(marketId: string): boolean {
        this.logger.warn(`Manual arb execution triggered for market: ${marketId}`);
        // Dispatch logic would go here if specific manual override is required
        return true;
    }

    public updateConfig(config: Partial<BotConfig>): void {
        this.config = { ...this.config, ...config };
        if (config.userAddresses) this.updateCopyTradingTargets(config.userAddresses);
        this.logger.info('⚙️ Bot configuration updated.');
    }
}
