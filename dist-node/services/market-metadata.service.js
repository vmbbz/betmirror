import { MarketMetadata as DBMarketMetadata } from '../database/index.js';
// ============================================================
// MARKET METADATA SERVICE
// ============================================================
export class MarketMetadataService {
    adapter;
    logger;
    memoryCache = new Map();
    MAX_MEMORY_CACHE_SIZE = 5000; // Expanded to handle all token mappings
    CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    DB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for DB
    constructor(adapter, logger) {
        this.adapter = adapter;
        this.logger = logger;
    }
    /**
     * HFT LOOP ONLY: Synchronous RAM lookup.
     * Bypasses DB and API entirely to ensure sub-millisecond execution.
     * Supports both conditionId and tokenId lookups.
     */
    getMetadataSync(id) {
        const entry = this.memoryCache.get(id);
        if (entry && (Date.now() - entry.lastAccessed < this.CACHE_TTL_MS)) {
            entry.lastAccessed = Date.now();
            return entry.metadata;
        }
        return null;
    }
    /**
     * PROACTIVE HYDRATION: Scanner pushes data to RAM and background-saves to DB.
     * Now maps the conditionId AND all associated tokenIds to the same entry.
     */
    hydrate(conditionId, metadata) {
        const enriched = {
            ...metadata,
            updatedAt: new Date()
        };
        const entry = {
            metadata: enriched,
            lastAccessed: Date.now()
        };
        // Map by Market ID
        this.memoryCache.set(conditionId, entry);
        // Map by Single Token ID
        if (metadata.tokenId) {
            this.memoryCache.set(metadata.tokenId, entry);
        }
        // Map by Multiple Token IDs (Outcome level)
        if (metadata.tokenIds && Array.isArray(metadata.tokenIds)) {
            metadata.tokenIds.forEach((tid) => {
                this.memoryCache.set(tid, entry);
            });
        }
        this.saveToDatabase(enriched).catch(e => this.logger.debug(`[Metadata] Background save deferred for ${conditionId}`));
    }
    /**
     * Get market metadata with hybrid caching strategy
     * L1: Memory cache (hot markets - support for tokenId or conditionId)
     * L2: Database cache (OR query for all ID types)
     * L3: API fetch (fallback with rate limiting)
     * @param skipApi - If true, only check memory and DB. Crucial for log enrichment to avoid 429s.
     */
    async getMetadata(id, skipApi = false) {
        try {
            // L1: Memory
            const ram = this.getMetadataSync(id);
            if (ram)
                return ram;
            // L2: Database - Support OR query for both ID types
            const dbMetadata = await DBMarketMetadata.findOne({
                $or: [
                    { conditionId: id },
                    { tokenId: id },
                    { tokenIds: id },
                    { marketSlug: id }
                ]
            }).lean();
            if (dbMetadata) {
                // Re-hydrate L1 for future fast-path lookups
                this.hydrate(dbMetadata.conditionId, dbMetadata);
                return dbMetadata;
            }
            // L3: API (Optional)
            if (skipApi)
                return null;
            this.logger.debug(`[Metadata] Cache miss, fetching from API: ${id}`);
            const marketData = await this.adapter.getMarketData(id);
            if (marketData) {
                const metadata = {
                    conditionId: marketData.condition_id,
                    question: marketData.question,
                    image: marketData.image,
                    marketSlug: marketData.market_slug,
                    eventSlug: marketData.market_slug,
                    tokenId: marketData.tokens?.[0]?.token_id,
                    tokenIds: marketData.tokens?.map(t => t.token_id) || [],
                    acceptingOrders: marketData.accepting_orders,
                    closed: marketData.closed,
                    updatedAt: new Date()
                };
                this.hydrate(metadata.conditionId, metadata);
                return metadata;
            }
            return null;
        }
        catch (error) {
            return null;
        }
    }
    /**
     * Batch fetch metadata for multiple markets
     * Optimized for bulk operations like portfolio sync
     */
    async getBatchMetadata(ids) {
        const results = new Map();
        const toFetch = [];
        // Check cache first
        for (const id of ids) {
            const metadata = this.getMetadataSync(id);
            if (metadata) {
                results.set(id, metadata);
            }
            else {
                toFetch.push(id);
            }
        }
        // Batch fetch from database for remaining
        if (toFetch.length > 0) {
            try {
                const dbResults = await DBMarketMetadata.find({
                    $or: [
                        { conditionId: { $in: toFetch } },
                        { tokenId: { $in: toFetch } },
                        { tokenIds: { $in: toFetch } }
                    ]
                }).lean();
                for (const record of dbResults) {
                    this.hydrate(record.conditionId, record);
                    results.set(record.conditionId, record);
                }
            }
            catch (error) {
                this.logger.error(`[Metadata] Batch DB query failed: ${error}`);
            }
        }
        return results;
    }
    /**
     * Update metadata when new information is available
     */
    async updateMetadata(conditionId, updates) {
        try {
            // Update in memory if cached
            const entry = this.memoryCache.get(conditionId);
            if (entry) {
                Object.assign(entry.metadata, updates, { updatedAt: new Date() });
                entry.lastAccessed = Date.now();
            }
            // Update in database
            await this.updateInDatabase(conditionId, updates);
        }
        catch (error) {
            this.logger.error(`[Metadata] Failed to update ${conditionId}: ${error}`);
        }
    }
    /**
     * Clear expired entries from memory cache
     */
    cleanupMemoryCache() {
        const now = Date.now();
        const entries = Array.from(this.memoryCache.entries());
        // Sort by last accessed (LRU)
        entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        // Remove expired entries
        for (const [id, entry] of entries) {
            if (now - entry.lastAccessed > this.CACHE_TTL_MS || this.memoryCache.size > this.MAX_MEMORY_CACHE_SIZE) {
                this.memoryCache.delete(id);
            }
        }
    }
    // ============================================
    // PRIVATE METHODS
    // ============================================
    updateMemoryCache(id, metadata) {
        if (this.memoryCache.size >= this.MAX_MEMORY_CACHE_SIZE) {
            this.evictLRU();
        }
        this.memoryCache.set(id, {
            metadata: { ...metadata },
            lastAccessed: Date.now()
        });
    }
    evictLRU() {
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
    async saveToDatabase(metadata) {
        try {
            await DBMarketMetadata.findOneAndUpdate({ conditionId: metadata.conditionId }, {
                $set: {
                    ...metadata,
                    updatedAt: new Date()
                }
            }, { upsert: true, new: true });
        }
        catch (error) {
            this.logger.error(`[Metadata] Failed to save to DB: ${error}`);
        }
    }
    async updateInDatabase(conditionId, updates) {
        try {
            await DBMarketMetadata.findOneAndUpdate({ conditionId }, {
                $set: {
                    ...updates,
                    updatedAt: new Date()
                }
            }, { new: true });
        }
        catch (error) {
            this.logger.error(`[Metadata] Failed to update in DB: ${error}`);
        }
    }
    getCacheStats() {
        return {
            memoryCacheSize: this.memoryCache.size,
            maxMemoryCacheSize: this.MAX_MEMORY_CACHE_SIZE,
            hitRate: 0
        };
    }
}
