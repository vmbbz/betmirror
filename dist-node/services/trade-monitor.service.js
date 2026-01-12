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
        // Initialize the listener bound to this instance context
        this.boundHandler = (event) => this.handleWhaleSignal(event);
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
        this.deps.logger.info(`🎯 Monitor targets synced. Bot is now following ${this.targetWallets.size} specific whales.`);
    }
    /**
     * Connects the monitor to the global intelligence event bus.
     */
    async start() {
        if (this.running)
            return;
        this.running = true;
        // Attach to the Singleton's trade stream
        this.deps.intelligence.on('whale_trade', this.boundHandler);
        this.deps.logger.info(`🔌 Multi-Tenant Signal Monitor: ONLINE. Listening for Push events.`);
    }
    /**
     * Detaches from the global stream and enters standby mode.
     */
    stop() {
        this.running = false;
        this.deps.intelligence.removeListener('whale_trade', this.boundHandler);
        this.processedTrades.clear();
        this.deps.logger.info('Cb Monitor: STANDBY.');
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
        // 1. Filter: Check if this specific bot instance cares about this whale
        if (!this.targetWallets.has(event.trader.toLowerCase()))
            return;
        // 2. Deduplication: Guard against WebSocket frame duplicates
        // We create a unique key based on trader, token, side, and a 5-second time window
        const tradeKey = `${event.trader}-${event.tokenId}-${event.side}-${Math.floor(event.timestamp / 5000)}`;
        if (this.processedTrades.has(tradeKey))
            return;
        this.processedTrades.set(tradeKey, Date.now());
        this.pruneCache();
        // 3. Logic Preservation: Map the event to a TradeSignal
        // This replicates the logic from your legacy 'processTrade' method
        this.deps.logger.info(`🚨 [SIGNAL] Push Match: ${event.trader.slice(0, 8)}... ${event.side} @ ${event.price}`);
        const signal = {
            trader: event.trader,
            marketId: "resolved_by_adapter", // The Executor will use the tokenId to fetch full metadata
            tokenId: event.tokenId,
            outcome: "YES", // Default mapping for Push signals, refined by the AI/Executor logic
            side: event.side,
            sizeUsd: event.size * event.price,
            price: event.price,
            timestamp: event.timestamp
        };
        // 4. Execution: Pass the validated signal to the BotEngine's detected trade handler
        this.deps.onDetectedTrade(signal).catch(err => {
            this.deps.logger.error(`Mirror execution failed for whale ${event.trader}`, err);
        });
    }
    /**
     * Memory Janitor: Cleans up the deduplication cache.
     * Keeps the server memory footprint low even during high-frequency trading.
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
    /**
     * LEGACY COMPATIBILITY: The following methods are preserved but effectively
     * bypassed by the high-performance WebSocket implementation.
     */
    async checkUserActivity(user) {
        // Logic moved to handleWhaleSignal via push events
        this.deps.logger.debug(`Legacy polling bypassed for ${user}. WebSocket active.`);
    }
    async processTrade(user, activity) {
        // Logic moved to handleWhaleSignal for sub-millisecond execution
    }
}
