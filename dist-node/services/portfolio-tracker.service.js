export class PortfolioTrackerService {
    adapter;
    walletAddress;
    maxPortfolioAllocation;
    logger;
    positionMonitor;
    marketMetadataService;
    allocatedCapital = 0;
    positions = new Map(); // marketId -> positionValue
    positionTokenIds = new Map(); // marketId -> tokenId
    onPositionsUpdate;
    constructor(adapter, walletAddress, maxPortfolioAllocation, logger, positionMonitor, marketMetadataService, onPositionsUpdate) {
        this.adapter = adapter;
        this.walletAddress = walletAddress;
        this.maxPortfolioAllocation = maxPortfolioAllocation;
        this.logger = logger;
        this.positionMonitor = positionMonitor;
        this.marketMetadataService = marketMetadataService;
        this.onPositionsUpdate = onPositionsUpdate;
        // Handle invalid positions from position monitor
        this.positionMonitor.onPositionInvalid = async (marketId, reason) => {
            await this.handleInvalidPosition(marketId, reason);
        };
    }
    async initialize() {
        await this.syncPositions();
    }
    /**
     * Updates metadata for all positions, including closed ones
     */
    async updateAllPositionsMetadata(positions) {
        try {
            // Collect all unique market IDs
            const allMarketIds = new Set();
            const activeMarketIds = new Set();
            for (const position of positions) {
                allMarketIds.add(position.marketId);
                if (position.shares > 0) {
                    activeMarketIds.add(position.marketId);
                }
            }
            this.logger.info(`[Portfolio] Updating metadata for ${allMarketIds.size} positions`);
            // Use MarketMetadataService for efficient batch retrieval
            if (this.marketMetadataService) {
                const marketMetadataMap = await this.marketMetadataService.getBatchMetadata(Array.from(allMarketIds));
                // Update metadata for all positions using cached data
                for (const [marketId, metadata] of marketMetadataMap) {
                    try {
                        // Update database with latest metadata
                        await this.adapter.updatePositionMetadata(marketId, {
                            question: metadata.question,
                            image: metadata.image,
                            isResolved: metadata.closed,
                            acceptingOrders: metadata.acceptingOrders,
                            marketSlug: metadata.marketSlug,
                            eventSlug: metadata.eventSlug
                        });
                        // If this is an active position, update the in-memory data
                        if (activeMarketIds.has(marketId)) {
                            const position = positions.find((p) => p.marketId === marketId);
                            if (position) {
                                position.question = metadata.question;
                                position.image = metadata.image;
                                position.isResolved = metadata.closed;
                            }
                        }
                    }
                    catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        this.logger.error(`Failed to update metadata for position ${marketId}: ${errorMessage}`, error instanceof Error ? error : undefined);
                    }
                }
            }
            else {
                // Fallback to direct API calls if MarketMetadataService not available
                this.logger.warn('[Portfolio] MarketMetadataService not available, using direct API calls');
                for (const marketId of allMarketIds) {
                    try {
                        const marketData = await this.adapter.getMarketData(marketId);
                        if (marketData) {
                            await this.adapter.updatePositionMetadata(marketId, marketData);
                            // If this is an active position, update the in-memory data
                            if (activeMarketIds.has(marketId)) {
                                const position = positions.find((p) => p.marketId === marketId);
                                if (position) {
                                    position.question = marketData.question;
                                    position.image = marketData.image;
                                    position.isResolved = marketData.closed;
                                }
                            }
                        }
                    }
                    catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        this.logger.error(`Failed to update metadata for position ${marketId}: ${errorMessage}`, error instanceof Error ? error : undefined);
                    }
                }
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Error in updateAllPositionsMetadata: ${errorMessage}`, error instanceof Error ? error : undefined);
        }
    }
    async syncPositions(forceMetadataUpdate = false) {
        try {
            // Get current positions from the exchange
            const positionData = await this.adapter.getPositions(this.walletAddress);
            // Convert PositionData[] to ActivePosition[]
            const activePositions = positionData.map(posData => ({
                tradeId: `tracker-${posData.marketId}-${Date.now()}`,
                marketId: posData.marketId,
                conditionId: posData.conditionId,
                tokenId: posData.tokenId,
                outcome: posData.outcome,
                entryPrice: posData.entryPrice,
                currentPrice: posData.currentPrice,
                shares: posData.balance,
                valueUsd: posData.valueUsd,
                sizeUsd: posData.investedValue || posData.valueUsd,
                pnl: posData.unrealizedPnL,
                pnlPercentage: posData.unrealizedPnLPercent,
                lastUpdated: Date.now(),
                timestamp: Date.now(),
                question: posData.question,
                image: posData.image,
                marketSlug: posData.marketSlug,
                eventSlug: posData.eventSlug,
                // Set default values for required fields
                investedValue: posData.investedValue || posData.valueUsd,
                // Add any additional fields from PositionData that map to ActivePosition
                ...posData // Spread any additional properties that might be present
            }));
            this.allocatedCapital = activePositions.reduce((sum, pos) => sum + (pos.valueUsd || 0), 0);
            // Update positions map and token ID mapping
            this.positions = new Map();
            this.positionTokenIds = new Map();
            for (const pos of activePositions) {
                this.positions.set(pos.marketId, pos.valueUsd || 0);
                if (pos.tokenId) {
                    this.positionTokenIds.set(pos.marketId, pos.tokenId);
                }
            }
            // Update metadata for all positions, including closed ones
            await this.updateAllPositionsMetadata(activePositions);
            // Store the actual synced positions for getActivePositions()
            this.lastSyncedPositions = activePositions;
            this.logger.info(`[Portfolio] Synced ${activePositions.length} positions. Allocated: $${this.allocatedCapital.toFixed(2)}`);
            // Notify listeners about the position update
            await this.notifyPositionsUpdate();
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
        // Return the actual synced positions from the last syncPositions() call
        // Store the last synced positions to avoid re-fetching
        if (!this.lastSyncedPositions) {
            // If no sync has happened yet, return empty array
            return [];
        }
        return this.lastSyncedPositions;
    }
    lastSyncedPositions = [];
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
    /**
     * Handles cleanup when a position is detected as invalid (e.g., order book no longer exists)
     */
    async handleInvalidPosition(marketId, reason) {
        const positionValue = this.positions.get(marketId) || 0;
        // Release the allocation for this position
        this.releaseAllocation(marketId, positionValue);
        // Clean up token ID mapping
        this.positionTokenIds.delete(marketId);
        this.logger.warn(`[Portfolio] Cleaned up invalid position: ${marketId}. ` +
            `Reason: ${reason}. Released: $${positionValue.toFixed(2)}`);
        // Notify listeners about the updated positions
        await this.notifyPositionsUpdate();
    }
    /**
     * Gets the token ID for a market if available
     */
    getTokenId(marketId) {
        return this.positionTokenIds.get(marketId);
    }
}
