export class PortfolioTrackerService {
    adapter;
    walletAddress;
    maxPortfolioAllocation;
    logger;
    allocatedCapital = 0;
    positions = new Map(); // marketId -> positionValue
    onPositionsUpdate;
    constructor(adapter, walletAddress, maxPortfolioAllocation, logger, onPositionsUpdate) {
        this.adapter = adapter;
        this.walletAddress = walletAddress;
        this.maxPortfolioAllocation = maxPortfolioAllocation;
        this.logger = logger;
        this.onPositionsUpdate = onPositionsUpdate;
    }
    async initialize() {
        await this.syncPositions();
    }
    async syncPositions() {
        try {
            const positions = await this.adapter.getPositions(this.walletAddress);
            this.allocatedCapital = positions.reduce((sum, pos) => sum + (pos.valueUsd || 0), 0);
            // Update positions map
            this.positions = new Map(positions.map(pos => [pos.marketId, pos.valueUsd || 0]));
            this.logger.info(`[Portfolio] Synced ${positions.length} positions. Allocated: $${this.allocatedCapital.toFixed(2)}`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to sync positions: ${errorMessage}`, error instanceof Error ? error : undefined);
            throw error instanceof Error ? error : new Error('Failed to sync positions');
        }
    }
    canAllocate(amount) {
        const totalAfterAllocation = this.allocatedCapital + amount;
        const available = Math.max(0, this.maxPortfolioAllocation - this.allocatedCapital);
        if (totalAfterAllocation > this.maxPortfolioAllocation) {
            return {
                canAllocate: false,
                reason: `Insufficient allocation. Requested: $${amount.toFixed(2)}, Available: $${available.toFixed(2)}`,
                available
            };
        }
        return {
            canAllocate: true,
            available
        };
    }
    trackAllocation(marketId, amount) {
        this.allocatedCapital += amount;
        const currentValue = this.positions.get(marketId) || 0;
        this.positions.set(marketId, currentValue + amount);
        this.logger.info(`[Portfolio] Tracked allocation: $${amount.toFixed(2)} for ${marketId}. ` +
            `Total allocated: $${this.allocatedCapital.toFixed(2)}`);
    }
    releaseAllocation(marketId, amount) {
        const currentValue = this.positions.get(marketId) || 0;
        const newValue = currentValue - amount;
        if (newValue <= 0) {
            this.positions.delete(marketId);
            this.allocatedCapital -= currentValue;
        }
        else {
            this.positions.set(marketId, newValue);
            this.allocatedCapital -= amount;
        }
        this.logger.info(`[Portfolio] Released allocation: $${amount.toFixed(2)} from ${marketId}. ` +
            `Remaining allocated: $${this.allocatedCapital.toFixed(2)}`);
    }
    getAllocatedCapital() {
        return this.allocatedCapital;
    }
    getAvailableCapital() {
        return Math.max(0, this.maxPortfolioAllocation - this.allocatedCapital);
    }
    getPositionValue(marketId) {
        return this.positions.get(marketId) || 0;
    }
    getActivePositions() {
        return Array.from(this.positions.entries()).map(([marketId, valueUsd]) => ({
            tradeId: `tracker-${marketId}`,
            marketId,
            tokenId: '', // Will be updated when we have the actual token ID
            outcome: 'YES', // Default to 'YES', will be updated with actual data
            entryPrice: 0, // Will be updated when we have the actual entry price
            currentPrice: 0, // Will be updated with current market data
            shares: 0, // Will be updated with actual share count
            valueUsd,
            sizeUsd: valueUsd,
            lastUpdated: Date.now(),
            pnl: 0,
            pnlPercentage: 0,
            investedValue: valueUsd,
            autoCashout: undefined,
            timestamp: Date.now()
        }));
    }
    async notifyPositionsUpdate() {
        if (this.onPositionsUpdate) {
            try {
                await this.onPositionsUpdate(this.getActivePositions());
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error : new Error(String(error));
                this.logger.error('Error in positions update callback:', errorMessage);
            }
        }
    }
}
