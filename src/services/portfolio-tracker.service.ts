import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { ActivePosition } from '../domain/trade.types.js';

export class PortfolioTrackerService {
  private allocatedCapital: number = 0;
  private positions: Map<string, number> = new Map(); // marketId -> positionValue

  private onPositionsUpdate?: (positions: ActivePosition[]) => void;

  constructor(
    private adapter: IExchangeAdapter,
    private walletAddress: string,
    private maxPortfolioAllocation: number,
    private logger: Logger,
    onPositionsUpdate?: (positions: ActivePosition[]) => void
  ) {
    this.onPositionsUpdate = onPositionsUpdate;
  }

  async initialize(): Promise<void> {
    await this.syncPositions();
  }

  async syncPositions(): Promise<void> {
    try {
      const positions = await this.adapter.getPositions(this.walletAddress);
      this.allocatedCapital = positions.reduce((sum, pos) => sum + (pos.valueUsd || 0), 0);
      
      // Update positions map
      this.positions = new Map(
        positions.map(pos => [pos.marketId, pos.valueUsd || 0])
      );
      
      this.logger.info(`[Portfolio] Synced ${positions.length} positions. Allocated: $${this.allocatedCapital.toFixed(2)}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to sync positions: ${errorMessage}`, error instanceof Error ? error : undefined);
      throw error instanceof Error ? error : new Error('Failed to sync positions');
    }
  }

  canAllocate(amount: number): { canAllocate: boolean; reason?: string; available?: number } {
    const totalAfterAllocation = this.allocatedCapital + amount;
    const available = Math.max(0, this.maxPortfolioAllocation - this.allocatedCapital);
    
    if (totalAfterAllocation > this.maxPortfolioAllocation) {
      return {
        canAllocate: false,
        reason: `Insufficient allocation. Requested: $${amount.toFixed(2)}, Available: $${available.toFixed(2)}`,
        available
      };
    }
    
    return { 
      canAllocate: true,
      available
    };
  }

  trackAllocation(marketId: string, amount: number): void {
    this.allocatedCapital += amount;
    const currentValue = this.positions.get(marketId) || 0;
    this.positions.set(marketId, currentValue + amount);
    
    this.logger.info(`[Portfolio] Tracked allocation: $${amount.toFixed(2)} for ${marketId}. ` +
      `Total allocated: $${this.allocatedCapital.toFixed(2)}`);
  }

  releaseAllocation(marketId: string, amount: number): void {
    const currentValue = this.positions.get(marketId) || 0;
    const newValue = currentValue - amount;
    
    if (newValue <= 0) {
      this.positions.delete(marketId);
      this.allocatedCapital -= currentValue;
    } else {
      this.positions.set(marketId, newValue);
      this.allocatedCapital -= amount;
    }
    
    this.logger.info(`[Portfolio] Released allocation: $${amount.toFixed(2)} from ${marketId}. ` +
      `Remaining allocated: $${this.allocatedCapital.toFixed(2)}`);
  }

  getAllocatedCapital(): number {
    return this.allocatedCapital;
  }

  getAvailableCapital(): number {
    return Math.max(0, this.maxPortfolioAllocation - this.allocatedCapital);
  }

  getPositionValue(marketId: string): number {
    return this.positions.get(marketId) || 0;
  }

  getActivePositions(): ActivePosition[] {
    return Array.from(this.positions.entries()).map(([marketId, valueUsd]) => ({
      tradeId: `tracker-${marketId}`,
      marketId,
      tokenId: '', // Will be updated when we have the actual token ID
      outcome: 'YES', // Default to 'YES', will be updated with actual data
      entryPrice: 0, // Will be updated when we have the actual entry price
      currentPrice: 0, // Will be updated with current market data
      shares: 0, // Will be updated with actual share count
      valueUsd,
      sizeUsd: valueUsd,
      lastUpdated: Date.now(),
      pnl: 0,
      pnlPercentage: 0,
      investedValue: valueUsd,
      autoCashout: undefined,
      timestamp: Date.now()
    }));
  }

  private async notifyPositionsUpdate() {
    if (this.onPositionsUpdate) {
      try {
        await this.onPositionsUpdate(this.getActivePositions());
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Error in positions update callback:', errorMessage);
      }
    }
  }
}
