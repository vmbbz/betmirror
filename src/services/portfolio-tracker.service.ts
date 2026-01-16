import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { ActivePosition } from '../domain/trade.types.js';
import { PositionMonitorService } from './position-monitor.service.js';
import { MarketMetadataService } from './market-metadata.service.js';

export class PortfolioTrackerService {
  private allocatedCapital: number = 0;
  private positions: Map<string, number> = new Map(); // marketId -> positionValue
  private positionTokenIds: Map<string, string> = new Map(); // marketId -> tokenId

  private onPositionsUpdate?: (positions: ActivePosition[]) => void;

  constructor(
    private adapter: IExchangeAdapter,
    private walletAddress: string,
    private maxPortfolioAllocation: number,
    private logger: Logger,
    private positionMonitor: PositionMonitorService,
    private marketMetadataService?: MarketMetadataService,
    onPositionsUpdate?: (positions: ActivePosition[]) => void
  ) {
    this.onPositionsUpdate = onPositionsUpdate;
    
    // Handle invalid positions from position monitor
    this.positionMonitor.onPositionInvalid = async (marketId, reason) => {
      await this.handleInvalidPosition(marketId, reason);
    };
  }

  async initialize(): Promise<void> {
    await this.syncPositions();
  }

  /**
   * Updates metadata for all positions, including closed ones
   */
  private async updateAllPositionsMetadata(positions: ActivePosition[]): Promise<void> {
    try {
      // Collect all unique market IDs
      const allMarketIds = new Set<string>();
      const activeMarketIds = new Set<string>();
      
      for (const position of positions) {
        allMarketIds.add(position.marketId);
        if (position.shares > 0) {
          activeMarketIds.add(position.marketId);
        }
      }
      
      this.logger.info(`[Portfolio] Updating metadata for ${allMarketIds.size} positions`);
      
      // Use MarketMetadataService for efficient batch retrieval
      if (this.marketMetadataService) {
        const marketMetadataMap = await this.marketMetadataService.getBatchMetadata(Array.from(allMarketIds));
        
        // Update metadata for all positions using cached data
        for (const [marketId, metadata] of marketMetadataMap) {
          try {
            // Update database with latest metadata
            await this.adapter.updatePositionMetadata(marketId, {
              question: metadata.question,
              image: metadata.image,
              isResolved: metadata.closed,
              acceptingOrders: metadata.acceptingOrders,
              marketSlug: metadata.marketSlug,
              eventSlug: metadata.eventSlug
            } as any);
            
            // If this is an active position, update the in-memory data
            if (activeMarketIds.has(marketId)) {
              const position = positions.find((p: ActivePosition) => p.marketId === marketId);
              if (position) {
                position.question = metadata.question;
                position.image = metadata.image;
                position.isResolved = metadata.closed;
              }
            }
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to update metadata for position ${marketId}: ${errorMessage}`, error instanceof Error ? error : undefined);
          }
        }
      } else {
        // Fallback to direct API calls if MarketMetadataService not available
        this.logger.warn('[Portfolio] MarketMetadataService not available, using direct API calls');
        
        for (const marketId of allMarketIds) {
          try {
            const marketData = await this.adapter.getMarketData(marketId);
            if (marketData) {
              await this.adapter.updatePositionMetadata(marketId, marketData);
              
              // If this is an active position, update the in-memory data
              if (activeMarketIds.has(marketId)) {
                const position = positions.find((p: ActivePosition) => p.marketId === marketId);
                if (position) {
                  position.question = marketData.question;
                  position.image = marketData.image;
                  position.isResolved = marketData.closed;
                }
              }
            }
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to update metadata for position ${marketId}: ${errorMessage}`, error instanceof Error ? error : undefined);
          }
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error in updateAllPositionsMetadata: ${errorMessage}`, error instanceof Error ? error : undefined);
    }
  }

  async syncPositions(forceMetadataUpdate = false): Promise<void> {
    try {
      // Get current positions from the exchange
      const positionData = await this.adapter.getPositions(this.walletAddress);
      
      // Convert PositionData[] to ActivePosition[]
      const activePositions: ActivePosition[] = positionData.map(posData => ({
        tradeId: `tracker-${posData.marketId}-${Date.now()}`,
        marketId: posData.marketId,
        conditionId: posData.conditionId,
        tokenId: posData.tokenId,
        outcome: posData.outcome as 'YES' | 'NO',
        entryPrice: posData.entryPrice,
        currentPrice: posData.currentPrice,
        shares: posData.balance,
        valueUsd: posData.valueUsd,
        sizeUsd: posData.investedValue || posData.valueUsd,
        pnl: posData.unrealizedPnL,
        pnlPercentage: posData.unrealizedPnLPercent,
        lastUpdated: Date.now(),
        timestamp: Date.now(),
        question: posData.question,
        image: posData.image,
        marketSlug: posData.marketSlug,
        eventSlug: posData.eventSlug,
        // Set default values for required fields
        investedValue: posData.investedValue || posData.valueUsd,
        // Add any additional fields from PositionData that map to ActivePosition
        ...(posData as any) // Spread any additional properties that might be present
      }));
      
      this.allocatedCapital = activePositions.reduce((sum, pos) => sum + (pos.valueUsd || 0), 0);
      
      // Update positions map and token ID mapping
      this.positions = new Map();
      this.positionTokenIds = new Map();
      
      for (const pos of activePositions) {
        this.positions.set(pos.marketId, pos.valueUsd || 0);
        if (pos.tokenId) {
          this.positionTokenIds.set(pos.marketId, pos.tokenId);
        }
      }
      
      // Update metadata for all positions, including closed ones
      await this.updateAllPositionsMetadata(activePositions);
      
      this.logger.info(`[Portfolio] Synced ${activePositions.length} positions. Allocated: $${this.allocatedCapital.toFixed(2)}`);
      
      // Notify listeners about the position update
      await this.notifyPositionsUpdate();
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

  /**
   * Handles cleanup when a position is detected as invalid (e.g., order book no longer exists)
   */
  private async handleInvalidPosition(marketId: string, reason: string): Promise<void> {
    const positionValue = this.positions.get(marketId) || 0;
    
    // Release the allocation for this position
    this.releaseAllocation(marketId, positionValue);
    
    // Clean up token ID mapping
    this.positionTokenIds.delete(marketId);
    
    this.logger.warn(
      `[Portfolio] Cleaned up invalid position: ${marketId}. ` +
      `Reason: ${reason}. Released: $${positionValue.toFixed(2)}`
    );
    
    // Notify listeners about the updated positions
    await this.notifyPositionsUpdate();
  }

  /**
   * Gets the token ID for a market if available
   */
  getTokenId(marketId: string): string | undefined {
    return this.positionTokenIds.get(marketId);
  }
}
