
import { RuntimeEnv } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import { TradeSignal } from '../domain/trade.types.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { MarketIntelligenceService, WhaleTradeEvent } from './market-intelligence.service.js';

/**
 * TradeMonitorDeps: Dependency injection container for the monitor.
 */
export type TradeMonitorDeps = {
  adapter: IExchangeAdapter;
  intelligence: MarketIntelligenceService; // Global Singleton for WebSockets
  env: RuntimeEnv;
  logger: Logger;
  userAddresses: string[];
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

/**
 * LOGIC LAYER: TradeMonitorService
 * 
 * Performance: O(1) Discovery.
 * This service monitors user trades via WebSocket for real-time fill tracking.
 * Whale tracking has been moved to GlobalWhalePollerService.
 * 
 * It handles user-specific trade events and converts them into executable TradeSignals.
 */
export class TradeMonitorService {
  private readonly deps: TradeMonitorDeps;
  private running = false;
  private targetWallets: Set<string> = new Set();
  
  /**
   * processedTrades: Cache to prevent duplicate trade processing.
   * Key: unique trade hash, Value: timestamp of processing.
   */
  private processedTrades: Map<string, number> = new Map();
  
  // Bound handler reference to allow clean removal of event listeners
  private boundHandler: (event: WhaleTradeEvent) => void;

  constructor(deps: TradeMonitorDeps) {
    this.deps = deps;
    this.updateTargets(deps.userAddresses);
    
    // Store bound handler reference to allow clean removal of event listeners
    this.boundHandler = (event: WhaleTradeEvent) => {
        this.handleUserTrade(event);
    };
  }

  /**
   * Returns the current operational status of the monitor.
   */
  public isActive(): boolean {
    return this.running;
  }

  /**
   * Synchronizes the local target list for user trade monitoring.
   * Note: Whale tracking is now handled by GlobalWhalePollerService.
   * 
   * @param newTargets Array of wallet addresses to monitor.
   */
  public updateTargets(newTargets: string[]) {
    this.deps.userAddresses = newTargets;
    this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
    
    // Note: No need to notify intelligence service for whale tracking anymore
    this.deps.logger.info(`🎯 Monitor targets synced: ${this.targetWallets.size} user wallets.`);
  }

  /**
   * Connects the monitor to the global intelligence event bus.
   */
  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.intelligence.on('whale_trade', this.boundHandler);
    this.deps.logger.info(`🔌 Signal Monitor: ONLINE.`);
  }

  public stop(): void {
    this.running = false;
    this.deps.intelligence.removeListener('whale_trade', this.boundHandler);
    this.processedTrades.clear();
  }

  /**
   * CORE LOGIC: handleUserTrade
   * 
   * This method handles user-specific trade events from WebSocket.
   * Note: Whale tracking is now handled by GlobalWhalePollerService using Data API.
   */
  private async handleUserTrade(event: WhaleTradeEvent) {
    if (!this.running) return;
    
    // Only process trades from our target wallets (user trades)
    if (!this.targetWallets.has(event.trader.toLowerCase())) return;

    const tradeKey = `${event.trader}-${event.tokenId}-${event.side}-${Math.floor(event.timestamp / 5000)}`;
    if (this.processedTrades.has(tradeKey)) return;
    
    this.processedTrades.set(tradeKey, Date.now());
    this.pruneCache();

    this.deps.logger.success(`🚨 [USER TRADE] ${event.trader.slice(0, 10)}... ${event.side} @ ${event.price}`);

    const signal: TradeSignal = {
      trader: event.trader,
      marketId: "resolved_by_adapter",
      tokenId: event.tokenId,
      outcome: "YES", 
      side: event.side as 'BUY' | 'SELL',
      sizeUsd: event.size * event.price,
      price: event.price,
      timestamp: event.timestamp
    };

    await this.deps.onDetectedTrade(signal);
  }

  /**
   * Memory Janitor: Cleans up the deduplication cache.
   */
  private pruneCache() {
    const now = Date.now();
    const TTL = 10 * 60 * 1000; // 10 minute cache window
    
    if (this.processedTrades.size > 2000) {
      for (const [key, ts] of this.processedTrades.entries()) {
        if (now - ts > TTL) {
          this.processedTrades.delete(key);
        }
      }
    }
  }
}
