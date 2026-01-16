import { Logger } from '../utils/logger.util.js';
import { TradeExecutorService } from './trade-executor.service.js';
import { FlashMoveConfig, EnhancedFlashMoveEvent } from './flash-detection.service.js';

/**
 * Flash move execution strategies
 */
export type ExecutionStrategy = 'aggressive' | 'conservative' | 'adaptive';

/**
 * Flash move execution result
 */
export interface FlashMoveResult {
  success: boolean;
  orderId?: string;
  sharesFilled?: number;
  priceFilled?: number;
  errorMsg?: string;
  strategy: string;
  executionTime: number;
  slippage?: number;
}

/**
 * Risk assessment result
 */
export interface RiskAssessment {
  isTooRisky: boolean;
  reason: string;
  riskScore: number;
  recommendedStrategy: ExecutionStrategy;
  positionSize: number;
  maxSlippage: number;
}

/**
 * Position tracking for active flash moves
 */
export interface ActiveFlashPosition {
  tokenId: string;
  conditionId: string;
  entryPrice: number;
  currentPrice?: number;
  shares: number;
  direction: 'BUY' | 'SELL';
  strategy: string;
  timestamp: number;
  stopLoss?: number;
  takeProfit?: number;
}

/**
 * Flash Execution Engine - Smart execution with risk management
 */
export class FlashExecutionEngine {
  private activePositions: Map<string, ActiveFlashPosition> = new Map();
  private executionCount = 0;
  private successCount = 0;
  
  constructor(
    private config: FlashMoveConfig,
    private tradeExecutor: TradeExecutorService,
    private logger: Logger
  ) {}
  
  /**
   * Execute flash move with intelligent strategy selection
   */
  public async executeFlashMove(
    event: EnhancedFlashMoveEvent,
    riskAssessment: RiskAssessment
  ): Promise<FlashMoveResult> {
    const startTime = Date.now();
    
    try {
      // Check kill switch
      if (this.config.enableVolatilityKillSwitch && event.riskScore > 90) {
        return {
          success: false,
          errorMsg: `Kill switch triggered - Risk score: ${event.riskScore}`,
          strategy: 'killed',
          executionTime: Date.now() - startTime
        };
      }
      
      // Check concurrent trade limit
      if (this.activePositions.size >= this.config.maxConcurrentTrades) {
        return {
          success: false,
          errorMsg: `Max concurrent trades reached (${this.activePositions.size})`,
          strategy: 'limited',
          executionTime: Date.now() - startTime
        };
      }
      
      // Select execution strategy
      const strategy = this.selectStrategy(event, riskAssessment);
      
      // Calculate position parameters
      const positionParams = this.calculatePositionParameters(event, riskAssessment, strategy);
      
      // Execute the trade
      const result = await this.executeTrade(positionParams, strategy);
      
      if (result.success) {
        // Track active position
        this.trackPosition(event, result, strategy);
        this.successCount++;
        
        this.logger.info(`⚡ FLASH EXECUTED: ${strategy} strategy on ${event.question || event.tokenId} - Order: ${result.orderId}`);
      } else {
        this.executionCount++;
      }
      
      return {
        ...result,
        strategy,
        executionTime: Date.now() - startTime
      };
      
    } catch (error: any) {
      this.executionCount++;
      this.logger.error(`❌ Flash execution failed: ${error}`);
      
      return {
        success: false,
        errorMsg: error.message || error.toString(),
        strategy: 'error',
        executionTime: Date.now() - startTime
      };
    }
  }
  
  /**
   * Select optimal execution strategy based on event and risk
   */
  private selectStrategy(
    event: EnhancedFlashMoveEvent,
    riskAssessment: RiskAssessment
  ): ExecutionStrategy {
    // Use configured preference if not adaptive
    if (this.config.preferredStrategy !== 'adaptive') {
      return this.config.preferredStrategy;
    }
    
    // Adaptive strategy selection
    if (event.confidence > 0.8) {
      return 'aggressive'; // High confidence = aggressive execution
    } else if (event.riskScore < 30) {
      return 'conservative'; // Low risk = conservative execution
    } else {
      return 'adaptive'; // Balanced approach
    }
  }
  
