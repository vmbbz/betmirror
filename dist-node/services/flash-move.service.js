import { EventEmitter } from 'events';
import { FlashMove } from '../database/index.js';
import { FlashDetectionEngine } from './flash-detection.service.js';
import { FlashExecutionEngine } from './flash-execution.service.js';
import { FlashRiskManager } from './flash-risk.service.js';
/**
 * Flash Move Service - Unified flash move detection and execution
 */
export class FlashMoveService extends EventEmitter {
    marketIntelligence;
    config;
    tradeExecutor;
    logger;
    isEnabled = false;
    detectionEngine;
    executionEngine;
    riskManager;
    // Bind listener references for clean removal (fixes memory leak)
    priceUpdateHandler;
    tradeEventHandler;
    sportsEventHandler;
    constructor(marketIntelligence, config, tradeExecutor, logger) {
        super();
        this.marketIntelligence = marketIntelligence;
        this.config = config;
        this.tradeExecutor = tradeExecutor;
        this.logger = logger;
        // Initialize components
        this.detectionEngine = new FlashDetectionEngine(config, logger);
        this.executionEngine = new FlashExecutionEngine(config, tradeExecutor, logger);
        this.riskManager = new FlashRiskManager(config, logger);
        // Prepare handlers for lifecycle management
        this.priceUpdateHandler = (event) => this.handlePriceUpdate(event.asset_id, event.price, undefined, event.best_bid, event.best_ask);
        this.tradeEventHandler = (event) => this.handleTradeEvent(event);
        this.sportsEventHandler = (event) => this.handleSportsEvent(event);
        this.logger.info('🚀 Flash Move Service initialized');
    }
    /**
     * Enable/disable flash move service
     */
    setEnabled(enabled) {
        this.isEnabled = enabled;
        if (enabled) {
            this.setupWebSocketListeners();
            this.logger.info(`🚀 Flash Move Service ENABLED`);
        }
        else {
            this.cleanupListeners();
            this.closeAllPositions('Service disabled');
            this.logger.info(`🚀 Flash Move Service DISABLED`);
        }
    }
    /**
     * Get current service status
     */
    getStatus() {
        const stats = this.executionEngine.getStats();
        const activePositions = this.executionEngine.getActivePositions();
        const portfolioRisk = this.riskManager.getPortfolioMetrics();
        return {
            isEnabled: this.isEnabled,
            activePositions: activePositions.size,
            totalExecuted: stats.total,
            successRate: stats.successRate,
            lastDetection: null,
            portfolioRisk
        };
    }
    /**
     * Setup WebSocket listeners for price and trade data
     */
    setupWebSocketListeners() {
        // CRITICAL: Remove existing to prevent duplication
        this.cleanupListeners();
        this.marketIntelligence.on('price_update', this.priceUpdateHandler);
        this.marketIntelligence.on('trade', this.tradeEventHandler);
        // Listen for global sports events (front-running logic)
        this.marketIntelligence.on('sports_score_update', this.sportsEventHandler);
    }
    /**
     * Remove event listeners from the shared intelligence singleton (Fixed memory leak)
     */
    cleanupListeners() {
        this.marketIntelligence.removeListener('price_update', this.priceUpdateHandler);
        this.marketIntelligence.removeListener('trade', this.tradeEventHandler);
        this.marketIntelligence.removeListener('sports_score_update', this.sportsEventHandler);
    }
    async handlePriceUpdate(tokenId, price, volume, bestBid, bestAsk) {
        if (!this.isEnabled)
            return;
        try {
            const flashMove = await this.detectionEngine.detectFlashMove(tokenId, price, volume, bestBid, bestAsk);
            if (flashMove)
                await this.processFlashMove(flashMove);
        }
        catch (error) {
            this.logger.error(`❌ Error processing price update for ${tokenId}: ${error}`);
        }
    }
    async handleTradeEvent(event) {
        if (!this.isEnabled)
            return;
        try {
            await this.detectionEngine.detectFlashMove(event.token_id, event.price, event.size);
        }
        catch (error) {
            this.logger.error(`❌ Error processing trade event for ${event.token_id}: ${error}`);
        }
    }
    /**
     * Front-runs price moves based on real-world sports events.
     */
    async handleSportsEvent(event) {
        if (!this.isEnabled)
            return;
        this.logger.info(`⚽ SPORTS TRIGGER: Score change for ${event.team}. Front-running price move on ${event.tokenId}`);
        // Create a synthetic flash move event based on news/score
        const syntheticEvent = {
            tokenId: event.tokenId,
            conditionId: event.conditionId,
            oldPrice: event.currentPrice,
            newPrice: event.currentPrice, // Price hasn't moved yet, that's why we snipe
            velocity: event.direction === 'UP' ? 0.05 : -0.05, // Expected move
            momentum: 0.1,
            volumeSpike: 1.0,
            confidence: 0.95, // Extremely high confidence on score change
            timestamp: Date.now(),
            question: event.marketQuestion,
            riskScore: 10, // News based snipes are low risk if fast
            strategy: 'sports-frontrun'
        };
        await this.processFlashMove(syntheticEvent);
    }
    async processFlashMove(event) {
        if (!this.isEnabled)
            return;
        try {
            const riskAssessment = await this.riskManager.assessRisk(event);
            if (riskAssessment.isTooRisky)
                return;
            // Execute with FAK to ensure speed
            const result = await this.executionEngine.executeFlashMove(event, riskAssessment);
            await this.persistFlashMove(event, result);
            this.emit('flash_move_detected', { event, riskAssessment, result });
            if (result.success) {
                this.emit('flash_move_executed', {
                    event,
                    result,
                    position: this.executionEngine.getActivePositions().get(event.tokenId)
                });
            }
        }
        catch (error) {
            this.logger.error(`❌ Error processing flash move for ${event.tokenId}: ${error}`);
        }
    }
    async persistFlashMove(event, result) {
        try {
            await FlashMove.create({
                tokenId: event.tokenId,
                conditionId: event.conditionId,
                oldPrice: event.oldPrice,
                newPrice: event.newPrice,
                velocity: event.velocity,
                timestamp: new Date(event.timestamp),
                question: event.question,
                image: event.image,
                marketSlug: event.marketSlug,
                confidence: event.confidence,
                strategy: event.strategy,
                riskScore: event.riskScore,
                executionResult: result.success,
                executionStrategy: result.strategy,
                executionTime: result.executionTime,
                slippage: result.slippage
            });
        }
        catch (error) {
            this.logger.error(`❌ Failed to persist flash move for ${event.tokenId}: ${error}`);
        }
    }
    getActivePositions() {
        return this.executionEngine.getActivePositions();
    }
    async closePosition(tokenId, reason) {
        try {
            await this.executionEngine.closePosition(tokenId, reason);
            this.emit('position_closed', { tokenId, reason, timestamp: Date.now() });
        }
        catch (error) {
            this.logger.error(`❌ Failed to close position ${tokenId}: ${error}`);
        }
    }
    async closeAllPositions(reason) {
        const activePositions = this.executionEngine.getActivePositions();
        for (const [tokenId] of activePositions.keys()) {
            try {
                await this.closePosition(tokenId, reason);
            }
            catch (error) {
                this.logger.error(`❌ Failed to close position ${tokenId}: ${error}`);
            }
        }
    }
    cleanup() {
        try {
            this.cleanupListeners();
            this.detectionEngine.cleanup();
            this.executionEngine.cleanup();
            this.riskManager.cleanup();
            this.logger.info('🧹 Flash Move Service cleanup completed');
        }
        catch (error) {
            this.logger.error(`❌ Error during cleanup: ${error}`);
        }
    }
}
