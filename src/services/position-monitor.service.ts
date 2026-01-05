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

  constructor(
    private adapter: IExchangeAdapter,
    private walletAddress: string,
    private config: PositionMonitorConfig,
    private logger: Logger,
    private onAutoCashout: (position: ActivePosition, reason: string) => Promise<void>
  ) {}

  async startMonitoring(position: ActivePosition): Promise<void> {
    this.stopMonitoring(position.marketId);
    
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
}
