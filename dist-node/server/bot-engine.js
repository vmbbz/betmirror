import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { BotLog, Trade } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { MarketMakingScanner } from '../services/arbitrage-scanner.js';
import { PortfolioTrackerService } from '../services/portfolio-tracker.service.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { FomoRunnerService } from '../services/fomo-runner.services.js';
import crypto from 'crypto';
export class BotEngine {
    config;
    intelligence;
    registryService;
    callbacks;
    isRunning = false;
    monitor;
    executor;
    arbScanner;
    fomoRunner;
    exchange;
    portfolioService;
    portfolioTracker;
    positionMonitor;
    fundWatcher;
    heartbeatInterval;
    activePositions = [];
    stats = {
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
    lastPositionSync = 0;
    lastKnownBalance = 0;
    POSITION_SYNC_INTERVAL = 300000; // 5 minute standard cycle
    marketMetadataCache = new Map();
    MARKET_METADATA_CACHE_TTL = 24 * 60 * 60 * 1000;
    constructor(config, intelligence, registryService, callbacks) {
        this.config = config;
        this.intelligence = intelligence;
        this.registryService = registryService;
        this.callbacks = callbacks;
        if (config.activePositions)
            this.activePositions = config.activePositions;
        if (config.stats)
            this.stats = config.stats;
    }
    getAdapter() {
        return this.exchange;
    }
    async addLog(type, message) {
        try {
            const consoleMethod = type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'log';
            console[consoleMethod](`[ENGINE][${this.config.userId.slice(0, 8)}] ${message}`);
            if (this.callbacks?.onLog) {
                this.callbacks.onLog({ time: new Date().toLocaleTimeString(), type, message });
            }
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() });
        }
        catch (e) {
            console.error("Log failed", e);
        }
    }
    updateConfig(newConfig) {
        if (newConfig.userAddresses && this.monitor) {
            this.monitor.updateTargets(newConfig.userAddresses);
        }
        if (newConfig.enableCopyTrading !== undefined && this.monitor) {
            if (newConfig.enableCopyTrading) {
                this.monitor.start();
                this.addLog('success', '▶️ Copy-Trading Module Online.');
            }
            else {
                this.monitor.stop();
                this.addLog('warn', '⏸️ Copy-Trading Module Standby.');
            }
        }
        if (newConfig.enableMoneyMarkets !== undefined && this.arbScanner) {
            if (newConfig.enableMoneyMarkets) {
                this.arbScanner.start();
                this.addLog('success', '▶️ Money Markets Module Online.');
            }
            else {
                this.arbScanner.stop();
                this.addLog('warn', '⏸️ Money Markets Standby.');
            }
        }
        if (newConfig.enableFomoRunner !== undefined && this.fomoRunner) {
            if (newConfig.enableFomoRunner) {
                this.fomoRunner.setConfig(newConfig.enableFomoRunner, (newConfig.autoTp || 20) / 100);
                this.addLog('success', '▶️ FOMO Runner Online.');
            }
            else {
                this.addLog('warn', '⏸️ FOMO Runner Standby.');
            }
        }
        this.config = { ...this.config, ...newConfig };
    }
    async fetchMarketMetadata(marketId) {
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
                const marketData = await this.exchange.getMarketData?.(marketId);
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
                    marketSlug: trade.marketSlug || '',
                    eventSlug: trade.eventSlug || '',
                    question: trade.marketQuestion || trade.question || `Market ${marketId}`,
                    image: trade.marketImage || trade.image || ''
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
        }
        catch (error) {
            return {
                marketSlug: marketId.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                eventSlug: 'unknown',
                question: `Market ${marketId}`,
                image: ''
            };
        }
    }
    async enrichPosition(position) {
        if (position.tradeId && position.marketSlug && position.eventSlug) {
            return position;
        }
        const { marketSlug, eventSlug, question, image } = await this.fetchMarketMetadata(position.marketId);
        return {
            tradeId: position.tradeId || `pos-${position.marketId}-${Date.now()}`,
            clobOrderId: position.clobOrderId || position.tokenId || '',
            marketId: position.marketId,
            conditionId: position.conditionId || position.marketId,
            tokenId: position.tokenId || position.marketId,
            outcome: (position.outcome || 'YES').toUpperCase(),
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
    async updateMarketState(position) {
        if (!this.exchange)
            return;
        try {
            const client = this.exchange.getRawClient?.();
            if (client) {
                const market = await client.getMarket(position.marketId);
                if (market) {
                    position.marketClosed = market.closed || false;
                    position.marketActive = market.active || false;
                    position.marketAcceptingOrders = market.accepting_orders || false;
                    position.marketArchived = market.archived || false;
                    if (market.closed) {
                        position.marketState = 'CLOSED';
                    }
                    else if (market.archived) {
                        position.marketState = 'ARCHIVED';
                    }
                    else if (!market.active || !market.accepting_orders) {
                        position.marketState = 'RESOLVED';
                    }
                    else {
                        position.marketState = 'ACTIVE';
                    }
                }
                else {
                    position.marketState = 'RESOLVED';
                    position.marketClosed = true;
                    position.marketActive = false;
                    position.marketAcceptingOrders = false;
                }
            }
        }
        catch (e) {
            if (String(e).includes("404") || String(e).includes("Not Found")) {
                position.marketState = 'RESOLVED';
                position.marketClosed = true;
                position.marketActive = false;
                position.marketAcceptingOrders = false;
            }
            else {
                this.addLog('warn', `Failed to check market state for ${position.marketId}: ${e.message}`);
            }
        }
    }
    /**
     * SYNC POSITIONS: High-performance pipeline.
     * Only executes RPC getPositions if timer expires OR if balance has changed significantly.
     */
    async syncPositions(forceChainSync = false) {
        if (!this.exchange)
            return;
        const now = Date.now();
        const funder = this.exchange.getFunderAddress();
        // 1. Fetch current balance (light call)
        const currentBalance = await this.exchange.fetchBalance(funder);
        const hasBalanceChanged = Math.abs(currentBalance - this.lastKnownBalance) > 0.05;
        this.lastKnownBalance = currentBalance;
        // 2. Throttling Check
        if (!forceChainSync && !hasBalanceChanged && (now - this.lastPositionSync < this.POSITION_SYNC_INTERVAL)) {
            return;
        }
        this.lastPositionSync = now;
        try {
            const positions = await this.exchange.getPositions(funder);
            const enriched = [];
            for (const p of positions) {
                const pos = await this.enrichPosition(p);
                await this.updateMarketState(pos);
                // Flag if managed by current MM strategy
                pos.managedByMM = this.arbScanner?.hasActiveQuotes(pos.tokenId) || false;
                enriched.push(pos);
            }
            this.activePositions = enriched;
            if (this.callbacks?.onPositionsUpdate) {
                await this.callbacks.onPositionsUpdate(enriched);
            }
            await this.syncStats();
        }
        catch (e) {
            this.addLog('error', `Sync Positions Failed: ${e.message}`);
        }
    }
    getAutoCashoutConfig() {
        if (this.config.autoCashout)
            return this.config.autoCashout;
        const walletAutoCashout = this.config.walletConfig?.autoCashout;
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
    async handleAutoCashout(position, reason) {
        if (!this.executor)
            return;
        this.addLog('info', `Auto-cashing out position: ${position.marketId} (${position.outcome}) - ${reason}`);
        try {
            const cashoutCfg = this.getAutoCashoutConfig();
            if (!cashoutCfg?.enabled)
                return;
            const result = await this.executor.executeManualExit(position, 0);
            if (result) {
                this.addLog('success', `Successfully executed auto-cashout for position: ${position.marketId}`);
            }
            else {
                this.addLog('error', `Failed to execute auto-cashout for position: ${position.marketId}`);
            }
        }
        catch (error) {
            this.addLog('error', `Error in handleAutoCashout: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async handleInvalidPosition(marketId, reason) {
        this.addLog('warn', `Position ${marketId} is invalid: ${reason}. Cleaning up...`);
        this.activePositions = this.activePositions.filter(p => p.marketId !== marketId);
        if (this.callbacks?.onPositionsUpdate) {
            await this.callbacks.onPositionsUpdate(this.activePositions);
        }
    }
    async syncStats() {
        if (!this.exchange)
            return;
        const address = this.exchange.getFunderAddress();
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
    }
    async emergencySell(tradeIdOrMarketId, outcome) {
        if (!this.executor)
            throw new Error("Executor not initialized.");
        let positionIndex = this.activePositions.findIndex(p => p.tradeId === tradeIdOrMarketId);
        if (positionIndex === -1 && outcome) {
            positionIndex = this.activePositions.findIndex(p => p.marketId === tradeIdOrMarketId && p.outcome === outcome);
        }
        if (positionIndex === -1)
            throw new Error("Position not found in active database.");
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
                if (this.callbacks?.onPositionsUpdate)
                    await this.callbacks.onPositionsUpdate(this.activePositions);
                this.addLog('success', `Exit summary: Liquidated ${position.shares.toFixed(2)} shares @ $${currentPrice.toFixed(3)}`);
                setTimeout(() => this.syncStats(), 2000);
                return "sold";
            }
            else {
                throw new Error("Execution failed at adapter level");
            }
        }
        catch (e) {
            this.addLog('error', `Manual Exit Failed: ${e.message}`);
            throw e;
        }
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        const engineLogger = {
            info: (m) => this.addLog('info', m),
            warn: (m) => this.addLog('warn', m),
            error: (m, e) => this.addLog('error', `${m} ${e?.message || ''}`),
            debug: () => { },
            success: (m) => this.addLog('success', m)
        };
        try {
            // Use existing Intelligence singleton, do NOT overwrite
            if (!this.intelligence.isRunning) {
                await this.intelligence.start();
            }
            // Initialize exchange
            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig,
                userId: this.config.userId,
                mongoEncryptionKey: this.config.mongoEncryptionKey,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase
            }, engineLogger);
            await this.exchange.initialize();
            await this.exchange.authenticate();
            // Initialize executor
            this.executor = new TradeExecutorService({
                adapter: this.exchange,
                proxyWallet: this.exchange.getFunderAddress(),
                env: { tradeMultiplier: this.config.multiplier, maxTradeAmount: this.config.maxTradeAmount || 100 },
                logger: engineLogger
            });
            // Initialize all core modules
            this.initializeCoreModules(engineLogger);
            this.startHeartbeat();
            this.addLog('success', 'Full Strategy Engine Online.');
        }
        catch (e) {
            this.addLog('error', `Startup failed: ${e.message}`);
            this.isRunning = false;
            throw e;
        }
    }
    /**
     * Orchestrated Tick: Called by Master Heartbeat to sync state.
     * Uses the throttled syncPositions instead of raw RPC calls.
     */
    async performTick() {
        if (!this.isRunning || !this.exchange)
            return;
        await this.syncPositions(false);
    }
    initializeCoreModules(logger) {
        if (!this.exchange || !this.executor)
            return;
        const funder = this.exchange.getFunderAddress();
        // Initialize position monitoring
        this.positionMonitor = new PositionMonitorService(this.exchange, funder, { checkInterval: 30000, priceCheckInterval: 60000 }, logger, async (pos, reason) => {
            await this.executor?.executeManualExit(pos, 0);
        });
        // Initialize portfolio tracking
        this.portfolioTracker = new PortfolioTrackerService(this.exchange, funder, (this.config.maxTradeAmount || 1000) * 10, logger, this.positionMonitor, (positions) => {
            this.activePositions = positions;
            this.callbacks?.onPositionsUpdate?.(positions);
        });
        // Initialize market making scanner if enabled
        if (this.config.enableMoneyMarkets) {
            this.arbScanner = new MarketMakingScanner(this.intelligence, this.exchange, logger);
            this.arbScanner.start();
        }
        // Initialize FOMO runner if enabled
        if (this.config.enableFomoRunner) {
            this.fomoRunner = new FomoRunnerService(this.intelligence, this.executor, this.exchange, logger);
            this.fomoRunner.setConfig(true, (this.config.autoTp || 20) / 100);
        }
        // Initialize trade monitor if copy trading is enabled
        if (this.config.enableCopyTrading) {
            this.monitor = new TradeMonitorService({
                adapter: this.exchange,
                intelligence: this.intelligence,
                env: {
                    tradeMultiplier: this.config.multiplier,
                    maxTradeAmount: this.config.maxTradeAmount || 100
                },
                logger,
                userAddresses: this.config.userAddresses,
                onDetectedTrade: async (signal) => {
                    if (!this.isRunning)
                        return;
                    const result = await this.executor.copyTrade(signal);
                    if (result.status === 'FILLED' && this.callbacks?.onTradeComplete) {
                        this.callbacks.onTradeComplete({
                            id: result.txHash || Math.random().toString(),
                            timestamp: new Date().toISOString(),
                            marketId: signal.marketId,
                            outcome: "YES",
                            side: signal.side,
                            size: signal.sizeUsd,
                            executedSize: result.executedAmount,
                            price: result.priceFilled,
                            status: 'FILLED'
                        });
                        await this.syncPositions(true); // Force sync after trade
                    }
                }
            });
            this.monitor.start();
        }
    }
    startHeartbeat() {
        if (this.heartbeatInterval)
            clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(async () => {
            if (!this.isRunning)
                return;
            // 1. User-specific Snipes update for the UI
            if (this.fomoRunner) {
                const snipes = this.fomoRunner.getActiveSnipes();
                this.callbacks?.onFomoSnipes?.(snipes);
            }
            // 2. Market Making Opportunities for UI
            if (this.arbScanner) {
                const opps = this.arbScanner.getOpportunities();
                this.callbacks?.onArbUpdate?.(opps);
                // AUTOMATED LIQUIDITY PROVISION:
                if (opps.length > 0 && this.executor) {
                    const topOpp = opps[0];
                    const ageSeconds = (Date.now() - topOpp.timestamp) / 1000;
                    const isRewardScoring = topOpp.spreadCents <= (topOpp.rewardsMaxSpread || 10);
                    if (ageSeconds < 30 && isRewardScoring && topOpp.acceptingOrders) {
                        this.executor.executeMarketMakingQuotes(topOpp).catch(() => { });
                    }
                }
            }
            // 3. User-specific Position & Stats sync (Handles throttling internally)
            await this.syncPositions();
            await this.syncStats();
        }, 2000);
    }
    stop() {
        this.isRunning = false;
        this.arbScanner?.stop();
        this.fomoRunner?.setConfig(false, 0.2);
        if (this.monitor)
            this.monitor.stop();
        if (this.portfolioService)
            this.portfolioService.stopSnapshotService();
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = undefined;
        }
        this.addLog('warn', 'Engine Stopped.');
    }
    async dispatchManualMM(marketId) {
        if (!this.executor)
            return false;
        const target = this.arbScanner?.getTrackedMarket(marketId);
        if (target) {
            await this.executor.executeMarketMakingQuotes(target);
            return true;
        }
        return false;
    }
    async checkFunding() {
        try {
            if (!this.exchange)
                return false;
            const funderAddr = this.exchange.getFunderAddress();
            const balanceUSDC = await this.exchange.fetchBalance(funderAddr);
            return balanceUSDC >= 1.0 || this.activePositions.length > 0;
        }
        catch (e) {
            return false;
        }
    }
    async proceedWithPostFundingSetup() {
        const engineLogger = {
            info: (m) => this.addLog('info', m),
            warn: (m) => this.addLog('warn', m),
            error: (m, e) => this.addLog('error', `${m} ${e?.message || ''}`),
            debug: () => { },
            success: (m) => this.addLog('success', m)
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
            if (this.config.enableFomoRunner && this.fomoRunner)
                this.fomoRunner.setConfig(true, (this.config.autoTp || 20) / 100);
            if (this.config.enableCopyTrading && this.monitor)
                await this.monitor.start();
            await this.syncPositions(true);
            await this.syncStats();
            this.addLog('success', 'Bot Modules Activated.');
        }
        catch (e) {
            this.addLog('error', `Setup Failed: ${e.message}`);
        }
    }
    getActiveFomoMoves() {
        return this.intelligence?.getLatestMoves() || [];
    }
    getActiveSnipes() {
        return this.fomoRunner?.getActiveSnipes() || [];
    }
    getOpportunitiesByCategory(category) {
        if (!this.arbScanner)
            return [];
        const allOpps = this.arbScanner.getOpportunities();
        return allOpps.filter(opp => opp.category?.toLowerCase() === category.toLowerCase());
    }
    getActivePositions() { return this.activePositions; }
    getArbOpportunities() { return this.arbScanner?.getOpportunities() || []; }
    getActiveFomoChases() { return []; }
    getCallbacks() { return this.callbacks; }
    async addMarketToMM(conditionId) { return this.arbScanner?.addMarketByConditionId(conditionId) || false; }
    async addMarketBySlug(slug) { return this.arbScanner?.addMarketBySlug(slug) || false; }
    bookmarkMarket(marketId) { this.arbScanner?.bookmarkMarket(marketId); }
    unbookmarkMarket(marketId) { this.arbScanner?.unbookmarkMarket(marketId); }
}
