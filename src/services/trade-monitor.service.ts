import { RuntimeEnv } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import { TradeSignal } from '../domain/trade.types.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';

export type TradeMonitorDeps = {
  adapter: IExchangeAdapter;
  env: RuntimeEnv;
  logger: Logger;
  userAddresses: string[];
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

export class TradeMonitorService {
  private readonly deps: TradeMonitorDeps;
  private timer: any;
  
  // MEMORY OPTIMIZATION: Use Map<Hash, Timestamp> for LRU pruning
  private readonly processedHashes: Map<string, number> = new Map();
  private readonly lastFetchTime: Map<string, number> = new Map();
  private isPolling = false;

  constructor(deps: TradeMonitorDeps) {
    this.deps = deps;
  }

  // --- DYNAMIC CONFIG UPDATE ---
  updateTargets(newTargets: string[]) {
      this.deps.userAddresses = newTargets;
      this.deps.logger.info(`🎯 Monitor target list updated to ${newTargets.length} wallets.`);
  }

  async start(startCursor?: number): Promise<void> {
    const { logger, env } = this.deps;
    logger.info(
      `Initializing Monitor for ${this.deps.userAddresses.length} target wallets...`,
    );

    // Initialize cursor
    if (startCursor) {
        this.deps.userAddresses.forEach(trader => {
            this.lastFetchTime.set(trader, startCursor);
        });
    }
    
    // Initial sync
    await this.tick();
    
    // Polling Loop
    this.timer = setInterval(async () => {
        if (this.isPolling) return;
        this.isPolling = true;
        try {
            await this.tick();
        } catch (e: any) {
             // Silent retry
        } finally {
            this.isPolling = false;
        }
    }, env.fetchIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.isPolling = false;
  }

  private async tick(): Promise<void> {
    const { env } = this.deps;
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - Math.max(env.aggregationWindowSeconds, 600); 

    // Prune old hashes
    if (this.processedHashes.size > 2000) {
        for (const [hash, ts] of this.processedHashes.entries()) {
            if (ts < cutoffTime) {
                this.processedHashes.delete(hash);
            }
        }
    }
    
    // Process wallets in parallel chunks
    const chunkSize = 5; 
    for (let i = 0; i < this.deps.userAddresses.length; i += chunkSize) {
        const chunk = this.deps.userAddresses.slice(i, i + chunkSize);
        await Promise.all(chunk.map(trader => {
            if (!trader || trader.length < 10) return Promise.resolve();
            return this.fetchTraderActivities(trader, env, now, cutoffTime);
        }));
    }
  }

  private async fetchTraderActivities(trader: string, env: RuntimeEnv, now: number, cutoffTime: number): Promise<void> {
    try {
      // Use Adapter to fetch trades (Decoupled from specific API)
      const trades = await this.deps.adapter.fetchPublicTrades(trader, 20);

      if (!trades || !Array.isArray(trades)) return;

      for (const signal of trades) {
        // Validation logic
        const activityTime = signal.timestamp / 1000; // Convert back to seconds for logic
        
        if (activityTime < cutoffTime) continue;
        
        // Use a hash of unique properties since adapter might not return raw txHash in generic interface
        // But assuming signal generation is stable:
        const uniqueId = `${signal.marketId}-${signal.outcome}-${signal.price}-${signal.timestamp}`; 
        
        if (this.processedHashes.has(uniqueId)) continue;

        const lastTime = this.lastFetchTime.get(trader) || 0;
        if (activityTime <= lastTime) continue;

        this.deps.logger.info(`[SIGNAL] ${signal.side} ${signal.outcome} @ ${signal.price} ($${signal.sizeUsd.toFixed(0)}) from ${trader.slice(0,6)}`);

        this.processedHashes.set(uniqueId, activityTime);
        this.lastFetchTime.set(trader, Math.max(this.lastFetchTime.get(trader) || 0, activityTime));

        await this.deps.onDetectedTrade(signal);
      }
    } catch (err) {
       // Ignore
    }
  }
}