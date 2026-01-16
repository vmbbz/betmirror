import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.util.js';
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { BotLog, Trade } from '../database/index.js';
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
    private wsManager: WebSocketManager;
    private marketMetadataService: MarketMetadataService;
    private logger: Logger;

    constructor(config: any, intelligence: MarketIntelligenceService, registryService: any, callbacks: BotEngineCallbacks = {}) {
        super();
        this.config = config;
        this.intelligence = intelligence;
        this.registryService = registryService;
        this.callbacks = callbacks;
        this.logger = intelligence.logger; // Use the intelligence service's logger
        
        // Initialize services with unified architecture
        this.exchange = new PolymarketAdapter(config, this.logger);
        
        // Initialize WebSocket Manager
        this.wsManager = new WebSocketManager(this.logger, this.exchange);
        
        // Initialize Market Metadata Service
        this.marketMetadataService = new MarketMetadataService(
            this.exchange,
            this.logger
        );
        
        // Initialize Trade Executor first
        this.executor = new TradeExecutorService({
            adapter: this.exchange,
            env: {} as any,
            logger: this.logger,
            proxyWallet: '',
            wsManager: this.wsManager
        });
        
        // Initialize Flash Move Service with executor
        this.flashMoveService = new FlashMoveService(
            this.wsManager,
            DEFAULT_FLASH_MOVE_CONFIG,
            this.executor, // Pass trade executor as dependency
            this.logger
        );
        
        this.portfolioService = new PortfolioService(this.logger);
        this.positionMonitor = new PositionMonitorService(
            this.exchange,
            config.userId || '',
            { checkInterval: 30000, priceCheckInterval: 10000 },
            this.logger,
            async (position, reason) => {
                this.logger.info(`Auto cashout triggered: ${position.marketId} - ${reason}`);
            }
        );
        this.portfolioTracker = new PortfolioTrackerService(
            this.exchange,
            config.userId || '',
            10000,
            this.logger,
            this.positionMonitor,
            this.marketMetadataService
        );
        
        // Initialize TradeMonitorService with proper dependencies
        this.monitor = new TradeMonitorService({
            adapter: this.exchange,
            intelligence: intelligence,
            env: {} as any,
            logger: this.logger,
            userAddresses: config.userAddresses || [],  // Fixed: use userAddresses instead of targets
            onDetectedTrade: async (signal) => {
                // Handle copy trading signals here
                this.logger.info(`🔄 Copy Trade Signal: ${signal.side} ${signal.tokenId} @ ${signal.price}`);
                // Execute trade through executor
                try {
                    await this.executor.copyTrade(signal);
                } catch (error) {
                    this.logger.error(`❌ Copy trade failed: ${error}`);
                }
            }
        });
        
        // Initialize ArbitrageScanner with FlashMoveService integration
        this.arbScanner = new MarketMakingScanner(
            intelligence,
            this.exchange,
            this.logger,
            this.executor,
            this.wsManager,
            this.flashMoveService
        );
        
        // Set active positions from config if provided
        if (config.activePositions) {
            this.activePositions = config.activePositions;
        }
        
        // Initialize copy trading targets
        if (config.userAddresses) {
            this.monitor.updateTargets(config.userAddresses);
        }
        
        // Start all services immediately
        this.startServices();
        
        this.logger.info('🚀 Bot Engine initialized with unified Flash Move architecture');
    }

    private async startServices(): Promise<void> {
        await this.intelligence.start();
        await this.monitor.start();
        this.flashMoveService.setEnabled(true);
        await this.arbScanner.start();
    }

    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('⚠️ Bot engine already running');
            return;
        }

        this.isRunning = true;
        
        try {
            // Start core services
            await this.intelligence.start();
            await this.monitor.start();
            
            // Start unified flash move service
            this.flashMoveService.setEnabled(true);
            
            // Start arbitrage scanner
            await this.arbScanner.start();
            
            this.intelligence.logger.success('✅ Bot engine started successfully');
            this.emit('started');
            
        } catch (error) {
            this.intelligence.logger.error(`❌ Failed to start bot engine: ${error}`);
            this.isRunning = false;
            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) {
            this.intelligence.logger.warn('⚠️ Bot engine already stopped');
            return;
        }

        this.isRunning = false;
        
        try {
            // Stop flash move service
            this.flashMoveService.setEnabled(false);
            
            // Close all active positions
            await this.closeAllPositions();
            
            // Stop all services
            await this.arbScanner.stop();
            await this.monitor.stop();
            await this.intelligence.stop();
            
            // Clear heartbeat
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            
            this.intelligence.logger.success('✅ Bot engine stopped successfully');
            this.emit('stopped');
            
        } catch (error) {
            this.intelligence.logger.error(`❌ Failed to stop bot engine: ${error}`);
            throw error;
        }
    }

    public async performTick(): Promise<void> {
        if (!this.isRunning) return;

        try {
            // Update portfolio stats
            await this.syncStats();
            
            // Emit status update
            this.emit('tick', {
                stats: this.stats,
                activePositions: this.activePositions.length,
                timestamp: Date.now()
            });
            
        } catch (error) {
            this.intelligence.logger.error(`❌ Error during bot tick: ${error}`);
        }
    }

    private async syncStats(): Promise<void> {
        try {
            const address = this.exchange.getFunderAddress ? this.exchange.getFunderAddress() : this.config.userId || '';
            const cashBalance = await this.exchange.fetchBalance(address);
            let positionValue = 0;
            this.activePositions.forEach(p => {
                positionValue += (p.shares * (p.currentPrice || p.entryPrice));
            });
            if (this.callbacks?.onStatsUpdate) {
                await this.callbacks.onStatsUpdate({
                    totalPnl: this.stats.totalPnl,
                    totalVolume: this.stats.totalVolume,
                    totalFeesPaid: this.stats.totalFeesPaid,
                    winRate: this.stats.winRate,
                    tradesCount: this.stats.tradesCount,
                    winCount: this.stats.winCount,
                    lossCount: this.stats.lossCount,
                    allowanceApproved: true,
                    portfolioValue: cashBalance + positionValue,
                    cashBalance: cashBalance
                });
            }
        } catch (error) {
            this.intelligence.logger.error(`❌ Failed to sync stats: ${error}`);
        }
    }

    private addLog(type: string, message: string): void {
        if (this.callbacks?.onLog) {
            this.callbacks.onLog({
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                type,
                message
            });
        }
    }

    private async closeAllPositions(): Promise<void> {
        const positions = [...this.activePositions];
        
        for (const position of positions) {
            try {
                await this.executor.executeManualExit(position, position.currentPrice || 0);
                this.intelligence.logger.info(`🔄 Closed position: ${position.tokenId}`);
            } catch (error) {
                this.intelligence.logger.error(`❌ Failed to close position ${position.tokenId}: ${error}`);
            }
        }
    }

    public getStats(): any {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            activePositions: this.activePositions.length,
            flashMoveService: this.flashMoveService.getStatus(),
            uptime: this.isRunning ? Date.now() - (this as any).startTime : 0
        };
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
            this.logger.info(`🎯 Copy trading targets updated: ${targets.length} wallets`);
        }
    }

    public async proceedWithPostFundingSetup(): Promise<void> {
        const engineLogger = {
            info: (m: string) => this.addLog('info', m),
            warn: (m: string) => this.addLog('warn', m),
            error: (m: string, e?: any) => this.addLog('error', `${m} ${e?.message || ''}`),
            debug: () => { },
            success: (m: string) => this.addLog('success', m)
        };
        try {
            this.portfolioService = new PortfolioService(engineLogger);
            this.portfolioService.startSnapshotService(this.config.userId, async () => ({
                totalValue: this.stats.portfolioValue || 0,
                cashBalance: this.stats.cashBalance || 0,
                positions: this.activePositions,
                totalPnL: this.stats.totalPnl || 0
            }));
            if (this.config.enableMoneyMarkets && this.arbScanner)
                await this.arbScanner.start();
            if (this.config.enableFomoRunner && this.flashMoveService)
                this.flashMoveService.setEnabled(true);
            if (this.config.enableCopyTrading && this.monitor)
                await this.monitor.start();
            await this.portfolioTracker.syncPositions(true);
            await this.syncStats();
            this.addLog('success', 'Bot Modules Activated.');
        }
        catch (e: any) {
            this.addLog('error', `Setup Failed: ${e.message}`);
        }
    }

        public getActiveSnipes(): any[] {
            const positions = this.flashMoveService?.getActivePositions();
            return positions ? Array.from(positions) : [];
        }

        /**
         * Runtime Service Toggle - Enable/disable services dynamically
         */
        public async toggleService(service: string, enabled: boolean): Promise<{ success: boolean; message: string }> {
            try {
                switch (service.toLowerCase()) {
                    case 'moneymarkets':
                    case 'arbitrage':
                        if (this.arbScanner) {
                            if (enabled) {
                                await this.arbScanner.start();
                                this.config.enableMoneyMarkets = true;
                                this.logger.info('✅ Money Markets service ENABLED');
                            } else {
                                await this.arbScanner.stop();
                                this.config.enableMoneyMarkets = false;
                                this.logger.info('⏸️ Money Markets service DISABLED');
                            }
                            return { success: true, message: `Money Markets ${enabled ? 'enabled' : 'disabled'}` };
                        }
                        break;

                    case 'flashmoves':
                    case 'fomorunner':
                        if (this.flashMoveService) {
                            this.flashMoveService.setEnabled(enabled);
                            this.config.enableFomoRunner = enabled;
                            this.logger.info(`${enabled ? '✅' : '⏸️'} Flash Moves service ${enabled ? 'ENABLED' : 'DISABLED'}`);
                            return { success: true, message: `Flash Moves ${enabled ? 'enabled' : 'disabled'}` };
                        }
                        break;

                    case 'copytrading':
                        if (this.monitor) {
                            if (enabled) {
                                await this.monitor.start();
                                this.config.enableCopyTrading = true;
                                this.logger.info('✅ Copy Trading service ENABLED');
                            } else {
                                await this.monitor.stop();
                                this.config.enableCopyTrading = false;
                                this.logger.info('⏸️ Copy Trading service DISABLED');
                            }
                            return { success: true, message: `Copy Trading ${enabled ? 'enabled' : 'disabled'}` };
                        }
                        break;

                    default:
                        return { success: false, message: `Unknown service: ${service}` };
                }
            } catch (error: any) {
                this.logger.error(`Failed to toggle ${service}: ${error.message}`);
                return { success: false, message: error.message };
            }

            return { success: false, message: `Service ${service} not available` };
        }

        /**
         * Get current status of all services
         */
        public getServicesStatus(): {
            moneyMarkets: { enabled: boolean; running: boolean };
            flashMoves: { enabled: boolean; running: boolean; activePositions?: number };
            copyTrading: { enabled: boolean; running: boolean; targets?: number };
        } {
            return {
                moneyMarkets: {
                    enabled: this.config.enableMoneyMarkets,
                    running: this.arbScanner?.isScanning || false
                },
                flashMoves: {
                    enabled: this.config.enableFomoRunner,
                    running: this.flashMoveService?.getStatus().isEnabled || false,
                    activePositions: this.flashMoveService?.getStatus().activePositions || 0
                },
                copyTrading: {
                    enabled: this.config.enableCopyTrading,
                    running: (this.monitor as any)?.running || false,
                    targets: this.config.targets?.length || 0
                }
            };
        }

        public getOpportunitiesByCategory(category: string): any[] {
            if (!this.arbScanner)
                return [];
            const allOpps = this.arbScanner.getOpportunities();
            return allOpps.filter((opp: any) => opp.category?.toLowerCase() === category.toLowerCase());
        }

        public getTradeMonitor(): TradeMonitorService {
            return this.monitor;
        }

        public getArbOpportunities(): any[] {
            return this.arbScanner?.getOpportunities() || [];
        }

        public getActiveFomoChases(): any[] {
            return [];
        }

        public updateConfig(config: Partial<BotConfig>): void {
            this.config = { ...this.config, ...config };
            if (config.userAddresses) {
                this.updateCopyTradingTargets(config.userAddresses);
            }
            this.logger.info('⚙️ Bot configuration updated');
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

    public async emergencySell(marketId: string, outcome: string): Promise<any> {
        try {
            const position = this.activePositions.find(p => p.marketId === marketId);
            if (!position) {
                throw new Error(`No position found for market ${marketId}`);
            }
            const result = await this.executor.executeManualExit(position, position.currentPrice || 0);
            this.logger.info(`🚨 Emergency sell executed for market ${marketId}`);
            return result;
        } catch (error) {
            this.logger.error(`❌ Emergency sell failed: ${error}`);
            throw error;
        }
    }

    public async addMarketToMM(marketId: string): Promise<boolean> {
        try {
            return await this.arbScanner.addMarketByConditionId(marketId);
        } catch (error) {
            this.logger.error(`❌ Failed to add market to MM: ${error}`);
            return false;
        }
    }

    public async addMarketBySlug(slug: string): Promise<boolean> {
        try {
            return await this.arbScanner.addMarketBySlug(slug);
        } catch (error) {
            this.logger.error(`❌ Failed to add market by slug: ${error}`);
            return false;
        }
    }

    public bookmarkMarket(marketId: string): void {
        this.arbScanner?.bookmarkMarket(marketId);
    }

    public unbookmarkMarket(marketId: string): void {
        this.arbScanner?.unbookmarkMarket(marketId);
    }

    public dispatchManualMM(marketId: string): boolean {
        try {
            // Note: executeManualArbitrage method doesn't exist in MarketMakingScanner
            // This method needs to be implemented in the arbitrage scanner
            this.logger.warn(`⚠️ Manual arbitrage execution not implemented for market: ${marketId}`);
            return false;
        } catch (error) {
            this.logger.error(`❌ Failed to dispatch manual MM: ${error}`);
            return false;
        }
    }
}