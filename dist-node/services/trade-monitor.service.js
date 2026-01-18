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
    deps;
    running = false;
    targetWallets = new Set();
    /**
     * processedTrades: Cache to prevent duplicate trade processing.
     * Key: unique trade hash, Value: timestamp of processing.
     */
    processedTrades = new Map();
    // Bound handler reference to allow clean removal of event listeners
    boundHandler;
    constructor(deps) {
        this.deps = deps;
        this.updateTargets(deps.userAddresses);
        // Store bound handler reference to allow clean removal of event listeners
        this.boundHandler = (event) => {
            this.handleWhaleSignal(event);
        };
    }
    /**
     * Returns the current operational status of the monitor.
     */
    isActive() {
        return this.running;
    }
    /**
     * Synchronizes the local target list and notifies the global Intelligence Singleton
     * to expand its filtering set.
     *
     * @param newTargets Array of wallet addresses to monitor.
     */
    updateTargets(newTargets) {
        this.deps.userAddresses = newTargets;
        this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
        // Notify the Singleton to update the global WebSocket filter
        this.deps.intelligence.updateWatchlist(newTargets);
        this.deps.logger.info(`🎯 Monitor targets synced: ${this.targetWallets.size} whales.`);
    }
    /**
     * Connects the monitor to the global intelligence event bus.
     */
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.deps.intelligence.on('whale_trade', this.boundHandler);
        this.deps.logger.info(`🔌 Signal Monitor: ONLINE.`);
    }
    stop() {
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
    async handleWhaleSignal(event) {
        if (!this.running)
            return;
        // Normalization check
        if (!this.targetWallets.has(event.trader.toLowerCase()))
            return;
        const tradeKey = `${event.trader}-${event.tokenId}-${event.side}-${Math.floor(event.timestamp / 5000)}`;
        if (this.processedTrades.has(tradeKey))
            return;
        this.processedTrades.set(tradeKey, Date.now());
        this.pruneCache();
        this.deps.logger.success(`🚨 [SIGNAL] ${event.trader.slice(0, 10)}... ${event.side} @ ${event.price}`);
        // CRITICAL: Bridging the Intelligence Gap
        // Tell the central WS manager to subscribe to this token immediately so we have sub-second book data
        this.deps.intelligence.subscribeToToken(event.tokenId);
        const signal = {
            trader: event.trader,
            marketId: "resolved_by_adapter",
            tokenId: event.tokenId,
            outcome: "YES",
            side: event.side,
            sizeUsd: event.size * event.price,
            price: event.price,
            timestamp: event.timestamp
        };
        await this.deps.onDetectedTrade(signal);
    }
    /**
     * Memory Janitor: Cleans up the deduplication cache.
     */
    pruneCache() {
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
