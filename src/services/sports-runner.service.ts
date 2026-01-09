
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Logger } from '../utils/logger.util.js';
import { SportsIntelService, SportsMatch } from './sports-intel.service.js';
import EventEmitter from 'events';

interface ActiveScalp {
  conditionId: string;
  tokenId: string;
  outcomeIndex: number;
  entryPrice: number;
  targetPrice: number;
  startTime: number;
  shares: number;
  stallTicks: number;
  lastPrice: number;
}

export class SportsRunnerService extends EventEmitter {
  private activeScalps: Map<string, ActiveScalp> = new Map();
  private monitorInterval?: NodeJS.Timeout;

  constructor(
    private intel: SportsIntelService,
    private logger: Logger,
    private client: ClobClient
  ) {
    super();
    this.setupEvents();
  }

  public start() {
    this.monitorInterval = setInterval(() => this.evaluateExits(), 5000);
    this.logger.info("🏃 Sports Runner: Cloud Snipe Engine Online.");
  }

  public stop() {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.activeScalps.clear();
  }

  private setupEvents() {
    this.intel.on('inferredEvent', (data) => this.handleSpikeEntry(data));
  }

  private async handleSpikeEntry(data: {
    match: SportsMatch;
    tokenId: string;
    outcomeIndex: number;
    newPrice: number;
    velocity: number;
  }) {
    const { match, tokenId, outcomeIndex, newPrice, velocity } = data;

    // Sniping only on upward momentum (inferred event)
    if (velocity < 0.08) return;
    if (this.activeScalps.has(match.conditionId)) return;

    this.logger.success(`🎯 [ALPHA WINDOW] Edge Detected for ${match.outcomes[outcomeIndex]}. Sweeping stale book...`);

    try {
      // ENTER FIRST: Use Fill-Or-Kill (FOK) to ensure we only get the stale price
      // Size fixed at $100 for sniping window
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: 100, 
          side: Side.BUY,
          price: newPrice * 1.02, // 2% slippage buffer
        },
        { tickSize: "0.01" },
        OrderType.FOK
      );

      if (result.success) {
        const sharesFilled = parseFloat(result.takingAmount) / 1e6;
        const priceFilled = parseFloat(result.makingAmount) / parseFloat(result.takingAmount);

        this.activeScalps.set(match.conditionId, {
          conditionId: match.conditionId,
          tokenId,
          outcomeIndex,
          entryPrice: priceFilled,
          targetPrice: priceFilled * 1.05, // 5% profit target
          startTime: Date.now(),
          shares: sharesFilled,
          stallTicks: 0,
          lastPrice: priceFilled,
        });

        this.logger.info(`📈 [CAPTURE] Snipe active. Target: $${(priceFilled * 1.05).toFixed(2)}`);
      } else {
        this.logger.warn(`❌ Snipe Rejected (Price Moved): ${result.errorMsg}`);
      }
    } catch (e: any) {
      this.logger.error(`Scalp entry failed: ${e.message}`);
    }
  }

  private async evaluateExits() {
    if (this.activeScalps.size === 0) return;

    for (const [conditionId, scalp] of this.activeScalps.entries()) {
      const match = this.intel.getLiveMatches().find(m => m.conditionId === conditionId);
      if (!match) continue;

      const currentPrice = match.outcomePrices[scalp.outcomeIndex];
      const elapsed = (Date.now() - scalp.startTime) / 1000;

      // 1. Profit Target reached
      if (currentPrice >= scalp.targetPrice) {
        await this.liquidate(conditionId, scalp, currentPrice, "TARGET HIT");
        continue;
      }

      // 2. Momentum stall (3 ticks no movement)
      if (currentPrice <= scalp.lastPrice) {
        scalp.stallTicks++;
      } else {
        scalp.stallTicks = 0;
      }
      scalp.lastPrice = currentPrice;

      if (scalp.stallTicks >= 3 && elapsed > 20) {
        await this.liquidate(conditionId, scalp, currentPrice, "MOMENTUM STALL");
        continue;
      }

      // 3. Hard Stop Loss (-5%)
      if (currentPrice <= scalp.entryPrice * 0.95) {
        await this.liquidate(conditionId, scalp, currentPrice, "STOP LOSS");
        continue;
      }

      // 4. Time Stop (120s max hold for sports scalp)
      if (elapsed >= 120) {
        await this.liquidate(conditionId, scalp, currentPrice, "TIME STOP");
        continue;
      }
    }
  }

  private async liquidate(conditionId: string, scalp: ActiveScalp, exitPrice: number, reason: string) {
    this.logger.info(`🔄 [EXIT] ${reason} for ${conditionId}. Liquidating via FAK...`);

    try {
      // Use FAK (Fill-And-Kill) to capture all available liquidity at the floor
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: scalp.tokenId,
          amount: scalp.shares, 
          side: Side.SELL,
          price: exitPrice * 0.98, // 2% slippage tolerance
        },
        { tickSize: "0.01" },
        OrderType.FAK
      );

      if (result.success) {
        const pnl = (exitPrice - scalp.entryPrice) * scalp.shares;
        this.logger.success(`💰 [COMPLETE] PnL: $${pnl.toFixed(2)} | Reason: ${reason}`);
        this.activeScalps.delete(conditionId);
      }
    } catch (e: any) {
      this.logger.error(`Liquidation failed: ${e.message}`);
    }
  }

  public getActiveChases(): any[] {
      return Array.from(this.activeScalps.values());
  }
}
