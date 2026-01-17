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
  
  constructor(
    private marketIntelligence: MarketIntelligenceService,
    private config: FlashMoveConfig,
    private tradeExecutor: any, // Accept trade executor as dependency
    private logger: Logger
  ) {
    super();
    
    // Initialize components
    this.detectionEngine = new FlashDetectionEngine(config, logger);
    this.executionEngine = new FlashExecutionEngine(config, tradeExecutor, logger); // Inject trade executor at initialization
    this.riskManager = new FlashRiskManager(config, logger);
    
    // Setup WebSocket listeners
    this.setupWebSocketListeners();
    
    this.logger.info('🚀 Flash Move Service initialized');
  }
  
  /**
   * Enable/disable flash move service
   */
  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    this.logger.info(`🚀 Flash Move Service ${enabled ? 'ENABLED' : 'DISABLED'}`);
    
    if (!enabled) {
      // Close all active positions when disabled
      this.closeAllPositions('Service disabled');
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
      lastDetection: null, // Will be updated on next detection
      portfolioRisk
    };
  }
  
  /**
   * Setup WebSocket listeners for price and trade data
   */
  private setupWebSocketListeners(): void {
    // Listen to price updates from MarketIntelligenceService (event router)
    this.marketIntelligence.on('price_update', (event) => {
      this.handlePriceUpdate(event.asset_id, event.price);
    });
    
    // Listen to trade events from MarketIntelligenceService for volume analysis
    this.marketIntelligence.on('trade', (event) => {
      this.handleTradeEvent(event);
    });
  }
  
  /**
   * Handle price update events
   */
  private async handlePriceUpdate(tokenId: string, price: number): Promise<void> {
    if (!this.isEnabled) return;
    
    try {
      const flashMove = await this.detectionEngine.detectFlashMove(tokenId, price);
      
      if (flashMove) {
        await this.processFlashMove(flashMove);
      }
    } catch (error) {
      this.logger.error(`❌ Error processing price update for ${tokenId}: ${error}`);
    }
  }
  
  /**
   * Handle trade events for volume analysis
   */
  private async handleTradeEvent(event: any): Promise<void> {
    if (!this.isEnabled) return;
    
    try {
      // The detection engine will use volume data for enhanced detection
      await this.detectionEngine.detectFlashMove(
        event.token_id, 
        event.price, 
        event.size
      );
    } catch (error) {
      this.logger.error(`❌ Error processing trade event for ${event.token_id}: ${error}`);
    }
  }
  
  /**
   * Process detected flash move
   */
  private async processFlashMove(event: EnhancedFlashMoveEvent): Promise<void> {
    if (!this.isEnabled) return;
    
    try {
      // Assess risk
      const riskAssessment = await this.riskManager.assessRisk(event);
      
      // Skip if too risky
      if (riskAssessment.isTooRisky) {
        this.logger.warn(`⚠️ Flash move skipped - ${riskAssessment.reason}`);
        return;
      }
      
      // Execute flash move
      const result = await this.executionEngine.executeFlashMove(event, riskAssessment);
      
      // Persist to database
      await this.persistFlashMove(event, result);
      
      // Emit events for UI
      this.emit('flash_move_detected', {
        event,
        riskAssessment,
        result
      });
      
      if (result.success) {
        this.emit('flash_move_executed', {
          event,
          result,
          position: this.executionEngine.getActivePositions().get(event.tokenId)
        });
      }
      
      this.logger.info(`⚡ Flash move processed: ${result.strategy} strategy - ${result.success ? 'SUCCESS' : 'FAILED'}`);
      
    } catch (error) {
      this.logger.error(`❌ Error processing flash move for ${event.tokenId}: ${error}`);
    }
  }
  
  /**
   * Persist flash move to database
   */
  private async persistFlashMove(
    event: EnhancedFlashMoveEvent, 
    result: FlashMoveResult
  ): Promise<void> {
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
        // Additional fields for enhanced tracking
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
  
  /**
   * Get active flash positions
   */
  public getActivePositions(): Map<string, ActiveFlashPosition> {
    return this.executionEngine.getActivePositions();
  }
  
  /**
   * Close specific position
   */
  public async closePosition(tokenId: string, reason: string): Promise<void> {
    try {
      await this.executionEngine.closePosition(tokenId, reason);
      
      this.emit('position_closed', {
        tokenId,
        reason,
        timestamp: Date.now()
      });
      
      this.logger.info(`🎯 Position closed: ${tokenId} - ${reason}`);
    } catch (error) {
      this.logger.error(`❌ Failed to close position ${tokenId}: ${error}`);
    }
  }
  
  /**
   * Close all active positions
   */
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
  
  /**
   * Cleanup old data
   */
  public cleanup(): void {
    try {
      this.detectionEngine.cleanup();
      this.executionEngine.cleanup();
      this.riskManager.cleanup();
      
      this.logger.info('🧹 Flash Move Service cleanup completed');
    } catch (error) {
      this.logger.error(`❌ Error during cleanup: ${error}`);
    }
  }
}
