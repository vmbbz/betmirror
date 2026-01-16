import { EventEmitter } from 'events';
import { WebSocket as WS } from 'ws';
import { FlashMove, MoneyMarketOpportunity } from '../database/index.js';
export class MarketIntelligenceService extends EventEmitter {
    logger;
    adapter;
    ws;
    isRunning = false;
    connectionAttempts = 0;
    maxConnectionAttempts = 5;
    baseReconnectDelay = 1000;
    maxReconnectDelay = 30000;
    pingInterval = null;
    priceHistory = new Map();
    lastUpdateTrack = new Map();
    tokenSubscriptionRefs = new Map();
    globalWatchlist = new Set();
    VELOCITY_THRESHOLD = 0.03;
    LOOKBACK_MS = 30000;
    JANITOR_INTERVAL_MS = 60000;
    PING_INTERVAL_MS = 10000;
    MAX_HISTORY_ITEMS = 5;
    WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    constructor(logger, adapter) {
        super();
        this.logger = logger;
        this.adapter = adapter;
        this.setMaxListeners(100);
        this.startJanitor();
    }
    updateWatchlist(addresses) {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
    }
    subscribeToToken(tokenId) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        if (count === 1 && this.ws?.readyState === WS.OPEN) {
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price", asset_id: tokenId }));
        }
    }
    unsubscribeFromToken(tokenId) {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
            this.priceHistory.delete(tokenId);
        }
        else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }
    startJanitor() {
        setInterval(() => {
            if (!this.isRunning)
                return;
            const now = Date.now();
            for (const [tokenId, lastTs] of this.lastUpdateTrack.entries()) {
                if (now - lastTs > 15 * 60 * 1000) {
                    this.priceHistory.delete(tokenId);
                    this.lastUpdateTrack.delete(tokenId);
                }
            }
        }, this.JANITOR_INTERVAL_MS);
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.connect();
    }
    connect() {
        try {
            this.ws = new WS(this.WS_URL);
            this.ws.on('open', () => {
                this.connectionAttempts = 0;
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price" }));
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "trades" }));
                this.startPingInterval();
            });
            this.ws.on('message', (data) => {
                const message = data.toString();
                if (message === 'PONG' || message === 'pong')
                    return;
                try {
                    const msg = JSON.parse(message);
                    if (msg.event_type === 'last_trade_price')
                        this.handlePriceMsg(msg);
                    if (msg.event_type === 'trades')
                        this.processTradeMessage(msg);
                }
                catch (e) { }
            });
            this.ws.on('close', () => {
                if (this.isRunning) {
                    const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.connectionAttempts++), this.maxReconnectDelay);
                    setTimeout(() => this.connect(), delay);
                }
            });
        }
        catch (e) {
            this.isRunning = false;
        }
    }
    async handlePriceMsg(msg) {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        if (!tokenId || isNaN(price))
            return;
        const now = Date.now();
        this.lastUpdateTrack.set(tokenId, now);
        this.emit('price_update', { tokenId, price, timestamp: now });
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    await this.triggerFlashMove(tokenId, oldest.price, price, velocity, now);
                }
            }
        }
        history.push({ price, timestamp: now });
        if (history.length > this.MAX_HISTORY_ITEMS)
            history.shift();
        this.priceHistory.set(tokenId, history);
    }
    /**
     * OPTIMIZED: Fetches metadata from DB (Scanner populated) or shared Adapter cache.
     * Removes redundant Gamma API fetch calls.
     */
    async triggerFlashMove(tokenId, oldPrice, newPrice, velocity, timestamp) {
        let question = "Aggressive Price Action";
        let image = "";
        let marketSlug = "";
        let conditionId = "";
        // 1. Check DB first (Scanner keeps this warm)
        const dbOpp = await MoneyMarketOpportunity.findOne({ tokenId }).lean();
        if (dbOpp) {
            question = dbOpp.question;
            image = dbOpp.image || "";
            marketSlug = dbOpp.marketSlug || "";
            conditionId = dbOpp.marketId;
        }
        else if (this.adapter) {
            // 2. Fallback to shared adapter cache (prevents 429)
            const metadata = await this.adapter.getMarketData(tokenId);
            if (metadata) {
                question = metadata.question;
                image = metadata.image || "";
                marketSlug = metadata.market_slug || "";
                conditionId = metadata.condition_id;
            }
        }
        const event = { tokenId, conditionId, oldPrice, newPrice, velocity, timestamp, question, image, marketSlug };
        await FlashMove.create({ ...event, timestamp: new Date(timestamp) });
        this.emit('flash_move', event);
        this.logger.success(`🔥 [FLASH] ${velocity > 0 ? 'Spike' : 'Crash'} detected: ${question.slice(0, 30)}...`);
    }
    processTradeMessage(msg) {
        const maker = (msg.maker_address || "").toLowerCase();
        const taker = (msg.taker_address || "").toLowerCase();
        if (this.globalWatchlist.has(maker) || this.globalWatchlist.has(taker)) {
            this.emit('whale_trade', {
                trader: this.globalWatchlist.has(maker) ? maker : taker,
                tokenId: msg.asset_id,
                side: msg.side.toUpperCase(),
                price: parseFloat(msg.price),
                size: parseFloat(msg.size),
                timestamp: Date.now()
            });
        }
    }
    async getLatestMoves() {
        const moves = await FlashMove.find({
            timestamp: { $gte: new Date(Date.now() - 86400000) }
        }).sort({ timestamp: -1 }).limit(20).lean();
        return moves.map((m) => ({
            tokenId: m.tokenId,
            conditionId: m.conditionId || "",
            oldPrice: m.oldPrice || 0,
            newPrice: m.newPrice || 0,
            velocity: m.velocity || 0,
            timestamp: m.timestamp.getTime(),
            question: m.question,
            image: m.image,
            marketSlug: m.marketSlug
        }));
    }
    startPingInterval() {
        this.pingInterval = setInterval(() => { if (this.ws?.readyState === WS.OPEN)
            this.ws.send('PING'); }, this.PING_INTERVAL_MS);
    }
    stop() {
        this.isRunning = false;
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        this.ws?.terminate();
    }
}
