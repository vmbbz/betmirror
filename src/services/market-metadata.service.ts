import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { MarketMetadata as DBMarketMetadata, IMarketMetadata } from '../database/index.js';

// ============================================================
// MARKET METADATA INTERFACES
// ============================================================

export interface MarketMetadataCacheEntry {
    metadata: any; // Use any to avoid Mongoose type conflicts
    lastAccessed: number;
}

// ============================================================
// MARKET METADATA SERVICE
// ============================================================

export class MarketMetadataService {
    private memoryCache = new Map<string, MarketMetadataCacheEntry>();
    private readonly MAX_MEMORY_CACHE_SIZE = 50; // Hot markets only
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    private readonly DB_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes for DB

    constructor(
        private adapter: IExchangeAdapter,
        private logger: Logger
    ) {}

    /**
     * Get market metadata with hybrid caching strategy
     * L1: Memory cache (hot markets - last 50 accessed)
     * L2: Database cache (all markets ever seen)  
     * L3: API fetch (fallback with rate limiting)
     */
    async getMetadata(conditionId: string): Promise<IMarketMetadata | null> {
        try {
            // L1: Check memory cache first
            const memoryEntry = this.memoryCache.get(conditionId);
            if (memoryEntry && this.isCacheValid(memoryEntry.lastAccessed)) {
                this.updateMemoryAccess(conditionId);
                return memoryEntry.metadata;
            }

            // L2: Check database cache
            const dbMetadata = await this.getFromDatabase(conditionId);
            if (dbMetadata && this.isDbCacheValid(dbMetadata.updatedAt)) {
                this.updateMemoryCache(conditionId, dbMetadata);
                return dbMetadata;
            }

            // L3: Fetch from API
            this.logger.info(`[Metadata] Fetching from API: ${conditionId}`);
            const apiMetadata = await this.fetchFromAPI(conditionId);
            if (apiMetadata) {
                await this.saveToDatabase(apiMetadata);
                this.updateMemoryCache(conditionId, apiMetadata);
                return apiMetadata;
            }

            return null;
        } catch (error) {
            this.logger.error(`[Metadata] Failed to get metadata for ${conditionId}: ${error}`);
            return null;
        }
    }

    /**
     * Batch fetch metadata for multiple markets
     * Optimized for bulk operations like portfolio sync
     */
    async getBatchMetadata(conditionIds: string[]): Promise<Map<string, IMarketMetadata>> {
        const results = new Map<string, IMarketMetadata>();
        const toFetch: string[] = [];

        // Check cache first
        for (const conditionId of conditionIds) {
            const memoryEntry = this.memoryCache.get(conditionId);
            if (memoryEntry && this.isCacheValid(memoryEntry.lastAccessed)) {
                results.set(conditionId, memoryEntry.metadata);
                this.updateMemoryAccess(conditionId);
            } else {
                toFetch.push(conditionId);
            }
        }

        // Batch fetch from database for remaining
        if (toFetch.length > 0) {
            const dbResults = await this.getBatchFromDatabase(toFetch);
            for (const [conditionId, metadata] of dbResults) {
                if (this.isDbCacheValid(metadata.updatedAt)) {
                    results.set(conditionId, metadata);
                    this.updateMemoryCache(conditionId, metadata);
                }
            }
        }

        // Identify still missing markets
        const stillMissing = conditionIds.filter(id => !results.has(id));
        if (stillMissing.length > 0) {
            this.logger.info(`[Metadata] Batch fetching ${stillMissing.length} markets from API`);
            
            // API fetch with rate limiting
            for (const conditionId of stillMissing) {
                try {
                    const apiMetadata = await this.fetchFromAPI(conditionId);
                    if (apiMetadata) {
                        await this.saveToDatabase(apiMetadata);
                        this.updateMemoryCache(conditionId, apiMetadata);
                        results.set(conditionId, apiMetadata);
                    }
                } catch (error) {
                    this.logger.error(`[Metadata] Failed to fetch ${conditionId}: ${error}`);
                }
            }
        }

        return results;
    }

    /**
     * Update metadata when new information is available
     */
    async updateMetadata(conditionId: string, updates: Partial<IMarketMetadata>): Promise<void> {
        try {
            // Update in memory if cached
            const memoryEntry = this.memoryCache.get(conditionId);
            if (memoryEntry) {
                Object.assign(memoryEntry.metadata, updates, { updatedAt: new Date() });
                memoryEntry.lastAccessed = Date.now();
            }

            // Update in database
            await this.updateInDatabase(conditionId, updates);
        } catch (error) {
            this.logger.error(`[Metadata] Failed to update ${conditionId}: ${error}`);
        }
    }

