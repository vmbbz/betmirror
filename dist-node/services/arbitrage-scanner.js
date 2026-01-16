import { WS_URLS } from '../config/env.js';
import { MoneyMarketOpportunity } from '../database/index.js';
import EventEmitter from 'events';
import WebSocket from 'ws';
// ============================================================
// RATE LIMITER (Token Bucket - Optimized for Gamma API: 4000 req/10s)
// ============================================================
class RateLimiter {
    tokens;
    lastRefill;
    maxTokens;
    refillRate;
    constructor(maxTokens = 400, refillRatePerSecond = 40) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRate = refillRatePerSecond;
        this.lastRefill = Date.now();
    }
    async limit(fn) {
        this.refill();
        if (this.tokens < 1) {
            const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
            await new Promise(r => setTimeout(r, waitTime));
            this.refill();
        }
        this.tokens--;
        return fn();
    }
    refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }
}
// ============================================================
// MAIN SCANNER CLASS (PRODUCTION GRADE)
// ============================================================
export class MarketMakingScanner extends EventEmitter {
    intelligence;
    adapter;
    logger;
    // Core state
    isScanning = false;
    isConnected = false;
    ws;
    userWs;
    trackedMarkets = new Map();
    monitoredMarkets = new Map();
    opportunities = [];
    pingInterval;
    userPingInterval;
    refreshInterval;
    reconnectAttempts = 0;
    reconnectTimeout;
    maxReconnectAttempts = 10;
    maxReconnectDelay = 30000;
    rateLimiter = new RateLimiter();
    // Risk management state
    MAX_TRACKED_MARKETS = 1000;
    lastMidpoints = new Map();
    inventoryBalances = new Map();
    tickSizes = new Map();
    resolvedMarkets = new Set();
    killSwitchActive = false;
    bookmarkedMarkets = new Set();
    activeQuoteTokens = new Set();
    // DB batch writing
    pendingDbWrites = new Map();
    dbWriteInterval;
    // Default config
    config = {
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
    constructor(intelligence, adapter, logger) {
        super();
        this.intelligence = intelligence;
        this.adapter = adapter;
        this.logger = logger;
        this.intelligence.on('book_update', (msg) => this.handleBookUpdate(msg));
    }
    // ============================================================
    // PUBLIC API - BOOKMARKS
    // ============================================================
    initializeBookmarks(bookmarks) {
        this.bookmarkedMarkets = new Set(bookmarks);
        this.logger.info(`Initialized ${this.bookmarkedMarkets.size} bookmarked markets`);
    }
    bookmarkMarket(conditionId) {
        this.bookmarkedMarkets.add(conditionId);
        this.logger.info(`📌 Bookmarked market: ${conditionId}`);
    }
    unbookmarkMarket(conditionId) {
        this.bookmarkedMarkets.delete(conditionId);
        this.logger.info(`📌 Unbookmarked market: ${conditionId}`);
    }
    isBookmarked(conditionId) {
        return this.bookmarkedMarkets.has(conditionId);
    }
    getBookmarkedOpportunities() {
        return this.opportunities
            .filter(o => this.bookmarkedMarkets.has(o.conditionId))
            .map(opp => ({ ...opp, isBookmarked: true }));
    }
    // ============================================================
    // PUBLIC API - ACTIVE QUOTES
    // ============================================================
    hasActiveQuotes(tokenId) {
        return this.activeQuoteTokens.has(tokenId);
    }
    setActiveQuotes(tokenIds) {
        this.activeQuoteTokens = new Set(tokenIds);
    }
    // ============================================================
    // PUBLIC API - INVENTORY & TICK SIZE
    // ============================================================
    getInventorySkew(conditionId) {
        const balance = this.inventoryBalances.get(conditionId);
        if (!balance)
            return 0;
        const total = balance.yes + balance.no;
        if (total === 0)
            return 0;
        return (balance.yes - balance.no) / total;
    }
    updateInventoryBalance(conditionId, balance) {
        this.inventoryBalances.set(conditionId, balance);
    }
    getTickSize(tokenId) {
        const info = this.tickSizes.get(tokenId);
        return info?.tickSize || '0.01';
    }
    // ============================================================
    // PUBLIC API - KILL SWITCH
    // ============================================================
    triggerKillSwitch(reason) {
        if (!this.config.enableKillSwitch)
            return;
        this.killSwitchActive = true;
        this.logger.error(`🚨 KILL SWITCH TRIGGERED: ${reason}`);
        this.emit('killSwitch', { reason, timestamp: Date.now() });
        // Cancel all orders immediately
        this.adapter.cancelAllOrders?.().catch(e => {
            this.logger.error(`Failed to cancel orders on kill switch: ${e}`);
        });
    }
    resetKillSwitch() {
        this.killSwitchActive = false;
        this.logger.info('🔄 Kill switch reset');
    }
    isKillSwitchActive() {
        return this.killSwitchActive;
    }
    // ============================================================
    // PUBLIC API - MARKET ACCESS
    // ============================================================
    getTrackedMarket(tokenId) {
        return this.trackedMarkets.get(tokenId);
    }
    getOpportunities(maxAgeMs = 600000) {
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
    getLatestOpportunities() {
        return this.getOpportunities();
    }
    getMonitoredMarkets() {
        return Array.from(this.monitoredMarkets.values());
    }
    getTrackedMarketsCount() {
        return this.trackedMarkets.size;
    }
    // ============================================================
    // PUBLIC API - MANUAL MARKET ADDITION
    // ============================================================
    async addMarketByConditionId(conditionId) {
        try {
            const response = await this.rateLimiter.limit(() => fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`));
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
            const seenConditionIds = new Set();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);
            if (result.added && result.tokenIds.length > 0) {
                this.subscribeToTokens(result.tokenIds);
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.error(`Failed to add market: ${error}`);
            return false;
        }
    }
    async addMarketBySlug(slug) {
        try {
            const response = await this.rateLimiter.limit(() => fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`));
            if (!response.ok) {
                this.logger.warn(`Market not found: ${slug}`);
                return false;
            }
            const market = await response.json();
            if (!market || !market.conditionId) {
                this.logger.warn(`Market not found by slug: ${slug}`);
                return false;
            }
            const seenConditionIds = new Set();
            const result = this.processMarketData(market, { title: market.question }, seenConditionIds);
            if (result.added && result.tokenIds.length > 0) {
                this.subscribeToTokens(result.tokenIds);
                this.logger.success(`✅ Manually added market: ${market.question?.slice(0, 50)}...`);
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.error(`Failed to add market by slug: ${error}`);
            return false;
        }
    }
    // ============================================================
    // PUBLIC API - LIFECYCLE
    // ============================================================
    async start() {
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
            // Connect WebSockets
            this.connect();
            this.connectUserChannel();
            // Start DB batch writer
            this.startDbBatchWriter();
            // Periodic refresh
            this.refreshInterval = setInterval(async () => {
                try {
                    this.logger.info('🔄 Refreshing markets...');
                    await this.refreshMarkets();
                    this.logger.info(`✅ Refresh complete. Tracking ${this.trackedMarkets.size} markets`);
                }
                catch (error) {
                    this.logger.error(`❌ Error during refresh: ${error}`);
                }
            }, this.config.refreshIntervalMs);
            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }
    stop() {
        this.logger.info('🛑 Stopping market making scanner...');
        this.isScanning = false;
        this.isConnected = false;
        this.stopPing();
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        if (this.dbWriteInterval) {
            clearInterval(this.dbWriteInterval);
            this.dbWriteInterval = undefined;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            this.ws = undefined;
        }
        if (this.userWs) {
            this.userWs.removeAllListeners();
            if (this.userWs.readyState === WebSocket.OPEN) {
                this.userWs.close();
            }
            this.userWs = undefined;
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
    async forceRefresh() {
        this.logger.info('🔄 [Forced Refresh] Manually triggering market discovery...');
        await this.refreshMarkets();
    }
    // ============================================================
    // DISCOVERY - SAMPLING MARKETS (PRIMARY)
    // Per docs: getSamplingMarkets returns full Market objects with rewards
    // ============================================================
    async discoverFromSamplingMarkets() {
        try {
            const sampling = await this.adapter.getSamplingMarkets?.();
            if (!sampling || !Array.isArray(sampling) || sampling.length === 0) {
                this.logger.warn('No sampling markets available from adapter');
                return false;
            }
            this.logger.info(`🎯 Processing ${sampling.length} sampling markets`);
            const tokenIds = [];
            for (const market of sampling) {
                if (this.trackedMarkets.size >= this.MAX_TRACKED_MARKETS)
                    break;
                // Per docs: Market object has condition_id, tokens[], rewards{max_spread, min_size}
                const tokens = market.tokens || [];
                const conditionId = market.condition_id;
                if (!conditionId || tokens.length !== 2)
                    continue;
                for (let i = 0; i < tokens.length; i++) {
                    const token = tokens[i];
                    const tokenId = token.token_id;
                    if (!tokenId || this.trackedMarkets.has(tokenId))
                        continue;
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
                    this.intelligence.subscribeToToken(tokenId);
                }
            }
            this.logger.success(`✅ Loaded ${tokenIds.length} tokens from sampling markets`);
            return tokenIds.length > 0;
        }
        catch (error) {
            this.logger.warn(`Sampling markets failed: ${error}`);
            return false;
        }
    }
    // ============================================================
    // DISCOVERY - CATEGORIES (FALLBACK)
    // ============================================================
    async discoverFromCategories() {
        const tagIds = await this.fetchTagIds();
        const priorityCategories = [
            'sports', 'politics', 'crypto', 'business', 'climate',
            'tech', 'elections', 'finance', 'mentions', 'geopolitics',
            'entertainment', 'science', 'world', 'earnings'
        ];
        const categoryEndpoint = (tagId, limit = 100) => `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tagId}&related_tags=true&limit=${limit}&order=volume&ascending=false`;
        const endpoints = [
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false',
            'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&order=id&ascending=false',
            ...priorityCategories
                .filter(cat => tagIds[cat])
                .map(cat => categoryEndpoint(tagIds[cat]))
        ];
        const seenConditionIds = new Set();
        for (const url of endpoints) {
            if (this.trackedMarkets.size >= this.MAX_TRACKED_MARKETS)
                break;
            try {
                const response = await this.rateLimiter.limit(() => fetch(url));
                if (!response.ok)
                    continue;
                const events = await response.json();
                for (const event of events) {
                    for (const market of (event.markets || [])) {
                        if (this.trackedMarkets.size >= this.MAX_TRACKED_MARKETS)
                            break;
                        const result = this.processMarketData(market, event, seenConditionIds);
                        if (result.added) {
                            result.tokenIds.forEach(id => this.intelligence.subscribeToToken(id));
                        }
                    }
                }
            }
            catch (error) {
                this.logger.warn(`Category fetch failed: ${error}`);
            }
        }
    }
    async fetchTagIds() {
        const tagMap = {};
        try {
            const response = await this.rateLimiter.limit(() => fetch('https://gamma-api.polymarket.com/tags?limit=300'));
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
        }
        catch (error) {
            this.logger.warn(`Failed to fetch tags: ${error}`);
            return tagMap;
        }
    }
    processMarketData(market, event, seenConditionIds) {
        const result = { added: false, tokenIds: [] };
        const conditionId = market.conditionId || market.condition_id;
        if (!conditionId || seenConditionIds.has(conditionId))
            return result;
        // Structural filters only
        if (market.closed === true)
            return result;
        if (market.acceptingOrders === false)
            return result;
        if (market.active === false)
            return result;
        if (market.archived === true)
            return result;
        const rawTokenIds = market.clobTokenIds || market.clob_token_ids;
        const tokenIds = this.parseJsonArray(rawTokenIds);
        if (tokenIds.length !== 2)
            return result;
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
                const existing = this.trackedMarkets.get(tokenId);
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
    async refreshMarkets() {
        const usedSampling = await this.discoverFromSamplingMarkets();
        if (!usedSampling || this.trackedMarkets.size < 50) {
            await this.discoverFromCategories();
        }
        this.updateOpportunities();
        this.resubscribeAll();
    }
    // ============================================================
    // WEBSOCKET - MARKET CHANNEL
    // Per docs: No subscription limit (removed May 28, 2025)
    // ============================================================
    connect() {
        if (!this.isScanning)
            return;
        const wsUrl = `${WS_URLS.CLOB}/ws/market`;
        this.logger.info(`🔌 Connecting to ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);
        this.ws.on('open', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.logger.success('✅ Market WebSocket connected');
            this.resubscribeAll();
            this.startPing();
        });
        this.ws.on('message', (data) => {
            try {
                const msg = data.toString();
                if (msg === 'PONG')
                    return;
                const parsed = JSON.parse(msg);
                if (Array.isArray(parsed)) {
                    parsed.forEach(m => this.processMessage(m));
                }
                else {
                    this.processMessage(parsed);
                }
            }
            catch (error) {
                // Silent parse errors
            }
        });
        this.ws.on('close', (code) => {
            this.isConnected = false;
            this.logger.warn(`📡 WebSocket closed: ${code}`);
            this.stopPing();
            if (this.isScanning)
                this.handleReconnect();
        });
        this.ws.on('error', (error) => {
            this.logger.error(`❌ WebSocket error: ${error.message}`);
        });
    }
    // ============================================================
    // WEBSOCKET - USER CHANNEL (AUTHENTICATED)
    // Per docs: Requires apiKey, secret, passphrase auth
    // ============================================================
    connectUserChannel() {
        if (!this.isScanning)
            return;
        const userWsUrl = `${WS_URLS.CLOB}/ws/user`;
        this.logger.info(`🔌 Connecting to User Channel: ${userWsUrl}`);
        this.userWs = new WebSocket(userWsUrl);
        this.userWs.on('open', () => {
            this.logger.success('✅ User Channel Connected');
            // Authenticate per docs
            const creds = this.adapter.getApiCredentials?.();
            if (creds) {
                this.userWs?.send(JSON.stringify({
                    type: 'user',
                    auth: {
                        apiKey: creds.key,
                        secret: creds.secret,
                        passphrase: creds.passphrase
                    }
                }));
            }
            this.startUserPing();
        });
        this.userWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg === 'PONG')
                    return;
                if (msg.event_type === 'order_filled') {
                    const tokenId = msg.asset_id;
                    const market = this.trackedMarkets.get(tokenId);
                    if (market) {
                        this.logger.success(`⚡ [HFT FILL] Order filled for ${market.question.slice(0, 20)}... Re-quoting.`);
                        this.evaluateOpportunity(market);
                    }
                }
            }
            catch (e) {
                // Silent parse errors
            }
        });
        this.userWs.on('close', () => {
            this.stopUserPing();
            if (this.isScanning) {
                setTimeout(() => this.connectUserChannel(), 5000);
            }
        });
        this.userWs.on('error', (error) => {
            this.logger.error(`❌ User Channel error: ${error.message}`);
        });
    }
    // ============================================================
    // WEBSOCKET - SUBSCRIPTIONS
    // Per docs: No limit, use initial_dump for orderbook state
    // ============================================================
    resubscribeAll() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const assetIds = Array.from(this.trackedMarkets.keys());
        if (assetIds.length === 0)
            return;
        // Subscribe in batches of 500 for reliability
        for (let i = 0; i < assetIds.length; i += 500) {
            const batch = assetIds.slice(i, i + 500);
            this.ws.send(JSON.stringify({
                type: 'market',
                assets_ids: batch,
                custom_feature_enabled: true,
                initial_dump: true
            }));
        }
        this.logger.info(`📡 Subscribed to ${assetIds.length} tokens`);
    }
    subscribeToTokens(tokenIds) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || tokenIds.length === 0)
            return;
        this.ws.send(JSON.stringify({
            assets_ids: tokenIds,
            type: 'market',
            custom_feature_enabled: true,
            initial_dump: true
        }));
        this.logger.debug(`📡 Subscribed to ${tokenIds.length} additional tokens`);
    }
    // ============================================================
    // MESSAGE PROCESSING
    // Per docs: event_type determines message type
    // ============================================================
    processMessage(msg) {
        if (!msg)
            return;
        // Handle initial orderbook dump
        if (msg.type === 'initial_dump' && Array.isArray(msg.data)) {
            this.logger.debug(`Processing initial dump for ${msg.data.length} markets`);
            for (const marketData of msg.data) {
                this.handleBestBidAsk({
                    ...marketData,
                    event_type: 'best_bid_ask',
                    asset_id: marketData.asset_id || marketData.token_id
                });
            }
            return;
        }
        if (!msg.event_type)
            return;
        switch (msg.event_type) {
            case 'best_bid_ask':
                this.handleBestBidAsk(msg);
                break;
            case 'book':
                this.handleBookUpdate(msg);
                break;
            case 'new_market':
                this.handleNewMarket(msg);
                break;
            case 'price_change':
                this.handlePriceChange(msg);
                break;
            case 'last_trade_price':
                this.handleLastTradePrice(msg);
                break;
            case 'market_resolved':
                this.handleMarketResolved(msg);
                break;
            case 'tick_size_change':
                this.handleTickSizeChange(msg);
                break;
            default:
                this.logger.debug(`Unhandled message type: ${msg.event_type}`);
        }
    }
    handleBestBidAsk(msg) {
        const tokenId = msg.asset_id || msg.token_id;
        if (!tokenId)
            return;
        const bestBid = parseFloat(msg.best_bid || '0');
        const bestAsk = parseFloat(msg.best_ask || '1');
        const spread = msg.spread !== undefined ? parseFloat(msg.spread) : (bestAsk - bestBid);
        const market = this.trackedMarkets.get(tokenId);
        if (!market)
            return;
        if (bestBid > 0 && bestAsk > 0 && bestAsk > bestBid) {
            market.bestBid = bestBid;
            market.bestAsk = bestAsk;
            market.spread = spread;
            this.evaluateOpportunity(market);
        }
    }
    handleBookUpdate(msg) {
        const tokenId = msg.asset_id;
        const bids = msg.bids || msg.buys || [];
        const asks = msg.asks || msg.sells || [];
        if (bids.length === 0 || asks.length === 0)
            return;
        const market = this.trackedMarkets.get(tokenId);
        if (!market)
            return;
        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');
        market.bestBid = bestBid;
        market.bestAsk = bestAsk;
        market.spread = bestAsk - bestBid;
        this.evaluateOpportunity(market);
    }
    handleNewMarket(msg) {
        const assetIds = msg.assets_ids || [];
        const question = msg.question || 'New Market';
        const conditionId = msg.market;
        const outcomes = msg.outcomes || ['Yes', 'No'];
        if (assetIds.length !== 2)
            return;
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
                this.intelligence.subscribeToToken(tokenId);
            }
        }
        this.subscribeToTokens(assetIds);
        this.logger.success(`✨ Subscribed to new market: ${question.slice(0, 50)}...`);
    }
    handlePriceChange(msg) {
        const priceChanges = msg.price_changes || [];
        for (const change of priceChanges) {
            const tokenId = change.asset_id;
            const market = this.trackedMarkets.get(tokenId);
            if (!market)
                continue;
            if (change.best_bid)
                market.bestBid = parseFloat(change.best_bid);
            if (change.best_ask)
                market.bestAsk = parseFloat(change.best_ask);
            market.spread = market.bestAsk - market.bestBid;
            this.evaluateOpportunity(market);
        }
    }
    handleLastTradePrice(msg) {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        const market = this.trackedMarkets.get(tokenId);
        if (!market)
            return;
        const lastMid = this.lastMidpoints.get(tokenId);
        if (lastMid && lastMid > 0) {
            const movePct = Math.abs(price - lastMid) / lastMid * 100;
            // Update volatility state
            market.lastPriceMovePct = movePct;
            market.isVolatile = movePct > this.config.priceMoveThresholdPct;
            if (movePct > this.config.priceMoveThresholdPct) {
                this.logger.warn(`🔴 FLASH MOVE: ${movePct.toFixed(1)}% on ${market.question.slice(0, 30)}...`);
                // EXECUTE FOMO TRADE
                this.executeFlashMoveTrade(market, price, movePct);
                this.emit('volatilityAlert', {
                    tokenId: market.tokenId,
                    question: market.question,
                    movePct,
                    timestamp: Date.now()
                });
                // Extreme volatility kill switch
                if (this.config.enableKillSwitch && movePct > 100) {
                    this.triggerKillSwitch(`Extreme Volatility (${movePct.toFixed(1)}%) on ${market.tokenId}`);
                }
            }
        }
        this.lastMidpoints.set(tokenId, price);
    }
    handleMarketResolved(msg) {
        const conditionId = msg.market;
        const winningOutcome = msg.winning_outcome;
        const winningAssetId = msg.winning_asset_id;
        const question = msg.question || 'Unknown';
        if (this.resolvedMarkets.has(conditionId))
            return;
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
    handleTickSizeChange(msg) {
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
    // ============================================================
    // FLASH MOVE TRADE EXECUTION
    // Per docs: FAK (Fill-And-Kill) for partial fills
    // ============================================================
    async executeFlashMoveTrade(market, currentPrice, movePct) {
        try {
            if (this.killSwitchActive) {
                this.logger.warn('⚠️ Kill switch active, skipping flash move trade');
                return { success: false, errorMsg: 'Kill switch active' };
            }
            const lastMid = this.lastMidpoints.get(market.tokenId) || 0.5;
            const direction = currentPrice > lastMid ? 'BUY' : 'SELL';
            const size = this.config.flashMoveTradeSize;
            // Calculate aggressive price (2 cents through the market)
            const aggressivePrice = direction === 'BUY'
                ? Math.min(0.99, currentPrice + 0.02)
                : Math.max(0.01, currentPrice - 0.02);
            this.logger.info(`⚡ FOMO TRADE: ${direction} $${size} @ ${aggressivePrice.toFixed(2)} on ${market.question.slice(0, 40)}...`);
            // Use FAK (Fill-And-Kill) for immediate partial execution
            const result = await this.adapter.placeOrder?.({
                marketId: market.conditionId, // ✅ Added missing marketId
                tokenId: market.tokenId,
                outcome: direction === 'BUY' ? 'YES' : 'NO', // ✅ Added missing outcome
                side: direction,
                priceLimit: aggressivePrice,
                sizeUsd: size,
                orderType: 'FAK'
            });
            if (result?.success) {
                this.logger.success(`✅ FOMO trade executed: ${result.orderId}`);
                this.emit('flashMoveTrade', {
                    tokenId: market.tokenId,
                    conditionId: market.conditionId,
                    question: market.question,
                    direction,
                    size,
                    price: aggressivePrice,
                    movePct,
                    orderId: result.orderId,
                    timestamp: Date.now()
                });
                return {
                    success: true,
                    orderId: result.orderId,
                    filledSize: result.sharesFilled,
                    avgPrice: result.priceFilled
                };
            }
            else {
                this.logger.warn(`⚠️ FOMO trade failed: ${result?.error || 'Unknown error'}`);
                return {
                    success: false,
                    errorMsg: result?.error || 'Unknown error'
                };
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`❌ Flash move trade error: ${errorMsg}`);
            return { success: false, errorMsg };
        }
    }
    // ============================================================
    // OPPORTUNITY EVALUATION
    // ============================================================
    evaluateOpportunity(market) {
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
        if (spreadCents < this.config.minSpreadCents)
            return;
        if (spreadCents > this.config.maxSpreadCents)
            return;
        // Check if still "new"
        const ageMinutes = (Date.now() - market.discoveredAt) / (1000 * 60);
        const isStillNew = market.isNewMarket && ageMinutes < this.config.newMarketAgeMinutes;
        // Build opportunity
        const opportunity = {
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
            lastPriceMovePct: market.lastPriceMovePct,
            isVolatile: market.isVolatile
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
        if (market.volume < effectiveMinVolume)
            return;
        if (market.liquidity < effectiveMinLiquidity)
            return;
        // Update opportunities list
        this.updateOpportunitiesInternal(opportunity);
    }
    updateOpportunitiesInternal(opp) {
        const existingIdx = this.opportunities.findIndex(o => o.tokenId === opp.tokenId);
        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opp;
        }
        else {
            this.opportunities.push(opp);
        }
        // Queue for batch DB write
        this.queueDbWrite(opp);
        // Sort: new markets first, then by spread
        this.opportunities.sort((a, b) => {
            if (a.isNewMarket !== b.isNewMarket)
                return a.isNewMarket ? -1 : 1;
            return b.spreadCents - a.spreadCents;
        });
        this.emit('opportunity', opp);
    }
    updateOpportunities() {
        for (const market of this.trackedMarkets.values()) {
            this.evaluateOpportunity(market);
        }
    }
    // ============================================================
    // DB BATCH WRITER
    // ============================================================
    startDbBatchWriter() {
        this.dbWriteInterval = setInterval(async () => {
            if (this.pendingDbWrites.size === 0)
                return;
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
            }
            catch (e) {
                this.logger.warn(`DB batch write failed: ${e}`);
            }
        }, this.config.dbBatchIntervalMs);
    }
    queueDbWrite(opp) {
        this.pendingDbWrites.set(opp.tokenId, opp);
    }
    // ============================================================
    // HEARTBEAT / PING
    // ============================================================
    startPing() {
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, 10000);
    }
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }
    startUserPing() {
        this.userPingInterval = setInterval(() => {
            if (this.userWs?.readyState === WebSocket.OPEN) {
                this.userWs.send('PING');
            }
        }, 10000);
    }
    stopUserPing() {
        if (this.userPingInterval) {
            clearInterval(this.userPingInterval);
            this.userPingInterval = undefined;
        }
    }
    // ============================================================
    // RECONNECTION
    // ============================================================
    handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.logger.info(`Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        this.reconnectTimeout = setTimeout(() => {
            if (this.isScanning)
                this.connect();
        }, delay);
    }
    // ============================================================
    // DEBUG / UTILITIES
    // ============================================================
    async debugApiResponse() {
        try {
            const response = await fetch('https://gamma-api.polymarket.com/events?closed=false&limit=5&order=volume&ascending=false');
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
            this.logger.info(`Sample tags: ${tags.slice(0, 5).map((t) => `${t.id}:${t.slug}`).join(', ')}`);
        }
        catch (e) {
            this.logger.error(`API test failed: ${e}`);
        }
    }
    parseJsonArray(value) {
        if (!value)
            return [];
        if (Array.isArray(value))
            return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            }
            catch {
                return [];
            }
        }
        return [];
    }
    parseNumber(value) {
        if (typeof value === 'number')
            return value;
        if (typeof value === 'string')
            return parseFloat(value) || 0;
        return 0;
    }
    computeMarketStatus(market) {
        if (market.closed === true)
            return 'closed';
        if (market.umaResolutionStatus === 'resolved')
            return 'resolved';
        if (market.acceptingOrders === false)
            return 'paused';
        return 'active';
    }
    isRecentlyCreated(createdAt) {
        if (!createdAt)
            return false;
        try {
            const created = new Date(createdAt).getTime();
            const hoursSinceCreation = (Date.now() - created) / (1000 * 60 * 60);
            return hoursSinceCreation < 24;
        }
        catch {
            return false;
        }
    }
    extractCategory(event, market) {
        // Primary: event.tags array per Gamma API docs
        if (event.tags && Array.isArray(event.tags) && event.tags.length > 0) {
            const tag = event.tags[0];
            const slug = (tag.slug || tag.label || '').toLowerCase();
            // Category normalization
            const categoryMap = {
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
        const categoryMap = {
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
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.logger.info('Config updated:', JSON.stringify(this.config));
    }
    getConfig() {
        return { ...this.config };
    }
}
