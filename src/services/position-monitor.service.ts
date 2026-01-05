import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { ActivePosition } from '../domain/trade.types.js';

export interface PositionMonitorConfig {
  checkInterval: number; // ms
  priceCheckInterval: number; // ms
}

export interface AutoCashoutConfig {
  enabled: boolean;
  percentage: number;
  destinationAddress?: string;
}

export class PositionMonitorService {
  private positionMonitors: Map<string, NodeJS.Timeout> = new Map();
  private priceCheckers: Map<string, NodeJS.Timeout> = new Map();
  private activePositions: Map<string, ActivePosition> = new Map();
  private orderBookValidationInterval?: NodeJS.Timeout;
  public onPositionInvalid?: (marketId: string, reason: string) => Promise<void>;

  constructor(
    private adapter: IExchangeAdapter,
    private walletAddress: string,
    private config: PositionMonitorConfig & { orderBookValidationInterval?: number },
    private logger: Logger,
    private onAutoCashout: (position: ActivePosition, reason: string) => Promise<void>,
    onPositionInvalid?: (marketId: string, reason: string) => Promise<void>
  ) {
    this.onPositionInvalid = onPositionInvalid;
    // Start order book validation if interval is configured
    if (this.config.orderBookValidationInterval) {
      this.startOrderBookValidation();
    }
  }

  async startMonitoring(position: ActivePosition): Promise<void> {
    this.stopMonitoring(position.marketId);
    
    // First verify the order book exists
    try {
      const orderBookExists = await this.validateOrderBookExists(position.tokenId);
      if (!orderBookExists) {
        throw new Error(`No order book exists for token ${position.tokenId}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to verify order book';
      this.logger.error(`[Monitor] Cannot monitor position ${position.marketId}: ${errorMessage}`);
      throw new Error(`Cannot monitor position: ${errorMessage}`);
    }
    
    // Store the position
    this.activePositions.set(position.marketId, position);
    
    // Start position value monitoring
    const monitor = setInterval(async () => {
      try {
        await this.checkPosition(position);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error monitoring position ${position.marketId}: ${errorMessage}`);
      }
    }, this.config.checkInterval);

    this.positionMonitors.set(position.marketId, monitor);
    this.logger.info(`[Monitor] Started monitoring position: ${position.marketId}`);

