
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { WS_URLS } from '../config/env.js';
import { MarketIntelligenceService, FlashMoveEvent } from './market-intelligence.service.js';
import { MoneyMarketOpportunity } from '../database/index.js';
import EventEmitter from 'events';
// FIX: Added RawData to imports from 'ws'
import WebSocket, { RawData } from 'ws';

// Rate limiter utility
class RateLimiter {
    private lastRequestTime = 0;
    private delay: number;

    constructor(delayMs: number = 1500) {
        this.delay = delayMs;
    }

    async limit<T>(promise: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.delay) {
            await new Promise(resolve => 
                setTimeout(resolve, this.delay - timeSinceLastRequest)
            );
        }

        this.lastRequestTime = Date.now();
        return await promise();
    }
}

// ============================================
// INTERFACES (ENHANCED)
// ============================================

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
    // Compatibility fields for UI enrichment
    roi: number;
    combinedCost: number;
    capacityUsd: number;
    // Inventory skew
    skew?: number;
    // Status & Metadata for UI enrichment
    status: 'active' | 'closed' | 'resolved' | 'paused';
    acceptingOrders: boolean;
    volume24hr?: number;
    category?: string;
    featured?: boolean;
    isBookmarked?: boolean;
    // NEW: Volatility metrics
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
    // Track YES/NO token mapping
    isYesToken?: boolean;
    pairedTokenId?: string;
    // Status & metadata for UI enrichment
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
    // Risk management config
    priceMoveThresholdPct: number;    // Cancel orders if price moves X%
    maxInventoryPerToken: number;      // Max USD exposure per token
    autoMergeThreshold: number;        // Merge when pairs exceed this
    enableKillSwitch: boolean;         // Enable emergency stop
}

// Risk Management Interfaces
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

// ============================================
// MAIN SCANNER CLASS (ENHANCED)
// ============================================

export class MarketMakingScanner extends EventEmitter {
    // Core state
    public isScanning = false;
    private isConnected = false;
    private userWs?: WebSocket; // NEW: Private User Channel
    private trackedMarkets: Map<string, TrackedMarket> = new Map();
    private monitoredMarkets: Map<string, MarketOpportunity> = new Map();// All discovered markets for tab filtering
    private opportunities: MarketOpportunity[] = [];
    private userPingInterval?: NodeJS.Timeout; // NEW: Hearbeat for user channel
    private refreshInterval?: NodeJS.Timeout;
    private rateLimiter = new RateLimiter(1500); // 1.5 seconds between requests

    // Risk management state
    private lastMidpoints: Map<string, number> = new Map();
    private inventoryBalances: Map<string, InventoryBalance> = new Map();
    private tickSizes: Map<string, TickSizeInfo> = new Map();
    private resolvedMarkets: Set<string> = new Set();
    private killSwitchActive = false;
    private bookmarkedMarkets: Set<string> = new Set(); 
    private activeQuoteTokens: Set<string> = new Set();

    /**
     * Initialize bookmarks from storage
     * @param bookmarks Array of market IDs to bookmark
     */
    public initializeBookmarks(bookmarks: string[]): void {
        this.bookmarkedMarkets = new Set(bookmarks);
        this.logger.info(`Initialized ${this.bookmarkedMarkets.size} bookmarked markets`);
    }

    // Default config (EXTENDED)
    private config: MarketMakerConfig = {
        minSpreadCents: 1, 
        maxSpreadCents: 15,
        minVolume: 5000,
        minLiquidity: 1000,
        preferRewardMarkets: true,
        preferNewMarkets: true,
        newMarketAgeMinutes: 60,
        refreshIntervalMs: 5 * 60 * 1000,
        // Risk defaults
        priceMoveThresholdPct: 5,
        maxInventoryPerToken: 500,
        autoMergeThreshold: 100,
        enableKillSwitch: true
    };

