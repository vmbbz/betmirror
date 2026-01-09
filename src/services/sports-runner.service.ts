import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Logger } from '../utils/logger.util.js';
import { SportsIntelService, SportsMatch } from './sports-intel.service.js';
import EventEmitter from 'events';

interface ActiveScalp {
  matchId: string;
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
  private client: ClobClient;

  constructor(
    private intel: SportsIntelService,
    private logger: Logger,
    client: ClobClient
  ) {
    super();
    this.client = client;
    this.setupEvents();
  }

  public start() {
    this.monitorInterval = setInterval(() => this.evaluateExits(), 5000);
    this.logger.info("🏃 Sports Runner: Monitoring price spikes...");
  }

  public stop() {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
  }

  private setupEvents() {
    // Listen for price updates from SportsIntelService
    this.intel.on('priceUpdate', (data) => this.handlePriceSpike(data));
  }

  private async handlePriceSpike(data: {
    match: SportsMatch;
    outcome: string;
    oldPrice: number;
    newPrice: number;
    change: number;
  }) {
    const { match, outcome, oldPrice, newPrice, change } = data;

    // Only trigger on significant spikes (>8% move)
    if (Math.abs(change) < 0.08) return;

    // Prevent double entry
    if (this.activeScalps.has(match.conditionId)) return;

    // Find the token index for this outcome
    const outcomeIndex = match.outcomes.indexOf(outcome);
    if (outcomeIndex === -1) return;

    const tokenId = match.tokenIds[outcomeIndex];
    const direction = change > 0 ? 'SPIKE UP' : 'SPIKE DOWN';

    this.logger.info(`🎯 ${direction}: ${outcome} in ${match.question} | ${(change * 100).toFixed(1)}%`);

    // Only buy on upward spikes (inferred goal/event)
    if (change < 0.08) return;

    try {
      // Use FOK (Fill-Or-Kill) for immediate execution
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: 50, // $50 USD
          side: Side.BUY,
          price: newPrice * 1.02, // 2% slippage tolerance
        },
        { tickSize: "0.01" },
        OrderType.FOK
      );

      if (result.success) {
        const sharesFilled = parseFloat(result.takingAmount) / 1e6;
        const priceFilled = parseFloat(result.makingAmount) / parseFloat(result.takingAmount);

        this.activeScalps.set(match.conditionId, {
          matchId: match.id,
          conditionId: match.conditionId,
          tokenId,
          outcomeIndex,
          entryPrice: priceFilled,
          targetPrice: newPrice * 1.05, // 5% profit target
          startTime: Date.now(),
          shares: sharesFilled,
          stallTicks: 0,
          lastPrice: newPrice,
        });

        this.logger.success(`📈 POSITION OPEN: ${sharesFilled.toFixed(2)} shares @ ${priceFilled.toFixed(3)}`);
      } else {
        this.logger.warn(`❌ FOK REJECTED: ${result.errorMsg}`);
      }
    } catch (e: any) {
      this.logger.error(`Entry failed: ${e.message}`);
    }
  }

  private async evaluateExits() {
    for (const [conditionId, scalp] of this.activeScalps.entries()) {
      const match = this.intel.getLiveMatches().find(m => m.conditionId === conditionId);
      if (!match) continue;

      const currentPrice = match.outcomePrices[scalp.outcomeIndex];
      const elapsed = (Date.now() - scalp.startTime) / 1000;

      // 1. Target profit exit
      if (currentPrice >= scalp.targetPrice) {
        await this.liquidate(conditionId, scalp, currentPrice, "TARGET HIT");
        continue;
      }

      // 2. Momentum stall exit
      if (currentPrice <= scalp.lastPrice) {
        scalp.stallTicks++;
      } else {
        scalp.stallTicks = 0;
      }
      scalp.lastPrice = currentPrice;

      if (scalp.stallTicks >= 3 && elapsed > 30) {
        await this.liquidate(conditionId, scalp, currentPrice, "MOMENTUM STALL");
        continue;
      }

      // 3. Time stop (2 mins max hold)
      if (elapsed >= 120) {
        await this.liquidate(conditionId, scalp, currentPrice, "TIME STOP");
        continue;
      }

      // 4. Stop loss (-5%)
      if (currentPrice < scalp.entryPrice * 0.95) {
        await this.liquidate(conditionId, scalp, currentPrice, "STOP LOSS");
        continue;
      }
    }
  }

  private async liquidate(conditionId: string, scalp: ActiveScalp, exitPrice: number, reason: string) {
    this.logger.info(`🔄 EXIT (${reason}): Selling ${scalp.shares} shares...`);

    try {
      // Use FAK (Fill-And-Kill) to get best available price
      const result = await this.client.createAndPostMarketOrder(
        {
          tokenID: scalp.tokenId,
          amount: scalp.shares, // For SELL, amount = shares
          side: Side.SELL,
          price: exitPrice * 0.98, // 2% slippage tolerance
        },
        { tickSize: "0.01" },
        OrderType.FAK
      );

      if (result.success) {
        const pnl = (exitPrice - scalp.entryPrice) * scalp.shares;
        this.logger.success(`💰 CLOSED: PnL $${pnl.toFixed(2)} | Reason: ${reason}`);
        this.activeScalps.delete(conditionId);
      }
    } catch (e: any) {
      this.logger.error(`Liquidation failed: ${e.message}`);
    }
  }
}