    // Start price checking if auto-cashout is enabled
    if (position.autoCashout?.enabled) {
      this.startPriceChecker(position);
    }
  }

  private startPriceChecker(position: ActivePosition): void {
    this.stopPriceChecker(position.marketId);

    const checker = setInterval(async () => {
      try {
        const currentPrice = await this.adapter.getCurrentPrice(position.tokenId);
        await this.checkAutoCashout(position, currentPrice);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error checking price for ${position.marketId}: ${errorMessage}`);
      }
    }, this.config.priceCheckInterval);

    this.priceCheckers.set(position.marketId, checker);
    this.logger.info(`[Monitor] Started price checker for: ${position.marketId}`);
  }

  private async checkPosition(position: ActivePosition): Promise<void> {
    try {
      // Refresh position data
      const updatedPositions = await this.adapter.getPositions(this.walletAddress);
      const updatedPosition = updatedPositions.find(p => 
        p.marketId === position.marketId && 
        p.outcome === position.outcome
      ) as ActivePosition | undefined;
      
      if (!updatedPosition) {
        this.logger.info(`[Monitor] Position closed: ${position.marketId}`);
        this.stopMonitoring(position.marketId);
        return;
      }
      
      // Update position data
      this.activePositions.set(position.marketId, {
        ...position,
        ...updatedPosition
      });
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error checking position ${position.marketId}: ${errorMessage}`, error instanceof Error ? error : undefined);
    }
  }

  private async checkAutoCashout(position: ActivePosition, currentPrice: number): Promise<void> {
    if (!position.autoCashout?.enabled || !position.entryPrice) return;

    const priceChangePct = Math.abs((currentPrice - position.entryPrice) / position.entryPrice);
    const targetPct = position.autoCashout.percentage / 100;
    
    if (priceChangePct >= targetPct) {
      const direction = currentPrice > position.entryPrice ? 'profit' : 'loss';
      this.logger.info(`[Auto-Cashout] Triggered for ${position.marketId}: ` +
        `Price changed ${(priceChangePct * 100).toFixed(2)}% ` +
        `(threshold: ${position.autoCashout?.percentage}%, Direction: ${direction})`);
      
      await this.onAutoCashout(position, `auto_cashout_${direction}`);
      this.stopMonitoring(position.marketId);
    }
  }

  stopMonitoring(marketId: string): void {
    // Clear position monitor
    const monitor = this.positionMonitors.get(marketId);
    if (monitor) {
      clearInterval(monitor);
      this.positionMonitors.delete(marketId);
      this.logger.info(`[Monitor] Stopped monitoring position: ${marketId}`);
    }
    
    // Clear price checker
    this.stopPriceChecker(marketId);
    
    // Remove from active positions
    this.activePositions.delete(marketId);
  }

  private stopPriceChecker(marketId: string): void {
    const checker = this.priceCheckers.get(marketId);
    if (checker) {
      clearInterval(checker);
      this.priceCheckers.delete(marketId);
      this.logger.info(`[Monitor] Stopped price checker for: ${marketId}`);
    }
  }

  stopAll(): void {
    for (const [marketId] of this.positionMonitors) {
      this.stopMonitoring(marketId);
    }
  }

  getActivePositions(): ActivePosition[] {
    return Array.from(this.activePositions.values());
  }

  private async validateOrderBookExists(tokenId: string): Promise<boolean> {
    try {
      // Just try to get the order book - we don't need the actual data
      await this.adapter.getOrderBook(tokenId);
      return true;
    } catch (error: any) {
      // Check if this is a 404 error for missing order book
      if (error.response?.status === 404 || 
          error.message?.includes('No orderbook exists') || 
          error.message?.includes('404')) {
        return false;
      }
      // For other errors, assume the order book exists but there was a different issue
      return true;
    }
  }

  private async cleanupInvalidPositions(): Promise<void> {
    const positionsToRemove: string[] = [];
    
    // Check each active position
    for (const [marketId, position] of this.activePositions.entries()) {
      try {
        const orderBookExists = await this.validateOrderBookExists(position.tokenId);
        if (!orderBookExists) {
          this.logger.warn(`[Monitor] Order book not found for position: ${marketId}, cleaning up...`);
          positionsToRemove.push(marketId);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`[Monitor] Error validating order book for ${marketId}: ${errorMessage}`);
      }
    }

    // Clean up invalid positions
    for (const marketId of positionsToRemove) {
      await this.handleInvalidPosition(marketId, 'Order book no longer exists');
    }
  }

  private async handleInvalidPosition(marketId: string, reason: string): Promise<void> {
    const position = this.activePositions.get(marketId);
    if (!position) return;

    // Notify about the invalid position
    if (this.onPositionInvalid) {
      await this.onPositionInvalid(marketId, reason).catch(err => {
        this.logger.error(`[Monitor] Error in onPositionInvalid callback: ${err.message}`);
      });
    }

    // Stop monitoring and clean up
    this.stopMonitoring(marketId);
    this.activePositions.delete(marketId);
    this.logger.info(`[Monitor] Removed invalid position: ${marketId} - ${reason}`);
  }

  private startOrderBookValidation(): void {
    if (this.orderBookValidationInterval) {
      clearInterval(this.orderBookValidationInterval);
    }

    // Default to 1 hour if not specified
    const interval = this.config.orderBookValidationInterval || 60 * 60 * 1000;
    
    this.orderBookValidationInterval = setInterval(async () => {
      try {
        await this.cleanupInvalidPositions();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`[Monitor] Error during order book validation: ${errorMessage}`);
      }
    }, interval);

    this.logger.info(`[Monitor] Started order book validation with ${interval/1000}s interval`);
  }
}
