import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.util.js';
import { WebSocketManager } from './websocket-manager.service.js';
import { FlashMove, MoneyMarketOpportunity } from '../database/index.js';
import { 
  FlashDetectionEngine, 
  FlashMoveConfig, 
  EnhancedFlashMoveEvent 
} from './flash-detection.service.js';
import { 
  FlashExecutionEngine, 
  FlashMoveResult, 
  ActiveFlashPosition 
} from './flash-execution.service.js';
import { 
  FlashRiskManager, 
  RiskAssessment,
  PortfolioRiskMetrics 
} from './flash-risk.service.js';
import { MarketIntelligenceService } from './market-intelligence.service.js';
import { MarketMetadataService } from './market-metadata.service.js';
import axios from 'axios';

// Re-export interfaces for other services
export type { FlashMoveConfig, EnhancedFlashMoveEvent };
export type { FlashMoveResult, ActiveFlashPosition, RiskAssessment, PortfolioRiskMetrics };

/**
 * Flash move service status
 */
export interface FlashMoveServiceStatus {
  isEnabled: boolean;
  activePositions: number;
  totalExecuted: number;
  successRate: number;
  lastDetection: Date | null;
  portfolioRisk: PortfolioRiskMetrics;
}

/**
 * Flash Move Service - Unified flash move detection and execution
 */
export class FlashMoveService extends EventEmitter {
  private isEnabled = false;
  private detectionEngine: FlashDetectionEngine;
  private executionEngine: FlashExecutionEngine;
  private riskManager: FlashRiskManager;
  
  // Bind listener references for clean removal (fixes memory leak)
  private priceUpdateHandler: (event: any) => void;
  private tradeEventHandler: (event: any) => void;
  private sportsEventHandler: (event: any) => void;
  
  constructor(
    private marketIntelligence: MarketIntelligenceService,
    private config: FlashMoveConfig,
    private tradeExecutor: any,
    private logger: Logger,
    private marketMetadataService: MarketMetadataService
  ) {
    super();
    
    // Initialize components
    this.detectionEngine = new FlashDetectionEngine(config, logger, marketMetadataService);
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
  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    
    if (enabled) {
      this.setupWebSocketListeners();
      this.logger.info(`🚀 Flash Move Service ENABLED`);
    } else {
      this.cleanupListeners();
      this.closeAllPositions('Service disabled');
      this.logger.info(`🚀 Flash Move Service DISABLED`);
    }
  }
  
  /**
   * Get current service status
   */
  public getStatus(): FlashMoveServiceStatus {
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
  private setupWebSocketListeners(): void {
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
  private cleanupListeners(): void {
    this.marketIntelligence.removeListener('price_update', this.priceUpdateHandler);
    this.marketIntelligence.removeListener('trade', this.tradeEventHandler);
    this.marketIntelligence.removeListener('sports_score_update', this.sportsEventHandler);
  }
  
  private async handlePriceUpdate(tokenId: string, price: number, volume?: number, bestBid?: number, bestAsk?: number): Promise<void> {
    if (!this.isEnabled) return;
    try {
      const flashMove = await this.detectionEngine.detectFlashMove(tokenId, price, volume, bestBid, bestAsk);
      if (flashMove) await this.processFlashMove(flashMove);
    } catch (error) {
      this.logger.error(`❌ Error processing price update for ${tokenId}: ${error}`);
    }
  }
  
  private async handleTradeEvent(event: any): Promise<void> {
    if (!this.isEnabled) return;
    try {
      await this.detectionEngine.detectFlashMove(event.token_id, event.price, event.size);
    } catch (error) {
      this.logger.error(`❌ Error processing trade event for ${event.token_id}: ${error}`);
    }
  }

  /**
   * Front-runs price moves based on real-world sports events.
   */
  private async handleSportsEvent(event: any): Promise<void> {
    if (!this.isEnabled) return;
    this.logger.info(`⚽ SPORTS TRIGGER: Score change for ${event.team}. Front-running price move on ${event.tokenId}`);
    
    // Create a synthetic flash move event based on news/score
    const syntheticEvent: EnhancedFlashMoveEvent = {
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
  
  private async processFlashMove(event: EnhancedFlashMoveEvent): Promise<void> {
    if (!this.isEnabled) return;
    try {
      const riskAssessment = await this.riskManager.assessRisk(event);
      if (riskAssessment.isTooRisky) return;
      
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
    } catch (error) {
      this.logger.error(`❌ Error processing flash move for ${event.tokenId}: ${error}`);
    }
  }
  
  private async persistFlashMove(event: EnhancedFlashMoveEvent, result: FlashMoveResult): Promise<void> {
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
    } catch (error) {
      this.logger.error(`❌ Failed to persist flash move for ${event.tokenId}: ${error}`);
    }
  }
  
  public getActivePositions(): Map<string, ActiveFlashPosition> {
    return this.executionEngine.getActivePositions();
  }
  
  public async closePosition(tokenId: string, reason: string): Promise<void> {
    try {
      await this.executionEngine.closePosition(tokenId, reason);
      this.emit('position_closed', { tokenId, reason, timestamp: Date.now() });
    } catch (error) {
      this.logger.error(`❌ Failed to close position ${tokenId}: ${error}`);
    }
  }
  
  private async closeAllPositions(reason: string): Promise<void> {
    const activePositions = this.executionEngine.getActivePositions();
    for (const [tokenId] of activePositions.keys()) {
      try {
        await this.closePosition(tokenId, reason);
      } catch (error) {
        this.logger.error(`❌ Failed to close position ${tokenId}: ${error}`);
      }
    }
  }
  
  public cleanup(): void {
    try {
      this.cleanupListeners();
      this.detectionEngine.cleanup();
      this.executionEngine.cleanup();
      this.riskManager.cleanup();
      this.logger.info('🧹 Flash Move Service cleanup completed');
    } catch (error) {
      this.logger.error(`❌ Error during cleanup: ${error}`);
    }
  }
}