    constructor(
        private intelligence: MarketIntelligenceService,
        private adapter: IExchangeAdapter, 
        private logger: Logger
    ) {
        super();
        
        // Listen to the shared Intelligence Hub for market data
        this.intelligence.on('book_update', (msg) => this.handleBookUpdate(msg));
        this.intelligence.on('price_update', (data) => this.handlePriceUpdate(data));
        this.intelligence.on('flash_move', (event) => this.handleFlashMove(event));
    }

    async start() {
        if (this.isScanning) {
            this.logger.info('⚠️ Scanner is already running');
            return;
        }
        
        this.isScanning = true;
        this.logger.info('🚀 Starting MarketMakingScanner...');

        try {
            // Debug API before discovery
            this.logger.info('🔍 Testing API connectivity...');
            await this.debugApiResponse();
            
            this.logger.info('🌐 Starting initial market discovery...');
            await this.discoverMarkets();
            
            this.logger.info(`✅ Initial discovery complete. Tracking ${this.trackedMarkets.size} markets`);
            
            this.logger.info('🔌 Connecting to User Channel...');
            this.connectUserChannel(); // Hook into private fill feed
            
            this.refreshInterval = setInterval(async () => {
                try {
                    this.logger.info('🔄 Refreshing markets...');
                    await this.discoverMarkets();
                    this.logger.info(`✅ Market refresh complete. Tracking ${this.trackedMarkets.size} markets`);
                    
                    // Log some stats about tracked markets
                    if (this.trackedMarkets.size > 0) {
                        const sampleMarket = Array.from(this.trackedMarkets.values())[0];
                        this.logger.info(`📊 Sample market: ${sampleMarket.question?.substring(0, 50)}...`);
                        this.logger.info(`   Bid: ${sampleMarket.bestBid} | Ask: ${sampleMarket.bestAsk} | Spread: ${sampleMarket.spread.toFixed(4)}`);
                    }
                    
                    this.logger.info(`🔄 Next refresh in ${this.config.refreshIntervalMs / 1000} seconds`);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.logger.error(`❌ Error during market refresh: ${errorMessage}`);
                }
            }, this.config.refreshIntervalMs);
            
            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');
            this.logger.info(`🔍 Currently tracking ${this.trackedMarkets.size} markets`);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }

    /**
     * Forced refresh for manual sync via UI.
     */
    public async forceRefresh() {
        this.logger.info('🔄 [Forced Refresh] Manually triggering market discovery...');
        await this.discoverMarkets();
    }

    /**
     * Implementation of hasActiveQuotes to solve TypeError in server.ts
     */
    public hasActiveQuotes(tokenId: string): boolean {
        return this.activeQuoteTokens.has(tokenId);
    }

    /**
     * Updates the internal set of tokens that have active quotes
     */
    public setActiveQuotes(tokenIds: string[]): void {
        this.activeQuoteTokens = new Set(tokenIds);
    }

    /**
     * PRODUCTION: Fetch ALL available tag IDs from Gamma API
     * Dynamically discovers all categories - no hardcoding
     */
    private async fetchTagIds(): Promise<Record<string, number>> {
        const tagMap: Record<string, number> = {};
        
        try {
            const response = await this.rateLimiter.limit(() => 
                fetch('https://gamma-api.polymarket.com/tags?limit=200')
            );
            
            if (!response.ok) {
                this.logger.warn('Failed to fetch tags');
                return tagMap;
            }
            
            const tags = await response.json();
            
            // Store ALL tags by their slug - catches everything dynamically
            for (const tag of tags) {
                const slug = (tag.slug || '').toLowerCase();
                const id = parseInt(tag.id);
                
                if (slug && id && !isNaN(id)) {
                    tagMap[slug] = id;
                }
            }
            
            this.logger.info(`📋 Loaded ${Object.keys(tagMap).length} tags: ${Object.keys(tagMap).join(', ')}`);
            return tagMap;
            
        } catch (error) {
            this.logger.warn(`Failed to fetch tags: ${error}`);
            return tagMap;
        }
    }

    /**
     * PRODUCTION: Multi-source market discovery
     */
    private async discoverMarkets() {
        this.logger.info('📡 Discovering markets from Gamma API...');
        
        try {
            let samplingTokens = new Set<string>();
            try {
                const sampling = await this.adapter.getSamplingMarkets?.();
                if (sampling && Array.isArray(sampling)) {
                    sampling.forEach(m => samplingTokens.add(m.token_id));
                    this.logger.info(`🎯 Scouted ${samplingTokens.size} reward-eligible pools.`);
                }
            } catch (e) {}

            const tagIds = await this.fetchTagIds();
            
            // Priority categories to fetch (if they exist)
            const priorityCategories = [
                'sports', 'politics', 'crypto', 'business', 'climate', 
                'tech', 'elections', 'finance', 'mentions', 'geopolitics',
                'entertainment', 'science', 'world', 'earnings'
            ];
            
            const categoryEndpoint = (tagId: number, limit = 100) =>
                `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tagId}&related_tags=true&limit=${limit}&order=volume&ascending=false`;

            const endpoints = [
                // Trending & newest
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=volume&ascending=false',
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=30&order=id&ascending=false',
                
                // Dynamic category endpoints - only adds if tag exists
                ...priorityCategories
                    .filter(cat => tagIds[cat])
                    .map(cat => categoryEndpoint(tagIds[cat]))
            ];

            const seenConditionIds = new Set<string>();

            for (const url of endpoints) {
                try {
                    const response = await this.rateLimiter.limit(() => fetch(url));
                    if (!response.ok) continue;
                    
                    const events = await response.json();
                    for (const event of events) {
                        for (const market of (event.markets || [])) {
                            const rawTokenIds = market.clobTokenIds || market.clob_token_ids;
                            const tokenIds = this.parseJsonArray(rawTokenIds);
                            
                            if (tokenIds.length > 0) {
                                // Tell the global hub we are interested in these books
                                tokenIds.forEach((id: string) => this.intelligence.subscribeToToken(id));
                                // Re-process structural data
                                this.processMarketData(market, event, seenConditionIds);
                            }
                        }
                    }
                } catch (error) {
                    this.logger.warn(`Error in discovery: ${error}`);
                }
            }

            this.logger.info(`✅ Tracking ${this.trackedMarkets.size} tokens total`);
            this.updateOpportunities();

        } catch (error) {
            this.logger.error('❌ Failed to discover markets:', error instanceof Error ? error : new Error(String(error)));
        }
    }
    
    /**
     * PRODUCTION: Process a single market from API response
     */
    private processMarketData(
        market: any, 
        event: any, 
        seenConditionIds: Set<string>
    ): { added: boolean; tokenIds: string[] } {
        const result = { added: false, tokenIds: [] as string[] };
        const conditionId = market.conditionId || market.condition_id;
        if (!conditionId) return result;
        
        if (seenConditionIds.has(conditionId)) return result;

        if (market.closed === true || market.acceptingOrders === false || market.active === false || market.archived === true) {
            return result;
        }

        const rawTokenIds = market.clobTokenIds || market.clob_token_ids;
        const tokenIds = this.parseJsonArray(rawTokenIds);
        
        if (tokenIds.length !== 2) return result;

        seenConditionIds.add(conditionId);

        const volume = this.parseNumber(market.volumeNum || market.volume || 0);
        const liquidity = this.parseNumber(market.liquidityNum || market.liquidity || 0);
        const outcomes = this.parseJsonArray(market.outcomes) || ['Yes', 'No'];
        const status = this.computeMarketStatus(market);
        const category = this.extractCategory(event, market);

        for (let i = 0; i < tokenIds.length; i++) {
            const tokenId = tokenIds[i];

            if (this.trackedMarkets.has(tokenId)) {
                const existing = this.trackedMarkets.get(tokenId)!;
                existing.volume = volume;
                existing.liquidity = liquidity;
                existing.status = status;
                continue;
            }

            const isYesToken = (outcomes[i]?.toLowerCase() === 'yes') || (i === 0);
            const pairedTokenId = tokenIds[i === 0 ? 1 : 0];

            this.trackedMarkets.set(tokenId, {
                conditionId,
                tokenId,
                question: market.question || event.title || 'Unknown',
                image: market.image || event.image || '',
                marketSlug: market.slug || '',
                bestBid: 0,
                bestAsk: 0,
                spread: 0,
                volume,
                liquidity,
                isNewMarket: market.new === true,
                discoveredAt: Date.now(),
                isYesToken,
                pairedTokenId,
                status,
                category,
                acceptingOrders: true
            });

            result.tokenIds.push(tokenId);
            result.added = true;
        }

        return result;
    }

    /**
     * PRODUCTION: Parse JSON string to array
     */
    private parseJsonArray(value: any): string[] {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    /**
     * PRODUCTION: Parse number from string or number
     */
    private parseNumber(value: any): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return parseFloat(value) || 0;
        return 0;
    }

    /**
     * PRODUCTION: Compute market status from API fields
     */
    private computeMarketStatus(market: any): 'active' | 'closed' | 'resolved' | 'paused' {
        if (market.closed === true) return 'closed';
        if (market.umaResolutionStatus === 'resolved') return 'resolved';
        if (market.acceptingOrders === false) return 'paused';
        return 'active';
    }

    /**
     * PRODUCTION: Extract category from event tags
     * Per docs: event.tags is array of { id, label, slug }
     */
    private extractCategory(event: any, market?: any): string | undefined {
        // Primary: use event tags array (per Gamma API docs)
        if (event.tags && Array.isArray(event.tags) && event.tags.length > 0) {
            const tag = event.tags[0];
            const slug = (tag.slug || tag.label || '').toLowerCase();
            
            // Normalize to standard categories
            if (slug.includes('sport') || slug.includes('nfl') || slug.includes('nba') || 
                slug.includes('mlb') || slug.includes('nhl') || slug.includes('soccer') ||
                slug.includes('football') || slug.includes('basketball') || slug.includes('tennis')) {
                return 'sports';
            }
            if (slug.includes('politic') || slug.includes('election') || slug.includes('president') ||
                slug.includes('congress') || slug.includes('senate') || slug.includes('governor')) {
                return 'elections';
            }
            if (slug.includes('crypto') || slug.includes('bitcoin') || slug.includes('ethereum') ||
                slug.includes('btc') || slug.includes('eth') || slug.includes('defi') || 
                slug.includes('nft') || slug.includes('web3')) {
                return 'crypto';
            }
            if (slug.includes('finance') || slug.includes('fed') || slug.includes('interest') || 
                slug.includes('inflation') || slug.includes('rates') || slug.includes('bank')) {
                return 'finance';
            }
            if (slug.includes('tech') || slug.includes('ai') || slug.includes('artificial') || 
                slug.includes('software') || slug.includes('hardware') || slug.includes('apple') ||
                slug.includes('microsoft') || slug.includes('google') || slug.includes('meta')) {
                return 'tech';
            }
            if (slug.includes('climate') || slug.includes('environment') || slug.includes('carbon') ||
                slug.includes('global warming') || slug.includes('renewable') || 
                slug.includes('sustainability')) {
                return 'climate';
            }
            if (slug.includes('earnings') || slug.includes('revenue') || slug.includes('profit') ||
                slug.includes('eps') || slug.includes('income') || slug.includes('quarterly')) {
                return 'earnings';
            }
            if (slug.includes('world') || slug.includes('global') || slug.includes('europe') ||
                slug.includes('asia') || slug.includes('china') || slug.includes('russia') ||
                slug.includes('ukraine') || slug.includes('middle east')) {
                return 'world';
            }
            if (slug.includes('mention') || slug.includes('social') || slug.includes('twitter') ||
                slug.includes('reddit') || slug.includes('discord') || slug.includes('tweet') ||
                slug.includes('influencer')) {
                return 'mentions';
            }
            if (slug.includes('business') || slug.includes('economy') || slug.includes('company') ||
                slug.includes('stock') || slug.includes('market') || slug.includes('gdp')) {
                return 'business';
            }
            
            // Return raw slug if no match
            return tag.slug || tag.label || undefined;
        }
        
        // Fallback: infer from event/market slug
        const slug = (event.slug || market?.slug || '').toLowerCase();
        
        // Expanded slug-based categorization
        if (slug.includes('nfl') || slug.includes('nba') || slug.includes('super-bowl') || 
            slug.includes('world-series') || slug.includes('stanley-cup') || slug.includes('tennis') ||
            slug.includes('soccer') || slug.includes('football') || slug.includes('basketball')) {
            return 'sports';
        }
        if (slug.includes('bitcoin') || slug.includes('ethereum') || slug.includes('crypto') ||
            slug.includes('btc') || slug.includes('eth') || slug.includes('defi') || 
            slug.includes('nft') || slug.includes('web3')) {
            return 'crypto';
        }
        if (slug.includes('election') || slug.includes('president') || slug.includes('congress') ||
            slug.includes('senate') || slug.includes('governor') || slug.includes('vote') ||
            slug.includes('primary') || slug.includes('democrat') || slug.includes('republican')) {
            return 'elections';
        }
        if (slug.includes('finance') || slug.includes('fed') || slug.includes('interest') || 
            slug.includes('inflation') || slug.includes('rates') || slug.includes('bank') ||
            slug.includes('finance') || slug.includes('stocks') || slug.includes('bonds')) {
            return 'finance';
        }
        if (slug.includes('tech') || slug.includes('ai') || slug.includes('artificial') || 
            slug.includes('software') || slug.includes('hardware') || slug.includes('apple') ||
            slug.includes('microsoft') || slug.includes('google') || slug.includes('meta') ||
            slug.includes('amazon') || slug.includes('tesla')) {
            return 'tech';
        }
        if (slug.includes('climate') || slug.includes('environment') || slug.includes('carbon') ||
            slug.includes('global-warming') || slug.includes('renewable') || 
            slug.includes('sustainability') || slug.includes('green') || slug.includes('emission')) {
            return 'climate';
        }
        if (slug.includes('earnings') || slug.includes('revenue') || slug.includes('profit') ||
            slug.includes('eps') || slug.includes('income') || slug.includes('quarterly') ||
            slug.includes('q1') || slug.includes('q2') || slug.includes('q3') || slug.includes('q4')) {
            return 'earnings';
        }
        if (slug.includes('world') || slug.includes('global') || slug.includes('europe') ||
            slug.includes('asia') || slug.includes('china') || slug.includes('russia') ||
            slug.includes('ukraine') || slug.includes('middle-east') || slug.includes('united-nations') ||
            slug.includes('nato') || slug.includes('eu') || slug.includes('brexit')) {
            return 'world';
        }
        if (slug.includes('mention') || slug.includes('social') || slug.includes('twitter') ||
            slug.includes('reddit') || slug.includes('discord') || slug.includes('tweet') ||
            slug.includes('influencer') || slug.includes('viral') || slug.includes('trending')) {
            return 'mentions';
        }
        if (slug.includes('business') || slug.includes('economy') || slug.includes('company') ||
            slug.includes('stock') || slug.includes('market') || slug.includes('gdp')) {
            return 'business';
        }
        
        return undefined;
    }

    /**
     * Debug method to test API responses
     */
    async debugApiResponse() {
        try {
            // Test basic endpoint
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
                    this.logger.info(`First market question: ${m.question}`);
                    this.logger.info(`clobTokenIds type: ${typeof m.clobTokenIds}`);
                    this.logger.info(`clobTokenIds value: ${m.clobTokenIds}`);
                    this.logger.info(`Parsed tokens: ${JSON.stringify(this.parseJsonArray(m.clobTokenIds))}`);
                    this.logger.info(`Volume: ${m.volume} ${m.volumeNum}`);
                    this.logger.info(`Closed: ${m.closed}`);
                    this.logger.info(`AcceptingOrders: ${m.acceptingOrders}`);
                }
            }
            
            // Test tags endpoint
            const tagsResponse = await fetch('https://gamma-api.polymarket.com/tags?limit=20');
            const tags = await tagsResponse.json();
            this.logger.info('\n=== TAGS ===');
            this.logger.info(`Sample tags: ${tags.slice(0, 5).map((t: any) => `${t.id}: ${t.slug}`).join(', ')}`);
            
        } catch (e) {
            this.logger.error(`API test failed: ${e}`);
        }
    }
    
     /**
     * PRODUCTION: HFT UPGRADE: Connect to the private User Channel
     * Listen for ORDER_FILLED events to trigger immediate re-quotes.
     */
    private connectUserChannel() {
        if (!this.isScanning) return;
        const userWsUrl = `${WS_URLS.CLOB}/ws/user`;
        this.logger.info(`🔌 Connecting to private User Channel: ${userWsUrl}`);
        
        this.userWs = new WebSocket(userWsUrl);
        const wsAny = this.userWs as any;

        wsAny.on('open', () => {
            this.logger.success('✅ User Channel Connected');
            
            // Standardized ping interval (20 seconds)
            if (this.userPingInterval) clearInterval(this.userPingInterval);
            this.userPingInterval = setInterval(() => {
                try {
                    if (this.userWs?.readyState === 1) {
                        // Use WebSocket 'send' for compatibility
                        this.userWs.send(JSON.stringify({ type: 'ping' }));
                    }
                } catch (error) {
                    this.logger.warn('Ping failed, reconnecting...');
                    if (this.userPingInterval) clearInterval(this.userPingInterval);
                    setTimeout(() => this.connectUserChannel(), 5000);
                }
            }, 20000); // Standardized 20s interval
        });

        // FIX: Replaced RawData with imported type from ws
        wsAny.on('message', (data: RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.event_type === 'order_filled') {
                    const tokenId = msg.asset_id;
                    const market = this.trackedMarkets.get(tokenId);
                    if (market) {
                        this.logger.success(`⚡ [HFT FILL] Fill detected for ${market.question.slice(0, 20)}... Re-evaluating.`);
                        this.evaluateOpportunity(market);
                    }
                }
            } catch (e) {}
        });
        
        wsAny.on('close', () => {
            if (this.userPingInterval) clearInterval(this.userPingInterval);
            if (this.isScanning) setTimeout(() => this.connectUserChannel(), 5000);
        });
    }

    private handlePriceUpdate(data: { tokenId: string, price: number }) {
        if (!this.isScanning) return;
        
        const market = this.trackedMarkets.get(data.tokenId);
        if (market) {
            // Check for volatility against threshold
            const lastMid = this.lastMidpoints.get(data.tokenId);
            if (lastMid && lastMid > 0) {
                const movePct = Math.abs(data.price - lastMid) / lastMid * 100;
                if (movePct > this.config.priceMoveThresholdPct) {
                    // Volatility alert logic already handled by handleLastTradePrice/Intelligence hub
                }
            }
            this.lastMidpoints.set(data.tokenId, data.price);
        }

        // Update local opportunity cache for UI consistency
        const opp = this.opportunities.find(o => o.tokenId === data.tokenId);
        if (opp) {
            opp.midpoint = data.price;
            opp.timestamp = Date.now();
        }
    }

    private handleFlashMove(event: FlashMoveEvent) {
        if (!this.isScanning) return;
        
        const market = this.trackedMarkets.get(event.tokenId);
        if (market) {
            const movePct = Math.abs(event.velocity) * 100;
            if (this.config.enableKillSwitch && movePct > 80) {
                this.triggerKillSwitch(`Extreme Volatility Spike (${movePct.toFixed(1)}%) on ${event.tokenId}`);
            }
        }
    }

    private handleBookUpdate(msg: any) {
        if (this.killSwitchActive || !this.isScanning) return;

        const tokenId = msg.asset_id;
        const bids = msg.bids || [];
        const asks = msg.asks || [];

        if (bids.length === 0 || asks.length === 0) return;

        const bestBid = parseFloat(bids[0].price);
        const bestAsk = parseFloat(asks[0].price);
        
        let market = this.trackedMarkets.get(tokenId);
        if (!market) return;

        market.bestBid = bestBid;
        market.bestAsk = bestAsk;
        market.spread = bestAsk - bestBid;

        this.evaluateOpportunity(market);
    }

    private handleMarketResolved(msg: any) {
        const conditionId = msg.market;
        const winningOutcome = msg.winning_outcome;
        const winningAssetId = msg.winning_asset_id;
        const question = msg.question || 'Unknown';

        if (this.resolvedMarkets.has(conditionId)) return;
        this.resolvedMarkets.add(conditionId);

        this.logger.info(`🏁 MARKET RESOLVED: ${question}`);
        this.logger.info(`🏆 Winner: ${winningOutcome} (${winningAssetId})`);

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

    private handleTickSizeChange(msg: any) {
        const tokenId = msg.asset_id;
        const oldTickSize = msg.old_tick_size;
        const newTickSize = msg.new_tick_size;

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
     * PRODUCTION: Evaluate if a market meets our opportunity criteria
     * Central place for all filtering logic - only structural filters in processMarketData
     */
    private evaluateOpportunity(market: TrackedMarket) {
        // 1. Price data validation - must have valid bid/ask with positive spread
        if (market.bestBid <= 0 || market.bestAsk <= 0 || market.bestAsk <= market.bestBid) {
            return; // No valid price data yet
        }
        
        // 2. Market status - must be active and accepting orders
        if (market.status !== 'active' || !market.acceptingOrders) {
            return;
        }
        
        // 3. Calculate spread metrics
        const spread = market.spread;
        const midpoint = (market.bestBid + market.bestAsk) / 2;
        const spreadCents = spread * 100;
        const spreadPct = midpoint > 0 ? (spread / midpoint) * 100 : 0;
        
        // 4. Apply spread filters from config
        if (spreadCents < this.config.minSpreadCents) return;
        if (spreadCents > this.config.maxSpreadCents) return;
        
        // 5. Check if market is still considered "new" for relaxed requirements
        const ageMinutes = (Date.now() - market.discoveredAt) / (1000 * 60);
        const isStillNew = market.isNewMarket && ageMinutes < this.config.newMarketAgeMinutes;
        
        // 6. Apply volume/liquidity filters with relaxed thresholds for new markets
        const effectiveMinVolume = isStillNew ? 
            Math.max(100, this.config.minVolume * 0.1) : // At least $100 for new markets
            this.config.minVolume;
            
        const effectiveMinLiquidity = isStillNew ? 
            Math.max(50, this.config.minLiquidity * 0.1) : // At least $50 for new markets
            this.config.minLiquidity;
            
        // We always add to monitored list, but only opportunities get special treatment
        const opportunity: MarketOpportunity = {
            marketId: market.conditionId,
            conditionId: market.conditionId,
            tokenId: market.tokenId,
            question: market.question,
            image: market.image,
            marketSlug: market.marketSlug,
            bestBid: market.bestBid,
            bestAsk: market.bestAsk,
            spread: spread,
            spreadPct: spreadPct,
            spreadCents: spreadCents,
            midpoint: midpoint,
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
            isBookmarked: this.bookmarkedMarkets.has(market.conditionId)
        };

        // Always update monitored list
        this.monitoredMarkets.set(market.tokenId, opportunity);

        // Check strict MM filters for the actionable opportunities array
        if (market.volume < effectiveMinVolume) return;
        if (market.liquidity < effectiveMinLiquidity) return;
        
        // 9. Update opportunities
        this.updateOpportunitiesInternal(opportunity);
    }

    private async updateOpportunitiesInternal(opp: MarketOpportunity) {
        const existingIdx = this.opportunities.findIndex(o => o.tokenId === opp.tokenId);
        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opp;
        } else {
            this.opportunities.push(opp);
        }

        try {
            await MoneyMarketOpportunity.findOneAndUpdate(
                { tokenId: opp.tokenId },
                { ...opp, timestamp: new Date() },
                { upsert: true }
            );
        } catch (dbErr) {}

        this.opportunities.sort((a, b) => {
            if (a.isNewMarket !== b.isNewMarket) return a.isNewMarket ? -1 : 1;
            return b.spreadCents - a.spreadCents;
        });

        this.emit('opportunity', opp);
    }

    private updateOpportunities() {
        for (const [tokenId, market] of this.trackedMarkets.entries()) {
            this.evaluateOpportunity(market);
        }
    }
    
    // FIX: Added stop() method to support engine-level stop calls
    public stop() {
        this.isScanning = false;
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        if (this.userPingInterval) {
            clearInterval(this.userPingInterval);
            this.userPingInterval = undefined;
        }
        if (this.userWs) {
            // FIX: Using Node-style terminate() for ws package instance
            (this.userWs as any).terminate?.() || (this.userWs as any).close?.();
            this.userWs = undefined;
        }
        this.logger.warn('📊 MM Scanner Stopped.');
    }

    // FIX: Added addMarketByConditionId() method to support manual market additions
    public async addMarketByConditionId(conditionId: string): Promise<boolean> {
        try {
            const response = await this.rateLimiter.limit(() => 
                fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`)
            );
            if (!response.ok) return false;
            const markets = await response.json();
            if (markets && markets.length > 0) {
                const seen = new Set<string>();
                const market = markets[0];
                const res = this.processMarketData(market, { title: market.question }, seen);
                if (res.added) {
                    res.tokenIds.forEach(tid => this.intelligence.subscribeToToken(tid));
                    this.updateOpportunities();
                    return true;
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // FIX: Added addMarketBySlug() method to support manual market additions by slug
    public async addMarketBySlug(slug: string): Promise<boolean> {
        try {
            const response = await this.rateLimiter.limit(() => 
                fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`)
            );
            if (!response.ok) return false;
            const markets = await response.json();
            if (markets && markets.length > 0) {
                const seen = new Set<string>();
                const market = markets[0];
                const res = this.processMarketData(market, { title: market.question }, seen);
                if (res.added) {
                    res.tokenIds.forEach(tid => this.intelligence.subscribeToToken(tid));
                    this.updateOpportunities();
                    return true;
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    // FIX: Added bookmarkMarket() method for UI interaction
    public bookmarkMarket(conditionId: string): void {
        this.bookmarkedMarkets.add(conditionId);
        this.updateOpportunities();
    }

    // FIX: Added unbookmarkMarket() method for UI interaction
    public unbookmarkMarket(conditionId: string): void {
        this.bookmarkedMarkets.delete(conditionId);
        this.updateOpportunities();
    }

    // FIX: Added getBookmarkedOpportunities() method for UI filtering
    public getBookmarkedOpportunities(): MarketOpportunity[] {
        return Array.from(this.monitoredMarkets.values()).filter(o => this.bookmarkedMarkets.has(o.conditionId));
    }

    getOpportunities(maxAgeMs = 600000): MarketOpportunity[] {
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

    getLatestOpportunities(): MarketOpportunity[] {
        return this.getOpportunities();
    }

    getMonitoredMarkets(): MarketOpportunity[] {
        return Array.from(this.monitoredMarkets.values());
    }

    getInventorySkew(conditionId: string): number {
        return 0;
    }

    getTickSize(tokenId: string): string {
        const info = this.tickSizes.get(tokenId);
        return info?.tickSize || '0.01';
    }

    triggerKillSwitch(reason: string) {
        if (!this.config.enableKillSwitch) return;
        this.killSwitchActive = true;
        this.logger.error(`🚨 KILL SWITCH TRIGGERED: ${reason}`);
        this.emit('killSwitch', { reason, timestamp: Date.now() });
    }

    resetKillSwitch() {
        this.killSwitchActive = false;
        this.logger.info('🔄 Kill switch reset');
    }

    isKillSwitchActive(): boolean {
        return this.killSwitchActive;
    }

    getTrackedMarket(marketId: string): MarketOpportunity | undefined {
        return this.monitoredMarkets.get(marketId) || this.opportunities.find(o => o.marketId === marketId);
    }
}
