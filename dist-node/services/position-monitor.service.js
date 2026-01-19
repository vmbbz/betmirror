export class PositionMonitorService {
    adapter;
    walletAddress;
    config;
    logger;
    onAutoCashout;
    positionMonitors = new Map();
    priceCheckers = new Map();
    activePositions = new Map();
    constructor(adapter, walletAddress, config, logger, onAutoCashout) {
        this.adapter = adapter;
        this.walletAddress = walletAddress;
        this.config = config;
        this.logger = logger;
        this.onAutoCashout = onAutoCashout;
    }
    async startMonitoring(position) {
        this.stopMonitoring(position.marketId);
        // Store the position
        this.activePositions.set(position.marketId, position);
        // Start position value monitoring
        const monitor = setInterval(async () => {
            try {
                await this.checkPosition(position);
            }
            catch (error) {
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
    startPriceChecker(position) {
        this.stopPriceChecker(position.marketId);
        const checker = setInterval(async () => {
            try {
                const currentPrice = await this.adapter.getCurrentPrice(position.tokenId);
                await this.checkAutoCashout(position, currentPrice);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.logger.error(`Error checking price for ${position.marketId}: ${errorMessage}`);
            }
        }, this.config.priceCheckInterval);
        this.priceCheckers.set(position.marketId, checker);
        this.logger.info(`[Monitor] Started price checker for: ${position.marketId}`);
    }
    async checkPosition(position) {
        try {
            // Refresh position data
            const updatedPositions = await this.adapter.getPositions(this.walletAddress);
            const updatedPosition = updatedPositions.find(p => p.marketId === position.marketId &&
                p.outcome === position.outcome);
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
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Error checking position ${position.marketId}: ${errorMessage}`, error instanceof Error ? error : undefined);
        }
    }
    async checkAutoCashout(position, currentPrice) {
        if (!position.autoCashout?.enabled || !position.entryPrice)
            return;
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
    stopMonitoring(marketId) {
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
    stopPriceChecker(marketId) {
        const checker = this.priceCheckers.get(marketId);
        if (checker) {
            clearInterval(checker);
            this.priceCheckers.delete(marketId);
            this.logger.info(`[Monitor] Stopped price checker for: ${marketId}`);
        }
    }
    stopAll() {
        for (const [marketId] of this.positionMonitors) {
            this.stopMonitoring(marketId);
        }
    }
    getActivePositions() {
        return Array.from(this.activePositions.values());
    }
}
