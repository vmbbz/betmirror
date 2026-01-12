/**
 * LOGIC LAYER: TradeMonitorService
 * Event-driven monitor that listens to the global singleton Intelligence hub.
 * Removes all axios/polling logic in favor of a push-based model.
 */
export class TradeMonitorService {
    deps;
    running = false;
    targetWallets = new Set();
    // Cache to prevent duplicate trade processing from socket stutters
    processedTrades = new Map();
    // Bound handler to ensure listener can be removed during stop()
    boundHandler;
    constructor(deps) {
        this.deps = deps;
        this.updateTargets(deps.userAddresses);
        // Initialize the bound listener
        this.boundHandler = (event) => this.handleWhaleSignal(event);
    }
    /**
     * Returns whether the monitor is currently listening for events.
     */
    isActive() {
        return this.running;
    }
    updateTargets(newTargets) {
        this.deps.userAddresses = newTargets;
        this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
        this.deps.logger.info(`🎯 Monitor target list updated to ${this.targetWallets.size} wallets.`);
    }
    /**
     * Starts listening to the global intelligence hub.
     */
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.deps.intelligence.on('whale_trade', this.boundHandler);
        this.deps.logger.info(`🔌 Multi-Tenant Signal Monitor: ONLINE.`);
    }
    /**
     * Stops listening and clears the duplicate guard cache.
     */
    stop() {
        this.running = false;
        this.deps.intelligence.removeListener('whale_trade', this.boundHandler);
        this.processedTrades.clear();
        this.deps.logger.info('Cb Monitor standby.');
    }
    /**
     * Core logic for handling a push signal.
     * Maps WhaleTradeEvent to TradeSignal and triggers execution.
     */
    async handleWhaleSignal(event) {
        if (!this.running)
            return;
        // 1. Filter: Does this bot care about this specific trader?
        if (!this.targetWallets.has(event.trader))
            return;
        // 2. Deduplication: Prevent double-execution from socket reconnects/duplicate events
        const tradeKey = `${event.trader}-${event.tokenId}-${event.side}-${Math.floor(event.timestamp / 5000)}`;
        if (this.processedTrades.has(tradeKey))
            return;
        this.processedTrades.set(tradeKey, Date.now());
        this.pruneCache();
        this.deps.logger.info(`🚨 [SIGNAL] Push Match: ${event.trader.slice(0, 8)}... ${event.side} @ ${event.price}`);
        // 3. Map to internal TradeSignal format
        const signal = {
            trader: event.trader,
            marketId: "resolved_by_adapter", // Adapter uses tokenId to find the market
            tokenId: event.tokenId,
            outcome: "YES", // Default for push-signals, refined by the Executor
            side: event.side,
            sizeUsd: event.size * event.price,
            price: event.price,
            timestamp: event.timestamp
        };
        // 4. Trigger Execution
        this.deps.onDetectedTrade(signal).catch(err => {
            this.deps.logger.error(`Mirror execution failed for ${event.trader}`, err);
        });
    }
    /**
     * Cleans up the deduplication cache to prevent memory leaks.
     */
    pruneCache() {
        const now = Date.now();
        const TTL = 5 * 60 * 1000; // 5 minutes is plenty for socket deduplication
        if (this.processedTrades.size > 1000) {
            for (const [key, ts] of this.processedTrades.entries()) {
                if (now - ts > TTL) {
                    this.processedTrades.delete(key);
                }
            }
        }
    }
}
