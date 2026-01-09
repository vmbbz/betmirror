import axios from 'axios';
import EventEmitter from 'events';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
export class SportsIntelService extends EventEmitter {
    logger;
    isPolling = false;
    discoveryInterval;
    pingInterval;
    matches = new Map();
    ws;
    subscribedTokens = new Set();
    constructor(logger) {
        super();
        this.logger = logger;
    }
    async start() {
        if (this.isPolling)
            return;
        this.isPolling = true;
        this.logger.info("⚽ Pitch Intelligence System: ONLINE. Mapping All-Sport Triads.");
        await this.discoverSportsMarkets();
        this.connectWebSocket();
        // Re-discover every 30s for new markets
        this.discoveryInterval = setInterval(() => this.discoverSportsMarkets(), 30000);
    }
    stop() {
        this.isPolling = false;
        this.ws?.close();
        if (this.discoveryInterval)
            clearInterval(this.discoveryInterval);
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        this.logger.warn("⚽ Sports Intel: Offline.");
    }
    isActive() {
        return this.isPolling;
    }
    async discoverSportsMarkets() {
        try {
            // Step 1: Discover all sports series
            const sportsRes = await axios.get(`${GAMMA_BASE}/sports`);
            const sports = sportsRes.data || [];
            for (const sport of sports) {
                if (!sport.seriesId)
                    continue;
                // Step 2: Fetch events for each sport tag_id=100639 = game bets
                const url = `${GAMMA_BASE}/events?series_id=${sport.seriesId}&tag_id=100639&active=true&closed=false&order=startTime&ascending=true&limit=20`;
                const response = await axios.get(url);
                if (!response.data?.length)
                    continue;
                for (const event of response.data) {
                    const market = event.markets?.[0];
                    if (!market?.clobTokenIds || !market?.conditionId)
                        continue;
                    const tokenIds = JSON.parse(market.clobTokenIds);
                    const outcomes = JSON.parse(market.outcomes);
                    const outcomePrices = JSON.parse(market.outcomePrices).map(Number);
                    // Skip if already tracked
                    if (this.matches.has(market.conditionId)) {
                        const existing = this.matches.get(market.conditionId);
                        existing.outcomePrices = outcomePrices;
                        continue;
                    }
                    const matchData = {
                        id: event.id,
                        conditionId: market.conditionId,
                        question: market.question || event.title,
                        outcomes,
                        outcomePrices,
                        tokenIds,
                        image: event.image || market.image || '',
                        slug: market.slug || '',
                        eventSlug: event.slug || '',
                        startTime: event.startTime,
                        volume: market.volume,
                        liquidity: market.liquidity,
                        status: 'LIVE',
                        correlation: 'ALIGNED'
                    };
                    this.matches.set(market.conditionId, matchData);
                    // Subscribe all tokens to WebSocket
                    tokenIds.forEach(tid => {
                        if (!this.subscribedTokens.has(tid)) {
                            this.subscribeToken(tid);
                        }
                    });
                }
            }
            this.logger.info(`📊 Tracking ${this.matches.size} global sports markets`);
        }
        catch (e) {
            this.logger.error(`Discovery error: ${e.message}`);
        }
    }
    // Fix: Use standard browser WebSocket property handlers (onopen, onmessage, etc.) instead of Node-style .on()
    connectWebSocket() {
        this.ws = new WebSocket(WS_URL);
        this.ws.onopen = () => {
            this.logger.info('🔌 Sports WebSocket connected');
            // Re-subscribe existing tokens
            this.subscribedTokens.forEach(tid => this.subscribeToken(tid));
            // Start keepalive
            this.pingInterval = setInterval(() => {
                // Fix: Use readyState 1 (OPEN) for browser WebSocket compatibility
                if (this.ws?.readyState === 1) {
                    this.ws.send('PING');
                }
            }, 10000);
        };
        this.ws.onmessage = (event) => {
            const msg = event.data.toString();
            if (msg === 'PONG')
                return;
            try {
                const parsed = JSON.parse(msg);
                this.handlePriceUpdate(parsed);
            }
            catch { }
        };
        this.ws.onclose = () => {
            if (this.isPolling) {
                this.logger.warn('WebSocket closed, reconnecting...');
                if (this.pingInterval)
                    clearInterval(this.pingInterval);
                setTimeout(() => this.connectWebSocket(), 5000);
            }
        };
        this.ws.onerror = () => {
            this.logger.error(`WebSocket connection error occurred`);
        };
    }
    subscribeToken(tokenId) {
        // Fix: Use readyState 1 (OPEN) for browser WebSocket compatibility
        if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify({
                type: 'market',
                assets_ids: [tokenId]
            }));
            this.subscribedTokens.add(tokenId);
        }
    }
    handlePriceUpdate(msg) {
        if (msg.event_type !== 'last_trade_price' && msg.event_type !== 'price_change')
            return;
        const tokenId = msg.asset_id;
        const newPrice = parseFloat(msg.price);
        for (const match of this.matches.values()) {
            const idx = match.tokenIds.indexOf(tokenId);
            if (idx === -1)
                continue;
            const oldPrice = match.outcomePrices[idx];
            match.outcomePrices[idx] = newPrice;
            const velocity = oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0;
            if (Math.abs(velocity) > 0.08) {
                match.correlation = 'DIVERGENT';
                match.priceEvidence = `SPIKE DETECTED: ${(velocity * 100).toFixed(1)}% Velocity on ${match.outcomes[idx]}`;
                this.emit('inferredEvent', {
                    match,
                    tokenId,
                    outcomeIndex: idx,
                    newPrice,
                    velocity
                });
            }
            this.emit('priceUpdate', {
                match,
                outcome: match.outcomes[idx],
                oldPrice,
                newPrice,
                change: velocity
            });
        }
    }
    getLiveMatches() {
        return Array.from(this.matches.values());
    }
}
