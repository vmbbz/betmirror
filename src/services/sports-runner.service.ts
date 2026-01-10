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
  lastPrice: number;
  verified: boolean;
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
    this.monitorInterval = setInterval(() => this.evaluateExits(), 3000);
    this.logger.info("🏃 Sports Runner: Snipe Engine Online.");
  }

  public stop() {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.activeScalps.clear();
  }

  private setupEvents() {
    this.intel.on('alphaEvent', (data) => this.handleSnipeEntry(data));
  }

  private async handleSnipeEntry(data: {
    match: SportsMatch;
    tokenId: string;
    outcomeIndex: number;
    newPrice: number;
    velocity: number;
  }) {
    const { match, tokenId, outcomeIndex, newPrice } = data;

    if (this.activeScalps.has(match.conditionId)) return;

    this.logger.success(`🎯 [FRONT-RUN] Velocity Spike on ${match.outcomes[outcomeIndex]}. Sniping stale liquidity...`);

    try {
      // EXECUTE IMMEDIATELY: Fill-or-Kill (FOK) only captures the stale price
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: 100, // Institutional snipe size
          side: Side.BUY,
          price: newPrice * 1.01, 
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
          targetPrice: priceFilled * 1.05, 
          startTime: Date.now(),
          shares: sharesFilled,
          lastPrice: priceFilled,
          verified: false
        });

        this.logger.info(`📈 [POSITION] Snipe filled @ $${priceFilled.toFixed(3)}. Starting verification timer...`);
      }
    } catch (e: any) {
      this.logger.error(`Snipe failed: ${e.message}`);
    }
  }

  private async evaluateExits() {
    if (this.activeScalps.size === 0) return;

    for (const [conditionId, scalp] of this.activeScalps.entries()) {
      const match = this.intel.getLiveMatches().find(m => m.conditionId === conditionId);
      if (!match) continue;

      const currentPrice = match.outcomePrices[scalp.outcomeIndex];
      const elapsed = (Date.now() - scalp.startTime) / 1000;

      // VERIFY SECOND: If score hasn't updated within 45s, inference was false
      if (!scalp.verified && elapsed > 45) {
          this.logger.warn(`⚠️ [VERIFY] No score change detected after 45s. False positive. Liquidating...`);
          await this.liquidate(conditionId, scalp, currentPrice, "FALSE INFERENCE");
          continue;
      }

      // 1. Target Reach
      if (currentPrice >= scalp.targetPrice) {
        await this.liquidate(conditionId, scalp, currentPrice, "TARGET HIT");
        continue;
      }

      // 2. Stop Loss
      if (currentPrice <= scalp.entryPrice * 0.96) {
        await this.liquidate(conditionId, scalp, currentPrice, "STOP LOSS");
        continue;
      }
    }
  }

  private async liquidate(conditionId: string, scalp: ActiveScalp, exitPrice: number, reason: string) {
    try {
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: scalp.tokenId,
          amount: scalp.shares, 
          side: Side.SELL,
          price: exitPrice * 0.99,
        },
        { tickSize: "0.01" },
        OrderType.FAK
      );

      if (result.success) {
        const pnl = (exitPrice - scalp.entryPrice) * scalp.shares;
        this.logger.success(`💰 [EXIT] PnL: $${pnl.toFixed(2)} | Reason: ${reason}`);
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