    /**
     * Clear expired entries from memory cache
     */
    cleanupMemoryCache(): void {
        const now = Date.now();
        const entries = Array.from(this.memoryCache.entries());
        
        // Sort by last accessed (LRU)
        entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        
        // Remove expired entries
        for (const [conditionId, entry] of entries) {
            if (!this.isCacheValid(entry.lastAccessed) || this.memoryCache.size > this.MAX_MEMORY_CACHE_SIZE) {
                this.memoryCache.delete(conditionId);
            }
        }
    }

    // ============================================================
    // PRIVATE METHODS
    // ============================================================

    private isCacheValid(lastAccessed: number): boolean {
        return (Date.now() - lastAccessed) < this.CACHE_TTL_MS;
    }

    private isDbCacheValid(updatedAt: Date): boolean {
        return (Date.now() - updatedAt.getTime()) < this.DB_CACHE_TTL_MS;
    }

    private updateMemoryAccess(conditionId: string): void {
        const entry = this.memoryCache.get(conditionId);
        if (entry) {
            entry.lastAccessed = Date.now();
        }
    }

    private updateMemoryCache(conditionId: string, metadata: IMarketMetadata): void {
        // Implement LRU eviction if cache is full
        if (this.memoryCache.size >= this.MAX_MEMORY_CACHE_SIZE) {
            this.evictLRU();
        }

        this.memoryCache.set(conditionId, {
            metadata: { ...metadata },
            lastAccessed: Date.now()
        });
    }

    private evictLRU(): void {
        let oldestTime = Date.now();
        let oldestKey = '';

        for (const [key, entry] of this.memoryCache) {
            if (entry.lastAccessed < oldestTime) {
                oldestTime = entry.lastAccessed;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.memoryCache.delete(oldestKey);
        }
    }

    private async fetchFromAPI(conditionId: string): Promise<IMarketMetadata | null> {
        try {
            const marketData = await this.adapter.getMarketData(conditionId);
            if (!marketData) return null;
            
            // Convert Market interface to IMarketMetadata
            const metadata: any = {
                conditionId,
                question: marketData.question,
                image: marketData.image,
                marketSlug: marketData.market_slug,
                eventSlug: marketData.market_slug, // Using market_slug as eventSlug for now
                acceptingOrders: marketData.accepting_orders,
                closed: marketData.closed,
                rewards: marketData.rewards,
                tags: marketData.tags,
                minimum_order_size: marketData.minimum_order_size,
                minimum_tick_size: marketData.minimum_tick_size,
                updatedAt: new Date(),
                createdAt: new Date()
            };
            return metadata;
        } catch (error) {
            this.logger.error(`[Metadata] API fetch failed for ${conditionId}: ${error}`);
            return null;
        }
    }

    private async getFromDatabase(conditionId: string): Promise<IMarketMetadata | null> {
        try {
            const metadata = await DBMarketMetadata.findOne({ conditionId });
            return metadata ? metadata.toObject() : null;
        } catch (error) {
            this.logger.error(`[Metadata] DB query failed for ${conditionId}: ${error}`);
            return null;
        }
    }

    private async getBatchFromDatabase(conditionIds: string[]): Promise<Map<string, IMarketMetadata>> {
        try {
            const metadataRecords = await DBMarketMetadata.find({ 
                conditionId: { $in: conditionIds } 
            });
            
            const results = new Map<string, IMarketMetadata>();
            for (const record of metadataRecords) {
                results.set(record.conditionId, record.toObject());
            }
            
            return results;
        } catch (error) {
            this.logger.error(`[Metadata] Batch DB query failed: ${error}`);
            return new Map<string, IMarketMetadata>();
        }
    }

    private async saveToDatabase(metadata: IMarketMetadata): Promise<void> {
        try {
            await DBMarketMetadata.findOneAndUpdate(
                { conditionId: metadata.conditionId },
                { 
                    $set: { 
                        ...metadata,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );
        } catch (error) {
            this.logger.error(`[Metadata] Failed to save to DB: ${error}`);
        }
    }

    private async updateInDatabase(conditionId: string, updates: Partial<IMarketMetadata>): Promise<void> {
        try {
            await DBMarketMetadata.findOneAndUpdate(
                { conditionId },
                { 
                    $set: { 
                        ...updates,
                        updatedAt: new Date()
                    }
                },
                { new: true }
            );
        } catch (error) {
            this.logger.error(`[Metadata] Failed to update in DB: ${error}`);
        }
    }

    /**
     * Get cache statistics for monitoring
     */
    getCacheStats(): {
        memoryCacheSize: number;
        maxMemoryCacheSize: number;
        hitRate: number;
    } {
        return {
            memoryCacheSize: this.memoryCache.size,
            maxMemoryCacheSize: this.MAX_MEMORY_CACHE_SIZE,
            hitRate: 0 // Would need to track hits/misses
        };
    }
}