  /**
   * Calculate position parameters based on strategy and risk
   */
  private calculatePositionParameters(
    event: EnhancedFlashMoveEvent,
    riskAssessment: RiskAssessment,
    strategy: ExecutionStrategy
  ): {
    direction: 'BUY' | 'SELL';
    size: number;
    priceLimit: number;
    orderType: 'FAK' | 'FOK' | 'GTC';
  } {
    const direction = event.velocity > 0 ? 'BUY' : 'SELL';
    
    // Calculate position size based on risk and confidence
    let size = this.config.baseTradeSize;
    
    if (strategy === 'conservative') {
      size = size * 0.5; // Smaller size for conservative
    } else if (strategy === 'aggressive') {
      size = size * 1.5; // Larger size for aggressive
    }
    
    // Adjust size based on confidence
    size = size * (0.5 + event.confidence * 0.5);
    
    // Adjust size based on risk score
    if (riskAssessment.riskScore > 50) {
      size = size * 0.7; // Reduce size for high risk
    }
    
    // Calculate aggressive pricing
    let priceLimit: number;
    
    if (strategy === 'aggressive') {
      // More aggressive pricing for faster execution
      priceLimit = direction === 'BUY'
        ? Math.min(0.99, event.newPrice * 1.02)
        : Math.max(0.01, event.newPrice * 0.98);
    } else if (strategy === 'conservative') {
      // Conservative pricing
      priceLimit = direction === 'BUY'
        ? Math.min(0.99, event.newPrice * 1.01)
        : Math.max(0.01, event.newPrice * 0.99);
    } else {
      // Adaptive pricing based on volatility
      const volatilityAdjustment = Math.min(event.riskScore / 100, 0.02);
      priceLimit = direction === 'BUY'
        ? Math.min(0.99, event.newPrice * (1 + volatilityAdjustment))
        : Math.max(0.01, event.newPrice * (1 - volatilityAdjustment));
    }
    
    // Select order type based on strategy
    let orderType: 'FAK' | 'FOK' | 'GTC' = 'FAK'; // Default to Fill-And-Kill
    
    if (strategy === 'conservative') {
      orderType = 'FOK'; // Fill-Or-Kill for conservative
    } else if (strategy === 'adaptive') {
      orderType = event.confidence > 0.7 ? 'FAK' : 'FOK';
    }
    
    return {
      direction,
      size,
      priceLimit,
      orderType
    };
  }
  
  /**
   * Execute the actual trade
   */
  private async executeTrade(
    params: {
      direction: 'BUY' | 'SELL';
      size: number;
      priceLimit: number;
      orderType: 'FAK' | 'FOK' | 'GTC';
    },
    strategy: ExecutionStrategy
  ): Promise<FlashMoveResult> {
    const startTime = Date.now();
    
    const result = await this.tradeExecutor.createOrder({
      marketId: '', // Will be set by caller
      tokenId: '', // Will be set by caller
      outcome: params.direction === 'BUY' ? 'YES' : 'NO',
      side: params.direction,
      priceLimit: params.priceLimit,
      sizeUsd: params.size,
      orderType: params.orderType
    });
    
    return {
      success: result?.success || false,
      orderId: result?.orderId,
      sharesFilled: result?.sharesFilled,
      priceFilled: result?.priceFilled,
      errorMsg: result?.error,
      slippage: result?.priceFilled ? Math.abs(params.priceLimit - result.priceFilled) / params.priceLimit : undefined,
      strategy,
      executionTime: Date.now() - startTime
    };
  }
  
  /**
   * Track active position for management
   */
  private trackPosition(
    event: EnhancedFlashMoveEvent,
    result: FlashMoveResult,
    strategy: ExecutionStrategy
  ): void {
    if (!result.success || !result.orderId) return;
    
    const position: ActiveFlashPosition = {
      tokenId: event.tokenId,
      conditionId: event.conditionId,
      entryPrice: result.priceFilled || event.newPrice,
      shares: result.sharesFilled || 0,
      direction: event.velocity > 0 ? 'BUY' : 'SELL',
      strategy,
      timestamp: Date.now()
    };
    
    // Calculate stop loss and take profit
    if (position.direction === 'BUY') {
      position.takeProfit = position.entryPrice * (1 + this.config.takeProfitPercent);
      position.stopLoss = position.entryPrice * (1 - this.config.stopLossPercent);
    } else {
      position.takeProfit = position.entryPrice * (1 - this.config.takeProfitPercent);
      position.stopLoss = position.entryPrice * (1 + this.config.stopLossPercent);
    }
    
    this.activePositions.set(event.tokenId, position);
  }
  
  /**
   * Get active positions
   */
  public getActivePositions(): Map<string, ActiveFlashPosition> {
    return new Map(this.activePositions);
  }
  
  /**
   * Close position (for take profit/stop loss)
   */
  public async closePosition(tokenId: string, reason: string): Promise<void> {
    const position = this.activePositions.get(tokenId);
    if (!position) return;
    
    try {
      const direction = position.direction === 'BUY' ? 'SELL' : 'BUY';
      
      await this.tradeExecutor.createOrder({
        marketId: position.conditionId,
        tokenId: position.tokenId,
        outcome: position.direction === 'BUY' ? 'YES' : 'NO',
        side: direction,
        sizeUsd: position.shares * (position.currentPrice || position.entryPrice),
        orderType: 'GTC'
      });
      
      this.logger.info(`🎯 POSITION CLOSED: ${reason} for ${tokenId}`);
      this.activePositions.delete(tokenId);
      
    } catch (error) {
      this.logger.error(`❌ Failed to close position ${tokenId}: ${error}`);
    }
  }
  
  /**
   * Get execution statistics
   */
  public getStats(): { total: number; successful: number; successRate: number } {
    return {
      total: this.executionCount,
      successful: this.successCount,
      successRate: this.executionCount > 0 ? (this.successCount / this.executionCount) * 100 : 0
    };
  }
  
  /**
   * Cleanup old positions
   */
  public cleanup(): void {
    const now = Date.now();
    const cutoff = now - 300000; // 5 minutes
    
    for (const [tokenId, position] of this.activePositions.entries()) {
      if (position.timestamp < cutoff) {
        this.activePositions.delete(tokenId);
        this.logger.warn(`🧹 Cleaned up expired position for ${tokenId}`);
      }
    }
  }
}
