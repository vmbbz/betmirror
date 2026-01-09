import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { aiAgent } from '../services/ai-agent.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { BotLog, Trade } from '../database/index.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import { TOKENS } from '../config/env.js';
import { MarketMakingScanner } from '../services/arbitrage-scanner.js';
import { PortfolioTrackerService } from '../services/portfolio-tracker.service.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { SportsIntelService } from '../services/sports-intel.service.js';
import { SportsRunnerService } from '../services/sports-runner.service.js';
import crypto from 'crypto';
export class BotEngine {
    config;
    registryService;
    callbacks;
    isRunning = false;
    monitor;
    executor;
    arbScanner;
    sportsRunner;
    sportsIntel;
    exchange;
    portfolioService;
    portfolioTracker;
    positionMonitor;
    runtimeEnv;
    fundWatcher;
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
    POSITION_SYNC_INTERVAL = 30000;
    marketMetadataCache = new Map();
    MARKET_METADATA_CACHE_TTL = 24 * 60 * 60 * 1000;
    constructor(config, registryService, callbacks) {
        this.config = config;
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
            await BotLog.create({ userId: this.config.userId, type, message, timestamp: new Date() });
        }
        catch (e) {
            console.error("Log failed", e);
        }
    }
    updateConfig(newConfig) {
        if (newConfig.userAddresses && this.monitor) {
            this.monitor.updateTargets(newConfig.userAddresses);
            this.config.userAddresses = newConfig.userAddresses;
        }
        if (newConfig.enableCopyTrading === false && this.monitor?.isActive()) {
            this.addLog('warn', '⏸️ Copy-Trading Module Standby.');
            this.monitor.stop();
        }
        else if (newConfig.enableCopyTrading === true && this.monitor && !this.monitor.isActive()) {
            this.addLog('success', '▶️ Copy-Trading Module Online.');
            this.monitor.start(this.config.startCursor || Math.floor(Date.now() / 1000));
        }
        if (newConfig.enableMoneyMarkets === false && this.arbScanner?.isScanning) {
            this.addLog('warn', '⏸️ Money Markets Standby.');
            this.arbScanner.stop();
        }
        else if (newConfig.enableMoneyMarkets === true && this.arbScanner && !this.arbScanner.isScanning) {
            this.addLog('success', '▶️ Money Markets Module Online.');
            this.arbScanner.start();
        }
        const sportsEnabled = newConfig.enableSportsRunner ?? newConfig.enableSportsFrontrunning;
        if (sportsEnabled === false && this.sportsIntel?.isActive()) {
            this.addLog('warn', '⏸️ SportsRunner Module Standby.');
            this.sportsIntel?.stop();
            this.sportsRunner?.stop();
        }
        else if (sportsEnabled === true && this.sportsIntel && !this.sportsIntel.isActive()) {
            this.addLog('success', '▶️ SportsRunner Module Online.');
            this.sportsIntel.start();
            this.sportsRunner?.start();
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
    async syncPositions(forceChainSync = false) {
        if (!this.exchange)
            return;
        const now = Date.now();
        if (!forceChainSync && (now - this.lastPositionSync < this.POSITION_SYNC_INTERVAL)) {
            return;
        }
        this.lastPositionSync = now;
        try {
            const funder = this.exchange.getFunderAddress();
            const positions = await this.exchange.getPositions(funder);
            const enriched = [];
            for (const p of positions) {
                const marketSlug = p.marketSlug || "";
                const eventSlug = p.eventSlug || "";
                if (marketSlug || eventSlug) {
                    const updateData = {};
                    if (marketSlug)
                        updateData.marketSlug = marketSlug;
                    if (eventSlug)
                        updateData.eventSlug = eventSlug;
                    await Trade.updateMany({ userId: this.config.userId, marketId: p.marketId }, { $set: updateData });
                }
                const pos = await this.enrichPosition({
                    marketId: p.marketId,
                    tokenId: p.tokenId,
                    conditionId: p.conditionId,
                    outcome: p.outcome,
                    entryPrice: p.entryPrice,
                    balance: p.balance,
                    valueUsd: p.valueUsd,
                    currentPrice: p.currentPrice,
                    question: p.question,
                    image: p.image,
                    marketSlug: p.marketSlug,
                    eventSlug: p.eventSlug,
                    investedValue: p.investedValue
                });
                await this.updateMarketState(pos);
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
        try {
            const address = this.exchange.getFunderAddress();
            if (!address)
                return;
            const cashBalance = await this.exchange.fetchBalance(address);
            let positionValue = 0;
            this.activePositions.forEach(p => {
                if (p.shares && p.currentPrice && !isNaN(p.shares * p.currentPrice)) {
                    positionValue += (p.shares * p.currentPrice);
                }
            });
            this.stats.portfolioValue = cashBalance + positionValue;
            this.stats.cashBalance = cashBalance;
            if (this.callbacks?.onStatsUpdate)
                await this.callbacks.onStatsUpdate(this.stats);
        }
        catch (e) {
            console.error("Sync Stats Error", e);
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
    async initializeServices() {
        if (!this.exchange)
            throw new Error('Exchange not initialized');
        const logger = {
            info: (m) => this.addLog('info', m),
            warn: (m) => this.addLog('warn', m),
            error: (m, e) => this.addLog('error', `${m} ${e ? e.message : ''}`),
            debug: () => { },
            success: (m) => this.addLog('success', m)
        };
        const funder = this.exchange.getFunderAddress();
        this.positionMonitor = new PositionMonitorService(this.exchange, funder, { checkInterval: 30000, priceCheckInterval: 60000, orderBookValidationInterval: 3600000 }, logger, this.handleAutoCashout.bind(this), this.handleInvalidPosition.bind(this));
        this.portfolioTracker = new PortfolioTrackerService(this.exchange, funder, (this.config.maxTradeAmount || 1000) * 10, logger, this.positionMonitor, (positions) => {
            this.activePositions = positions;
            return this.callbacks?.onPositionsUpdate?.(positions) || Promise.resolve();
        });
        await this.portfolioTracker.initialize();
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        const engineLogger = {
            info: (m) => this.addLog('info', m),
            warn: (m) => this.addLog('warn', m),
            error: (m, e) => this.addLog('error', `${m} ${e ? e.message : ''}`),
            debug: () => { },
            success: (m) => this.addLog('success', m)
        };
        try {
            this.exchange = new PolymarketAdapter({
                rpcUrl: this.config.rpcUrl,
                walletConfig: this.config.walletConfig,
                userId: this.config.userId,
                l2ApiCredentials: this.config.l2ApiCredentials,
                mongoEncryptionKey: this.config.mongoEncryptionKey,
                builderApiKey: this.config.builderApiKey,
                builderApiSecret: this.config.builderApiSecret,
                builderApiPassphrase: this.config.builderApiPassphrase
            }, engineLogger);
            await this.exchange.initialize();
            await this.exchange.authenticate();
            const rawClient = this.exchange.getRawClient();
            if (!rawClient)
                throw new Error("Adapter failed to initialize authorized ClobClient.");
            this.sportsIntel = new SportsIntelService(engineLogger);
            this.sportsRunner = new SportsRunnerService(this.sportsIntel, engineLogger, rawClient);
            this.arbScanner = new MarketMakingScanner(this.exchange, engineLogger);
            const funder = this.exchange.getFunderAddress();
            this.executor = new TradeExecutorService({
                adapter: this.exchange,
                proxyWallet: funder,
                env: { tradeMultiplier: this.config.multiplier, maxTradeAmount: this.config.maxTradeAmount || 100, usdcContractAddress: TOKENS.USDC_BRIDGED },
                logger: engineLogger
            });
            await this.initializeServices();
            await this.initializeCoreModules(engineLogger);
            const isFunded = await this.checkFunding();
            if (!isFunded) {
                this.addLog('warn', 'Safe empty. Engine on standby. Waiting for deposit...');
                this.startFundWatcher();
                return;
            }
            await this.proceedWithPostFundingSetup(engineLogger);
        }
        catch (e) {
            this.addLog('error', `Startup Failed: ${e.message}`);
            this.isRunning = false;
        }
    }
    stop() {
        this.isRunning = false;
        this.arbScanner?.stop();
        this.sportsRunner?.stop();
        this.sportsIntel?.stop();
        if (this.monitor)
            this.monitor.stop();
        if (this.portfolioService)
            this.portfolioService.stopSnapshotService();
        if (this.fundWatcher) {
            clearInterval(this.fundWatcher);
            this.fundWatcher = undefined;
        }
        this.addLog('warn', 'Engine Stopped.');
    }
    async initializeCoreModules(logger) {
        if (!this.exchange)
            return;
        const funder = this.exchange.getFunderAddress();
        if (!this.positionMonitor) {
            this.positionMonitor = new PositionMonitorService(this.exchange, funder, { checkInterval: 30000, priceCheckInterval: 60000 }, logger, this.handleAutoCashout.bind(this), this.handleInvalidPosition.bind(this));
        }
        if (!this.portfolioTracker) {
            this.portfolioTracker = new PortfolioTrackerService(this.exchange, funder, (this.config.maxTradeAmount || 1000) * 10, logger, this.positionMonitor, (positions) => {
                this.activePositions = positions;
                if (this.callbacks?.onPositionsUpdate)
                    this.callbacks.onPositionsUpdate(positions);
            });
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
            onDetectedTrade: async (signal) => {
                if (!this.isRunning)
                    return;
                const isManagedByMM = this.arbScanner?.getOpportunities().some(o => o.tokenId === signal.tokenId);
                if (isManagedByMM && (this.config.enableAutoArb || this.config.enableMoneyMarkets)) {
                    this.addLog('info', `🛡️ Signal Skipped: Market ${signal.marketId.slice(0, 8)} is managed by MM Strategy.`);
                    return;
                }
                if (signal.side === 'SELL') {
                    const hasPosition = this.activePositions.some(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                    if (!hasPosition)
                        return;
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
                    const result = await this.executor.copyTrade(signal);
                    if (result.status === 'FILLED') {
                        this.addLog('success', `Trade Executed! Size: $${result.executedAmount.toFixed(2)}`);
                        await this.syncPositions(true);
                        await this.syncStats();
                    }
                }
            }
        });
    }
    async dispatchManualMM(marketId) {
        if (!this.executor)
            return false;
        const target = this.arbScanner?.getTrackedMarket(marketId);
        if (target) {
            // Pass the tracked market directly to the MM executor, casting to any 
            // to bypass the restrictive TrackedMarket type and fix the 12 build errors.
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
    startFundWatcher() {
        if (this.fundWatcher)
            clearInterval(this.fundWatcher);
        this.fundWatcher = setInterval(async () => {
            if (!this.isRunning)
                return;
            const funded = await this.checkFunding();
            if (funded) {
                clearInterval(this.fundWatcher);
                this.fundWatcher = undefined;
                await this.proceedWithPostFundingSetup({ info: console.log, warn: console.warn, error: console.error, debug: () => { }, success: console.log });
            }
        }, 15000);
    }
    async proceedWithPostFundingSetup(logger) {
        try {
            this.portfolioService = new PortfolioService(logger);
            this.portfolioService.startSnapshotService(this.config.userId, async () => ({
                totalValue: this.stats.portfolioValue || 0,
                cashBalance: this.stats.cashBalance || 0,
                positions: this.activePositions,
                totalPnL: this.stats.totalPnl || 0
            }));
            if (this.config.enableMoneyMarkets && this.arbScanner)
                await this.arbScanner.start();
            const sportsActive = this.config.enableSportsRunner || this.config.enableSportsFrontrunning;
            if (sportsActive && this.sportsIntel) {
                await this.sportsIntel.start();
                this.sportsRunner?.start();
            }
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
    getActivePositions() { return this.activePositions; }
    getArbOpportunities() { return this.arbScanner?.getOpportunities() || []; }
    getLiveSportsMatches() { return this.sportsIntel?.getLiveMatches() || []; }
    getActiveSportsChases() { return this.sportsRunner?.getActiveChases() || []; }
    getCallbacks() { return this.callbacks; }
    async addMarketToMM(conditionId) { return this.arbScanner?.addMarketByConditionId(conditionId) || false; }
    async addMarketBySlug(slug) { return this.arbScanner?.addMarketBySlug(slug) || false; }
    bookmarkMarket(conditionId) { this.arbScanner?.bookmarkMarket(conditionId); }
    unbookmarkMarket(conditionId) { this.arbScanner?.unbookmarkMarket(conditionId); }
    getBookmarkedOpportunities() { return this.arbScanner?.getBookmarkedOpportunities() || []; }
    async syncSportsAlpha() {
        if (!this.exchange || !this.sportsIntel)
            return;
        const matches = this.sportsIntel.getLiveMatches();
        for (const match of matches) {
            if (match.tokenIds?.[0]) {
                try {
                    match.marketPrice = await this.exchange.getMarketPrice(match.conditionId, match.tokenIds[0], 'BUY');
                }
                catch (e) { }
            }
        }
    }
}
