
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
 * This service used to poll the Polymarket Activity API for every followed whale.
 * It has been refactored to subscribe to the MarketIntelligenceService Singleton.
 * 
 * It filters the global "trades" firehose for specific targets, deduplicates 
 * stuttering socket events, and converts raw trade data into executable TradeSignals.
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
        this.handleWhaleSignal(event);
    };
  }

  /**
   * Returns the current operational status of the monitor.
   */
  public isActive(): boolean {
    return this.running;
  }

  /**
   * Synchronizes the local target list and notifies the global Intelligence Singleton
   * to expand its filtering set.
   * 
   * @param newTargets Array of wallet addresses to monitor.
   */
  public updateTargets(newTargets: string[]) {
    this.deps.userAddresses = newTargets;
    this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
    
    // Notify the Singleton to update the global WebSocket filter
    this.deps.intelligence.updateWatchlist(newTargets);
    this.deps.logger.info(`🎯 Monitor targets synced. Bot is now following ${this.targetWallets.size} specific whales.`);
  }

  /**
   * Connects the monitor to the global intelligence event bus.
   */
  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.intelligence.on('whale_trade', this.boundHandler);
    this.deps.logger.info(`🔌 Signal Monitor: ONLINE. Tracking ${this.targetWallets.size} targets.`);
  }

  public stop(): void {
    this.running = false;
    this.deps.intelligence.removeListener('whale_trade', this.boundHandler);
    this.processedTrades.clear();
  }

  /**
   * CORE LOGIC: handleWhaleSignal
   * 
   * This method replaces the legacy 'checkUserActivity' polling. 
   * It is triggered instantly when the MarketIntelligence Singleton detects a 
   * trade from a whale on the global WebSocket.
   */
  private async handleWhaleSignal(event: WhaleTradeEvent) {
    if (!this.running) return;
    
    // Normalization check
    if (!this.targetWallets.has(event.trader.toLowerCase())) return;

    const tradeKey = `${event.trader}-${event.tokenId}-${event.side}-${Math.floor(event.timestamp / 5000)}`;
    if (this.processedTrades.has(tradeKey)) return;
    
    this.processedTrades.set(tradeKey, Date.now());
    this.pruneCache();

    // FIXED: Added explicit dashboard log for visual feedback
    this.deps.logger.info(`🚨 [WHALE MATCH] ${event.trader.slice(0, 10)}... traded ${event.side} @ ${event.price}`);

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
   * Keeps the server memory footprint low even during high-frequency trading.
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

  /**
   * LEGACY COMPATIBILITY: The following methods are preserved but effectively
   * bypassed by the high-performance WebSocket implementation.
   */
  private async checkUserActivity(user: string) {
      // Logic moved to handleWhaleSignal via push events
      this.deps.logger.debug(`Legacy polling bypassed for ${user}. WebSocket active.`);
  }

  private async processTrade(user: string, activity: any) {
      // Logic moved to handleWhaleSignal for sub-millisecond execution
  }
}
