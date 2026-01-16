import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { WS_URLS } from '../config/env.js';
import { MarketIntelligenceService } from './market-intelligence.service.js';
import { EnhancedFlashMoveEvent } from './flash-move.service.js';
import { MoneyMarketOpportunity } from '../database/index.js';
import { TradeExecutorService } from './trade-executor.service.js';
import { WebSocketManager, PriceEvent, TradeEvent } from './websocket-manager.service.js';
import { FlashMoveService, FlashMoveServiceStatus } from './flash-move.service.js';
import EventEmitter from 'events';
import WebSocket from 'ws';

// ============================================================
// RATE LIMITER (Token Bucket - Optimized for Gamma API: 4000 req/10s)
// ============================================================
class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRate: number;

    constructor(maxTokens = 1000, refillRatePerSecond = 100) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRate = refillRatePerSecond;
        this.lastRefill = Date.now();
    }

    async limit<T>(fn: () => Promise<T>): Promise<T> {
        this.refill();
        if (this.tokens < 1) {
            const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
            await new Promise(r => setTimeout(r, waitTime));
            this.refill();
        }
        this.tokens--;
        return fn();
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }
}

// ============================================================
// INTERFACES (COMPLETE)
// ============================================================

export interface MarketOpportunity {
    marketId: string;
    conditionId: string;
    tokenId: string;
    question: string;
    image?: string;
    marketSlug?: string;
    eventSlug?: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: number;
    spreadCents: number;
    midpoint: number;
    volume: number;
    liquidity: number;
    isNewMarket: boolean;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    orderMinSize?: number;
    timestamp: number;
    roi: number;
    combinedCost: number;
    capacityUsd: number;
    skew?: number;
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    volume24hr?: number;
    category?: string;
    featured?: boolean;
    isBookmarked?: boolean;
    lastPriceMovePct?: number;
    isVolatile?: boolean;
}

interface TrackedMarket {
    conditionId: string;
    tokenId: string;
    question: string;
    image?: string;
    marketSlug?: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    volume: number;
    liquidity: number;
    isNewMarket: boolean;
    discoveredAt: number;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    isYesToken?: boolean;
    pairedTokenId?: string;
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    volume24hr?: number;
    orderMinSize?: number;
    orderPriceMinTickSize?: number;
    category?: string;
    featured?: boolean;
    competitive?: number;
}

export interface MarketMakerConfig {
    minSpreadCents: number;
    maxSpreadCents: number;
    minVolume: number;
    minLiquidity: number;
    preferRewardMarkets: boolean;
    preferNewMarkets: boolean;
    newMarketAgeMinutes: number;
    refreshIntervalMs: number;
    priceMoveThresholdPct: number;
    maxInventoryPerToken: number;
    autoMergeThreshold: number;
    enableKillSwitch: boolean;
    flashMoveTradeSize: number;
    dbBatchIntervalMs: number;
}

interface InventoryBalance {
    yes: number;
    no: number;
    yesTokenId: string;
    noTokenId: string;
    conditionId: string;
}

interface TickSizeInfo {
    tokenId: string;
    tickSize: string;
    updatedAt: number;
}

interface FlashMoveTradeResult {
    success: boolean;
    orderId?: string;
    errorMsg?: string;
    filledSize?: number;
    avgPrice?: number;
}

// ============================================================
// MAIN SCANNER CLASS (PRODUCTION GRADE)
// ============================================================

export class MarketMakingScanner extends EventEmitter {
    // Core state
    public isScanning = false;
    private wsManager: WebSocketManager;
    private trackedMarkets: Map<string, TrackedMarket> = new Map();
    private monitoredMarkets: Map<string, MarketOpportunity> = new Map();
    private opportunities: MarketOpportunity[] = [];
    private refreshInterval?: NodeJS.Timeout;
    private reconnectTimeout?: NodeJS.Timeout;
    private rateLimiter = new RateLimiter();

    // Risk management state
    private readonly MAX_TRACKED_MARKETS = 1000;
    private lastMidpoints: Map<string, number> = new Map();
    private inventoryBalances: Map<string, InventoryBalance> = new Map();
    private tickSizes: Map<string, TickSizeInfo> = new Map();
    private resolvedMarkets: Set<string> = new Set();
    private killSwitchActive = false;
    private bookmarkedMarkets: Set<string> = new Set();
    private activeQuoteTokens: Set<string> = new Set();

    // DB batch writing
    private pendingDbWrites: Map<string, MarketOpportunity> = new Map();
    private dbWriteInterval?: NodeJS.Timeout;

    // Default config
    private config: MarketMakerConfig = {
        minSpreadCents: 1,
        maxSpreadCents: 15,
        minVolume: 1000,
        minLiquidity: 50,
        preferRewardMarkets: true,
        preferNewMarkets: true,
        newMarketAgeMinutes: 60,
        refreshIntervalMs: 5 * 60 * 1000,
        priceMoveThresholdPct: 5,
        maxInventoryPerToken: 500,
        autoMergeThreshold: 100,
        enableKillSwitch: true,
        flashMoveTradeSize: 50,
        dbBatchIntervalMs: 30000
    };

    constructor(
        private intelligence: MarketIntelligenceService,
        private adapter: IExchangeAdapter,
        private logger: Logger,
        private tradeExecutor: TradeExecutorService,
        wsManager: WebSocketManager,
        private flashMoveService?: FlashMoveService
    ) {
        super();
        this.wsManager = wsManager;
        
        // Initialize Flash Move Service
        this.flashMoveService = flashMoveService;
        
        // Setup centralized WebSocket manager
        this.setupWebSocketListeners();
    }

    // ============================================================
    // PUBLIC API - BOOKMARKS
    // ============================================================

    public initializeBookmarks(bookmarks: string[]): void {
        this.bookmarkedMarkets = new Set(bookmarks);
        this.logger.info(`Initialized ${this.bookmarkedMarkets.size} bookmarked markets`);
    }

    public bookmarkMarket(conditionId: string): void {
        this.bookmarkedMarkets.add(conditionId);
        this.logger.info(`📌 Bookmarked market: ${conditionId}`);
    }

    public unbookmarkMarket(conditionId: string): void {
        this.bookmarkedMarkets.delete(conditionId);
        this.logger.info(`📌 Unbookmarked market: ${conditionId}`);
    }

    public isBookmarked(conditionId: string): boolean {
        return this.bookmarkedMarkets.has(conditionId);
    }

    public getBookmarkedOpportunities(): MarketOpportunity[] {
        return this.opportunities
            .filter(o => this.bookmarkedMarkets.has(o.conditionId))
            .map(opp => ({ ...opp, isBookmarked: true }));
    }

    // ============================================================
    // PUBLIC API - ACTIVE QUOTES
    // ============================================================

    public hasActiveQuotes(tokenId: string): boolean {
        return this.activeQuoteTokens.has(tokenId);
    }

    public setActiveQuotes(tokenIds: string[]): void {
        this.activeQuoteTokens = new Set(tokenIds);
    }

    // ============================================================
    // PUBLIC API - INVENTORY & TICK SIZE
    // ============================================================

    public getInventorySkew(conditionId: string): number {
        const balance = this.inventoryBalances.get(conditionId);
        if (!balance) return 0;
        const total = balance.yes + balance.no;
        if (total === 0) return 0;
        return (balance.yes - balance.no) / total;
    }

    public updateInventoryBalance(conditionId: string, balance: InventoryBalance): void {
        this.inventoryBalances.set(conditionId, balance);
    }

    public getTickSize(tokenId: string): string {
        const info = this.tickSizes.get(tokenId);
        return info?.tickSize || '0.01';
    }

    // ============================================================
    // PUBLIC API - KILL SWITCH
    // ============================================================

    public triggerKillSwitch(reason: string): void {
        if (!this.config.enableKillSwitch) return;
        this.killSwitchActive = true;
        this.logger.error(`🚨 KILL SWITCH TRIGGERED: ${reason}`);
        this.emit('killSwitch', { reason, timestamp: Date.now() });
        
        // Cancel all orders immediately
        this.adapter.cancelAllOrders?.().catch(e => {
            this.logger.error(`Failed to cancel orders on kill switch: ${e}`);
        });
    }

    public resetKillSwitch(): void {
        this.killSwitchActive = false;
        this.logger.info('🔄 Kill switch reset');
    }

    public isKillSwitchActive(): boolean {
        return this.killSwitchActive;
    }

    // ============================================================
    // PUBLIC API - MARKET ACCESS
    // ============================================================

    public getTrackedMarket(tokenId: string): TrackedMarket | undefined {
        return this.trackedMarkets.get(tokenId);
    }

    public getOpportunities(maxAgeMs = 600000): MarketOpportunity[] {
        const now = Date.now();
        const actionable = this.opportunities.filter(o => now - o.timestamp < maxAgeMs);
        
        if (actionable.length < 5) {
            const supplemental = Array.from(this.monitoredMarkets.values())
                .filter(o => o.status === 'active' && !actionable.some(a => a.tokenId === o.tokenId))
                .slice(0, 10);
            return [...actionable, ...supplemental];
        }
        return actionable;
    }

    public getLatestOpportunities(): MarketOpportunity[] {
        return this.getOpportunities();
    }

    public getMonitoredMarkets(): MarketOpportunity[] {
        return Array.from(this.monitoredMarkets.values());
    }

    public getTrackedMarketsCount(): number {
        return this.trackedMarkets.size;
    }

    // ============================================================
    // PUBLIC API - MANUAL MARKET ADDITION
    // ============================================================

    public async addMarketByConditionId(conditionId: string): Promise<boolean> {
        try {
            const response = await this.rateLimiter.limit(() =>
                fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`)
            );

            if (!response.ok) {
                this.logger.warn(`Market not found: ${conditionId}`);
                return false;
            }

            const markets = await response.json();
            if (!markets || markets.length === 0) {
                this.logger.warn(`Market not found: ${conditionId}`);
                return false;
            }

            const market = markets[0];
            const seenConditionIds = new Set<string>();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);

            if (result.added && result.tokenIds.length > 0) {
                this.subscribeToTokens(result.tokenIds);
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error(`Failed to add market: ${error}`);
            return false;
        }
    }

    public async addMarketBySlug(slug: string): Promise<boolean> {
        try {
            const response = await this.rateLimiter.limit(() =>
                fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`)
            );

            if (!response.ok) {
                this.logger.warn(`Market not found: ${slug}`);
                return false;
            }

            const market = await response.json();
            if (!market || !market.conditionId) {
                this.logger.warn(`Market not found by slug: ${slug}`);
                return false;
            }

            const seenConditionIds = new Set<string>();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);

            if (result.added && result.tokenIds.length > 0) {
                this.subscribeToTokens(result.tokenIds);
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error(`Failed to add market by slug: ${error}`);
            return false;
        }
    }

    // ============================================================
    // PUBLIC API - LIFECYCLE
    // ============================================================

    public async start(): Promise<void> {
        if (this.isScanning) {
            this.logger.info('⚠️ Scanner is already running');
            return;
        }

        this.isScanning = true;
        this.logger.info('🚀 Starting MarketMakingScanner...');

        try {
            this.logger.info('🔍 Testing API connectivity...');
            await this.debugApiResponse();

            // STREAMLINED DISCOVERY: Try sampling markets first (has all fields including rewards)
            const usedSampling = await this.discoverFromSamplingMarkets();

            if (!usedSampling || this.trackedMarkets.size < 50) {
                this.logger.info('📡 Supplementing with category discovery...');
                await this.discoverFromCategories();
            }

            this.logger.info(`✅ Discovery complete. Tracking ${this.trackedMarkets.size} markets (Cap: ${this.MAX_TRACKED_MARKETS})`);

            // Start DB batch writer
            this.startDbBatchWriter();

            // Periodic refresh
            this.refreshInterval = setInterval(async () => {
                try {
                    this.logger.info('🔄 Refreshing markets...');
                    await this.refreshMarkets();
                    this.logger.info(`✅ Refresh complete. Tracking ${this.trackedMarkets.size} markets`);
                } catch (error) {
                    this.logger.error(`❌ Error during refresh: ${error}`);
                }
            }, this.config.refreshIntervalMs);

            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }

    public stop(): void {
        this.logger.info('🛑 Stopping market making scanner...');
        this.isScanning = false;

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }

        if (this.dbWriteInterval) {
            clearInterval(this.dbWriteInterval);
            this.dbWriteInterval = undefined;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        // Purge all resting orders
        this.logger.warn('[MM] Module Standby: Purging resting orders...');
        this.adapter.cancelAllOrders?.().catch(e => {
            this.logger.error(`Failed to purge MM orders on stop: ${e}`);
        });

        this.logger.warn('🛑 Scanner stopped');
    }

    public async forceRefresh(): Promise<void> {
        this.logger.info('🔄 [Forced Refresh] Manually triggering market discovery...');
        await this.refreshMarkets();
    }

    /**
     * Setup WebSocket listeners for centralized manager
     */
    private setupWebSocketListeners(): void {
        if (!this.wsManager) return;

        // Listen to price updates
        this.wsManager.on('price_update', (event: PriceEvent) => {
            this.handlePriceUpdate(event);
        });

        // Listen to trade events
        this.wsManager.on('trade', (event: TradeEvent) => {
            this.handleTradeEvent(event);
        });

        // Listen to new market events
        this.wsManager.on('new_market', (event: any) => {
            this.handleNewMarket(event);
        });

        // Listen to market resolved events
        this.wsManager.on('market_resolved', (event: any) => {
            this.handleMarketResolved(event);
        });

        // Listen to tick size change events
        this.wsManager.on('tick_size_change', (event: any) => {
            this.handleTickSizeChange(event);
        });

        // Listen to last trade price events for flash move detection
        this.wsManager.on('last_trade_price', (event: any) => {
            this.handleLastTradePrice(event);
        });

        this.logger.info('✅ Scanner connected to centralized WebSocket manager');
    }

    /**
     * Handle price updates from centralized manager
     */
    private handlePriceUpdate(event: PriceEvent): void {
        const { asset_id: tokenId, price } = event;
        const market = this.trackedMarkets.get(tokenId);
        
        if (market) {
            // Update market prices
            market.bestBid = Math.max(0.01, price - 0.01);
            market.bestAsk = Math.min(0.99, price + 0.01);
            market.spread = market.bestAsk - market.bestBid;
            
            // Emit book update event
            this.emit('book_update', {
                tokenId,
                bid: market.bestBid,
                ask: market.bestAsk,
                spread: market.spread,
                timestamp: event.timestamp
            });
        }
    }

    /**
     * Handle trade events from centralized manager
     */
    private handleTradeEvent(event: TradeEvent): void {
        const { asset_id: tokenId, price, size, side } = event;
        
        // Update market with trade data
        const market = this.trackedMarkets.get(tokenId);
        if (market) {
            market.bestBid = Math.max(0.01, price - 0.01);
            market.bestAsk = Math.min(0.99, price + 0.01);
            market.spread = market.bestAsk - market.bestBid;
            market.volume = (market.volume || 0) + size;
        }
    }

    /**
     * Subscribe to tokens using centralized manager
     */
    private subscribeToTokens(tokenIds: string[]): void {
        tokenIds.forEach(tokenId => {
            this.wsManager.subscribeToToken(tokenId);
        });
    }

    /**
     * Handle new market events from centralized manager
     */
    private handleNewMarket(event: any): void {
        const { conditionId, assetIds, question } = event;
        const outcomes = ['Yes', 'No'];

        this.logger.info(`🆕 NEW MARKET DETECTED: ${question}`);

        for (let i = 0; i < assetIds.length; i++) {
            const tokenId = assetIds[i];
            if (!this.trackedMarkets.has(tokenId) && this.trackedMarkets.size < this.MAX_TRACKED_MARKETS) {
                this.trackedMarkets.set(tokenId, {
                    conditionId,
                    tokenId,
                    question,
                    bestBid: 0,
                    bestAsk: 0,
                    spread: 0,
                    volume: 0,
                    liquidity: 0,
                    isNewMarket: true,
                    discoveredAt: Date.now(),
                    isYesToken: outcomes[i]?.toLowerCase() === 'yes' || i === 0,
                    pairedTokenId: assetIds[i === 0 ? 1 : 0],
                    status: 'active',
                    acceptingOrders: true
                });

                // Also subscribe via intelligence service for redundancy
                this.intelligence.subscribeToToken(tokenId);
            }
        }

        this.logger.success(`✨ Subscribed to new market: ${question.slice(0, 50)}...`);
    }

    /**
     * Handle market resolved events from centralized manager
     */
    private handleMarketResolved(event: any): void {
        const { conditionId, winningOutcome, winningAssetId, question } = event;

        if (this.resolvedMarkets.has(conditionId)) return;
        this.resolvedMarkets.add(conditionId);

        this.logger.info(`🏁 MARKET RESOLVED: ${question}`);
        this.logger.info(`🏆 Winner: ${winningOutcome} (${winningAssetId})`);

        // Remove from tracked markets
        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            if (market.conditionId === conditionId) {
                this.trackedMarkets.delete(tokenId);
            }
        }

        this.opportunities = this.opportunities.filter(o => o.conditionId !== conditionId);

        this.emit('marketResolved', {
            conditionId,
            winningOutcome,
            winningAssetId,
            question
        });
    }

    /**
     * Handle tick size change events from centralized manager
     */
    private handleTickSizeChange(event: any): void {
        const { tokenId, oldTickSize, newTickSize } = event;
 
        this.tickSizes.set(tokenId, {
            tokenId,
            tickSize: newTickSize,
            updatedAt: Date.now()
        });

        this.logger.warn(`📏 TICK SIZE CHANGE: ${tokenId} | ${oldTickSize} → ${newTickSize}`);

        this.emit('tickSizeChange', {
            tokenId,
            oldTickSize,
            newTickSize
        });
    }
 
    /**
     * Handle last trade price events - delegate to FlashMoveService
     */
    private handleLastTradePrice(event: any): void {
        // Delegate to FlashMoveService for unified detection
        // This removes duplicate detection logic and uses centralized system
        if (this.flashMoveService) {
            // FlashMoveService will handle detection via WebSocket events
            this.logger.debug(`Delegating flash move detection to FlashMoveService for token ${event.asset_id}`);
        }
    }
 
    // ============================================================
    // DISCOVERY - SAMPLING MARKETS (PRIMARY)
    // Per docs: getSamplingMarkets returns full Market objects with rewards
    // ============================================================
 
    private async discoverFromSamplingMarkets(): Promise<boolean> {
        try {
            const sampling = await this.adapter.getSamplingMarkets?.();
            if (!sampling || !Array.isArray(sampling) || sampling.length === 0) {
                this.logger.warn('No sampling markets available from adapter');
                return false;
            }
 
            this.logger.info(`🎯 Processing ${sampling.length} sampling markets`);
            const tokenIds: string[] = [];
 
            for (const market of sampling) {
                if (this.trackedMarkets.size >= this.MAX_TRACKED_MARKETS) break;
 
                // Per docs: Market object has condition_id, tokens[], rewards{max_spread, min_size}
                const tokens = market.tokens || [];
                const conditionId = market.condition_id;
 
                if (!conditionId || tokens.length !== 2) continue;
 
                for (let i = 0; i < tokens.length; i++) {
                    const token = tokens[i];
                    const tokenId = token.token_id;
 
                    if (!tokenId || this.trackedMarkets.has(tokenId)) continue;
 
                    const price = token.price || 0.5;
                    const isYesToken = token.outcome?.toLowerCase() === 'yes' || i === 0;
 
                    this.trackedMarkets.set(tokenId, {
                        conditionId,
                        tokenId,
                        question: market.question || market.description || 'Unknown',
                        image: market.image || market.icon,
                        marketSlug: market.market_slug,
                        bestBid: Math.max(0.01, price - 0.01),
                        bestAsk: Math.min(0.99, price + 0.01),
                        spread: 0.02,
                        volume: market.volume || 0,
                        liquidity: market.liquidity || 0,
                        isNewMarket: false,
                        discoveredAt: Date.now(),
                        rewardsMaxSpread: market.rewards?.max_spread,
                        rewardsMinSize: market.rewards?.min_size,
                        isYesToken,
                        pairedTokenId: tokens[i === 0 ? 1 : 0]?.token_id,
                        status: market.closed ? 'closed' : 'active',
                        acceptingOrders: market.accepting_orders !== false,
                        orderMinSize: market.minimum_order_size,
                        orderPriceMinTickSize: market.minimum_tick_size,
                        category: market.tags?.[0],
                        featured: market.featured
                    });
 
                    tokenIds.push(tokenId);
                    // Use centralized subscription method
                    this.subscribeToTokens([tokenId]);
                }
            }
 
            this.logger.success(`✅ Loaded ${tokenIds.length} tokens from sampling markets`);
            return tokenIds.length > 0;
        } catch (error) {
            this.logger.warn(`Sampling markets failed: ${error}`);
            return false;
        }
    }
 
    // ============================================================
    // DISCOVERY - CATEGORIES (FALLBACK)
    // ============================================================

    private async discoverFromCategories(): Promise<void> {
        const tagIds = await this.fetchTagIds();

        const priorityCategories = [
            'sports', 'politics', 'crypto', 'business', 'climate',
            'tech', 'elections', 'finance', 'mentions', 'geopolitics',
            'entertainment', 'science', 'world', 'earnings'
        ];

        const categoryEndpoint = (tagId: number, limit = 100) =>
            `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tagId}&related_tags=true&limit=${limit}&order=volume&ascending=false`;

        const endpoints = [
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false',
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=id&ascending=false',
            ...priorityCategories
                .filter(cat => tagIds[cat])
                .map(cat => categoryEndpoint(tagIds[cat]))
        ];

        const seenConditionIds = new Set<string>();

        for (const url of endpoints) {
            if (this.trackedMarkets.size >= this.MAX_TRACKED_MARKETS) break;

            try {
                const response = await this.rateLimiter.limit(() => fetch(url));
                if (!response.ok) continue;

                const events = await response.json();
                for (const event of events) {
                    for (const market of (event.markets || [])) {
                        if (this.trackedMarkets.size >= this.MAX_TRACKED_MARKETS) break;

                        const result = this.processMarketData(market, event, seenConditionIds);
                        if (result.added) {
                            // Use centralized subscription method
                            this.subscribeToTokens(result.tokenIds);
                        }
                    }
                }
            } catch (error) {
                this.logger.warn(`Category fetch failed: ${error}`);
            }
        }
    }
 
    private async fetchTagIds(): Promise<Record<string, number>> {
        const tagMap: Record<string, number> = {};
 
        try {
            const response = await this.rateLimiter.limit(() =>
                fetch('https://gamma-api.polymarket.com/tags?limit=300')
            );
 
            if (!response.ok) {
                this.logger.warn('Failed to fetch tags');
                return tagMap;
            }
 
            const tags = await response.json();
 
            for (const tag of tags) {
                const slug = (tag.slug || '').toLowerCase();
                const id = parseInt(tag.id);
 
                if (slug && id && !isNaN(id)) {
                    tagMap[slug] = id;
                }
            }
 
            this.logger.info(`📋 Loaded ${Object.keys(tagMap).length} tags`);
            return tagMap;
        } catch (error) {
            this.logger.warn(`Failed to fetch tags: ${error}`);
            return tagMap;
        }
    }
 
    private processMarketData(
        market: any,
        event: any,
        seenConditionIds: Set<string>
    ): { added: boolean; tokenIds: string[] } {
        const result = { added: false, tokenIds: [] as string[] };

        const conditionId = market.conditionId || market.condition_id;
        if (!conditionId || seenConditionIds.has(conditionId)) return result;

        // Structural filters only
        if (market.closed === true) return result;
        // Handle acceptingOrders with fallback logic
        const acceptingOrders = market.acceptingOrders ?? market.accepting_orders ?? true;
        if (acceptingOrders === false) {
            this.logger.debug(`[SCANNER] Skipping market ${conditionId} - not accepting orders`);
            return result;
        }
        if (market.active === false) return result;
        if (market.archived === true) return result;

        const rawTokenIds = market.clobTokenIds || market.clob_token_ids;
        const tokenIds = this.parseJsonArray(rawTokenIds);

        if (tokenIds.length !== 2) return result;

        seenConditionIds.add(conditionId);

        const volume = this.parseNumber(market.volumeNum || market.volume || 0);
        const liquidity = this.parseNumber(market.liquidityNum || market.liquidity || 0);
        const outcomes = this.parseJsonArray(market.outcomes) || ['Yes', 'No'];
        const outcomePrices = this.parseJsonArray(market.outcomePrices);
        const status = this.computeMarketStatus(market);
        const volume24hr = this.parseNumber(market.volume24hr || market.volume24hrClob || 0);
        const category = this.extractCategory(event, market);

        for (let i = 0; i < tokenIds.length; i++) {
            const tokenId = tokenIds[i];

            if (this.trackedMarkets.has(tokenId)) {
                const existing = this.trackedMarkets.get(tokenId)!;
                existing.volume = volume;
                existing.liquidity = liquidity;
                existing.status = status;
                existing.acceptingOrders = market.acceptingOrders !== false;
                existing.volume24hr = volume24hr;

                if (outcomePrices && outcomePrices[i]) {
                    const price = this.parseNumber(outcomePrices[i]);
                    if (price > 0 && price < 1) {
                        existing.bestBid = Math.max(0.01, price - 0.01);
                        existing.bestAsk = Math.min(0.99, price + 0.01);
                        existing.spread = existing.bestAsk - existing.bestBid;
                    }
                }
                continue;
            }

            const isYesToken = (outcomes[i]?.toLowerCase() === 'yes') || (i === 0);
            const pairedTokenId = tokenIds[i === 0 ? 1 : 0];

            let initialBid = 0;
            let initialAsk = 0;
            if (outcomePrices && outcomePrices[i]) {
                const price = this.parseNumber(outcomePrices[i]);
                if (price > 0 && price < 1) {
                    initialBid = Math.max(0.01, price - 0.01);
                    initialAsk = Math.min(0.99, price + 0.01);
                }
            }

            this.trackedMarkets.set(tokenId, {
                conditionId,
                tokenId,
                question: market.question || event.title || 'Unknown',
                image: market.image || market.icon || event.image || event.icon || '',
                marketSlug: market.slug || '',
                bestBid: initialBid,
                bestAsk: initialAsk,
                spread: initialAsk - initialBid,
                volume,
                liquidity,
                isNewMarket: market.new === true || this.isRecentlyCreated(market.createdAt),
                discoveredAt: Date.now(),
                rewardsMaxSpread: market.rewardsMaxSpread,
                rewardsMinSize: market.rewardsMinSize,
                isYesToken,
                pairedTokenId,
                status,
                acceptingOrders: market.acceptingOrders !== false,
                volume24hr,
                orderMinSize: this.parseNumber(market.orderMinSize || market.minimum_order_size || 5),
                orderPriceMinTickSize: this.parseNumber(market.orderPriceMinTickSize || market.minimum_tick_size || 0.01),
                category,
                featured: market.featured === true || event.featured === true,
                competitive: market.competitive
            });

            result.tokenIds.push(tokenId);
            result.added = true;
        }

        return result;
    }

    private async refreshMarkets(): Promise<void> {
        const usedSampling = await this.discoverFromSamplingMarkets();
        if (!usedSampling || this.trackedMarkets.size < 50) {
            await this.discoverFromCategories();
        }
        this.updateOpportunities();
    }
 
    // ============================================================
    // FLASH MOVE TRADE EXECUTION - DELEGATED TO FLASH MOVE SERVICE
    // Per docs: FAK (Fill-And-Kill) for partial fills
    // ============================================================
    // Flash move execution is now handled by FlashMoveService
    // This removes duplicate logic and uses unified detection/execution system
 
    // ============================================================
    // OPPORTUNITY EVALUATION
    // ============================================================
 
    private evaluateOpportunity(market: TrackedMarket): void {
        // Price validation
        if (market.bestBid <= 0 || market.bestAsk <= 0 || market.bestAsk <= market.bestBid) {
            return;
        }
 
        // Status validation
        if (market.status !== 'active' || !market.acceptingOrders) {
            return;
        }
 
        // Calculate metrics
        const spread = market.spread;
        const midpoint = (market.bestBid + market.bestAsk) / 2;
        const spreadCents = spread * 100;
        const spreadPct = midpoint > 0 ? (spread / midpoint) * 100 : 0;
 
        // Spread filters
        if (spreadCents < this.config.minSpreadCents) return;
        if (spreadCents > this.config.maxSpreadCents) return;
 
        // Check if still "new"
        const ageMinutes = (Date.now() - market.discoveredAt) / (1000 * 60);
        const isStillNew = market.isNewMarket && ageMinutes < this.config.newMarketAgeMinutes;
 
        // Build opportunity
        const opportunity: MarketOpportunity = {
            marketId: market.conditionId,
            conditionId: market.conditionId,
            tokenId: market.tokenId,
            question: market.question,
            image: market.image,
            marketSlug: market.marketSlug,
            bestBid: market.bestBid,
            bestAsk: market.bestAsk,
            spread,
            spreadPct,
            spreadCents,
            midpoint,
            volume: market.volume,
            liquidity: market.liquidity,
            isNewMarket: isStillNew,
            rewardsMaxSpread: market.rewardsMaxSpread,
            rewardsMinSize: market.rewardsMinSize,
            orderMinSize: market.orderMinSize,
            timestamp: Date.now(),
            roi: spreadPct,
            combinedCost: 1 - spread,
            capacityUsd: market.liquidity,
            skew: this.getInventorySkew(market.conditionId),
            status: market.status,
            acceptingOrders: market.acceptingOrders,
            volume24hr: market.volume24hr,
            category: market.category,
            featured: market.featured,
            isBookmarked: this.bookmarkedMarkets.has(market.conditionId),
            lastPriceMovePct: (market as any).lastPriceMovePct,
            isVolatile: (market as any).isVolatile
        };
 
        // Always update monitored list
        this.monitoredMarkets.set(market.tokenId, opportunity);
 
        // Apply volume/liquidity filters for actionable opportunities
        const effectiveMinVolume = isStillNew
            ? Math.max(100, this.config.minVolume * 0.1)
            : this.config.minVolume;
 
        const effectiveMinLiquidity = isStillNew
            ? Math.max(50, this.config.minLiquidity * 0.1)
            : this.config.minLiquidity;
 
        if (market.volume < effectiveMinVolume) return;
        if (market.liquidity < effectiveMinLiquidity) return;
 
        // Update opportunities list
        this.updateOpportunitiesInternal(opportunity);
    }
 
    private updateOpportunitiesInternal(opp: MarketOpportunity): void {
        const existingIdx = this.opportunities.findIndex(o => o.tokenId === opp.tokenId);
        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opp;
        } else {
            this.opportunities.push(opp);
        }
 
        // Queue for batch DB write
        this.queueDbWrite(opp);
 
        // Sort: new markets first, then by spread
        this.opportunities.sort((a, b) => {
            if (a.isNewMarket !== b.isNewMarket) return a.isNewMarket ? -1 : 1;
            return b.spreadCents - a.spreadCents;
        });

        this.emit('opportunity', opp);
    }

    private updateOpportunities(): void {
        for (const market of this.trackedMarkets.values()) {
            this.evaluateOpportunity(market);
        }
    }

    // ============================================================
    // DB BATCH WRITER
    // ============================================================

    private startDbBatchWriter(): void {
        this.dbWriteInterval = setInterval(async () => {
            if (this.pendingDbWrites.size === 0) return;

            const writes = Array.from(this.pendingDbWrites.values());
            this.pendingDbWrites.clear();

            try {
                const bulkOps = writes.map(opp => ({
                    updateOne: {
                        filter: { tokenId: opp.tokenId },
                        update: { $set: { ...opp, timestamp: new Date() } },
                        upsert: true
                    }
                }));

                await MoneyMarketOpportunity.bulkWrite(bulkOps);
                this.logger.debug(`💾 Batch wrote ${writes.length} opportunities to DB`);
            } catch (e) {
                this.logger.warn(`DB batch write failed: ${e}`);
            }
        }, this.config.dbBatchIntervalMs);
    }

    private queueDbWrite(opp: MarketOpportunity): void {
        this.pendingDbWrites.set(opp.tokenId, opp);
    }

    // ============================================================
    // DEBUG / UTILITIES
    // ============================================================

    public async debugApiResponse(): Promise<void> {
        try {
            const response = await fetch(
                'https://gamma-api.polymarket.com/events?closed=false&limit=5&order=volume&ascending=false'
            );
            const data = await response.json();

            this.logger.info('=== API TEST ===');
            this.logger.info(`Events count: ${data.length}`);

            if (data[0]) {
                this.logger.info(`First event: ${data[0].title}`);
                this.logger.info(`Markets count: ${data[0].markets?.length}`);

                if (data[0].markets?.[0]) {
                    const m = data[0].markets[0];
                    this.logger.info(`First market: ${m.question}`);
                    this.logger.info(`clobTokenIds: ${JSON.stringify(this.parseJsonArray(m.clobTokenIds))}`);
                    this.logger.info(`Volume: ${m.volume || m.volumeNum}`);
                    this.logger.info(`AcceptingOrders: ${m.acceptingOrders}`);
                }
            }

            const tagsResponse = await fetch('https://gamma-api.polymarket.com/tags?limit=10');
            const tags = await tagsResponse.json();
            this.logger.info(`Sample tags: ${tags.slice(0, 5).map((t: any) => `${t.id}:${t.slug}`).join(', ')}`);
        } catch (e) {
            this.logger.error(`API test failed: ${e}`);
        }
    }

    private parseJsonArray(value: any): string[] {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    }

    private parseNumber(value: any): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return parseFloat(value) || 0;
        return 0;
    }

    private computeMarketStatus(market: any): 'active' | 'closed' | 'resolved' | 'paused' {
        if (market.closed === true) return 'closed';
        if (market.umaResolutionStatus === 'resolved') return 'resolved';
        
        // Use fallback logic for acceptingOrders
        const acceptingOrders = market.acceptingOrders ?? market.accepting_orders ?? true;
        if (acceptingOrders === false) return 'paused';
        
        return 'active';
    }

    private isRecentlyCreated(createdAt: string | undefined): boolean {
        if (!createdAt) return false;
        try {
            const created = new Date(createdAt).getTime();
            const hoursSinceCreation = (Date.now() - created) / (1000 * 60 * 60);
            return hoursSinceCreation < 24;
        } catch {
            return false;
        }
    }

    private extractCategory(event: any, market?: any): string | undefined {
        // Primary: event.tags array per Gamma API docs
        if (event.tags && Array.isArray(event.tags) && event.tags.length > 0) {
            const tag = event.tags[0];
            const slug = (tag.slug || tag.label || '').toLowerCase();

            // Category normalization
            const categoryMap: Record<string, string[]> = {
                'sports': ['sport', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'tennis'],
                'elections': ['politic', 'election', 'president', 'congress', 'senate', 'governor'],
                'crypto': ['crypto', 'bitcoin', 'ethereum', 'btc', 'eth', 'defi', 'nft', 'web3'],
                'finance': ['finance', 'fed', 'interest', 'inflation', 'rates', 'bank'],
                'tech': ['tech', 'ai', 'artificial', 'software', 'hardware', 'apple', 'microsoft', 'google', 'meta'],
                'climate': ['climate', 'environment', 'carbon', 'global warming', 'renewable', 'sustainability'],
                'earnings': ['earnings', 'revenue', 'profit', 'eps', 'income', 'quarterly'],
                'world': ['world', 'global', 'europe', 'asia', 'china', 'russia', 'ukraine', 'middle east'],
                'mentions': ['mention', 'social', 'twitter', 'reddit', 'discord', 'tweet', 'influencer'],
                'business': ['business', 'economy', 'company', 'stock', 'market', 'gdp']
            };

            for (const [category, keywords] of Object.entries(categoryMap)) {
                if (keywords.some(kw => slug.includes(kw))) {
                    return category;
                }
            }

            return tag.slug || tag.label || undefined;
        }

        // Fallback: infer from slug
        const slug = (event.slug || market?.slug || '').toLowerCase();
        const categoryMap: Record<string, string[]> = {
            'sports': ['nfl', 'nba', 'super-bowl', 'world-series', 'stanley-cup', 'tennis', 'soccer'],
            'crypto': ['bitcoin', 'ethereum', 'crypto', 'btc', 'eth', 'defi', 'nft'],
            'elections': ['election', 'president', 'congress', 'senate', 'governor', 'vote', 'primary'],
            'finance': ['finance', 'fed', 'interest', 'inflation', 'rates', 'bank'],
            'tech': ['tech', 'ai', 'artificial', 'software', 'apple', 'microsoft', 'google'],
            'climate': ['climate', 'environment', 'carbon', 'global-warming', 'renewable'],
            'earnings': ['earnings', 'revenue', 'profit', 'eps', 'q1', 'q2', 'q3', 'q4'],
            'world': ['world', 'global', 'europe', 'asia', 'china', 'russia', 'ukraine'],
            'mentions': ['mention', 'social', 'twitter', 'reddit', 'discord', 'tweet'],
            'business': ['business', 'economy', 'company', 'stock', 'market', 'gdp', 'dow', 'nasdaq']
        };

        for (const [category, keywords] of Object.entries(categoryMap)) {
            if (keywords.some(kw => slug.includes(kw))) {
                return category;
            }
        }

        return undefined;
    }

    // ============================================================
    // CONFIG UPDATE
    // ============================================================

    public updateConfig(newConfig: Partial<MarketMakerConfig>): void {
        this.config = { ...this.config, ...newConfig };
        this.logger.info(`Config updated: ${JSON.stringify(this.config)}`);
    }

    public getConfig(): MarketMakerConfig {
        return { ...this.config };
    }
}