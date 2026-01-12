import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
import { FlashMove } from '../database/index.js';
import axios from 'axios';
/**
 * WORLD CLASS: Global Intelligence Hub (True Singleton)
 * Optimized for low memory footprint and high-frequency data.
 */
export class MarketIntelligenceService extends EventEmitter {
    logger;
    ws;
    isRunning = false;
    // Memory-efficient storage
    priceHistory = new Map();
    metadataCache = new Map();
    lastUpdateTrack = new Map();
    mutedTokens = new Set();
    // Global Watchlist of addresses we are interested in across all users
    globalWatchlist = new Set();
    VELOCITY_THRESHOLD = 0.05;
    LOOKBACK_MS = 15000;
    STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    JANITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    constructor(logger) {
        super();
        this.logger = logger;
        this.setMaxListeners(10000);
        this.startJanitor();
    }
    /**
     * THE JANITOR
     * Periodically prunes stale data to prevent memory leaks (OOM).
     */
    startJanitor() {
        setInterval(() => {
            const now = Date.now();
            let pruneCount = 0;
            for (const [tokenId, lastTs] of this.lastUpdateTrack.entries()) {
                if (now - lastTs > 10 * 60 * 1000) {
                    this.priceHistory.delete(tokenId);
                    this.lastUpdateTrack.delete(tokenId);
                    this.metadataCache.delete(tokenId);
                    pruneCount++;
                }
            }
            if (pruneCount > 0)
                this.logger.info(`🧹 [Janitor] Pruned ${pruneCount} stale markets.`);
        }, this.JANITOR_INTERVAL_MS);
    }
    /**
     * Mute a token that is confirmed dead (404) or irrelevant.
     */
    muteToken(tokenId) {
        this.mutedTokens.add(tokenId);
        this.priceHistory.delete(tokenId);
        this.lastUpdateTrack.delete(tokenId);
        this.metadataCache.delete(tokenId);
    }
    async getRichMetadata(tokenId) {
        // 1. Check Cache
        const cached = this.metadataCache.get(tokenId);
        if (cached) {
            cached.ts = Date.now();
            return cached.data;
        }
        try {
            const response = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`, { timeout: 5000 });
            const data = response.data?.[0];
            if (data) {
                const metadata = {
                    conditionId: data.conditionId,
                    question: data.question,
                    image: data.image,
                    marketSlug: data.slug,
                    eventSlug: data.eventSlug || ""
                };
                this.metadataCache.set(tokenId, { data: metadata, ts: Date.now() });
                return metadata;
            }
            else {
                // 404 or empty - Mute this token to stop the loop
                this.logger.warn(`🔇 Muting invalid token: ${tokenId}`);
                this.muteToken(tokenId);
            }
        }
        catch (e) {
            if (e.response?.status === 404) {
                this.muteToken(tokenId);
            }
        }
        return null;
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.logger.info("📡 [GLOBAL HUB] Initializing Shared Stream...");
        this.connect();
    }
    connect() {
        this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);
        this.ws.on('open', () => {
            this.logger.success('🔌 [GLOBAL HUB] Scaling discovery engine initialized.');
            this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price" }));
            this.ws?.send(JSON.stringify({ type: "subscribe", topic: "trades" }));
        });
        this.ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.event_type === 'last_trade_price') {
                    const tokenId = msg.asset_id || msg.token_id;
                    const price = parseFloat(msg.price);
                    if (tokenId && !isNaN(price))
                        await this.processPriceUpdate(tokenId, price);
                }
                if (msg.event_type === 'trades') {
                    this.processTradeMessage(msg);
                }
            }
            catch (e) { }
        });
        this.ws.on('close', () => {
            if (this.isRunning)
                setTimeout(() => this.connect(), 5000);
        });
    }
    processTradeMessage(msg) {
        // Polymarket trade events contain maker_address and taker_address
        const maker = (msg.maker_address || "").toLowerCase();
        const taker = (msg.taker_address || "").toLowerCase();
        const isMakerWhale = this.globalWatchlist.has(maker);
        const isTakerWhale = this.globalWatchlist.has(taker);
        if (isMakerWhale || isTakerWhale) {
            const whaleAddr = isMakerWhale ? maker : taker;
            const event = {
                trader: whaleAddr,
                tokenId: msg.asset_id,
                side: msg.side.toUpperCase(),
                price: parseFloat(msg.price),
                size: parseFloat(msg.size),
                timestamp: Date.now()
            };
            this.logger.info(`🐳 [WHALE MOVE] Detected ${event.side} by ${whaleAddr.slice(0, 8)}... via WebSocket`);
            this.emit('whale_trade', event);
        }
    }
    async processPriceUpdate(tokenId, price) {
        const now = Date.now();
        this.lastUpdateTrack.set(tokenId, now);
        this.emit('price_update', { tokenId, price, timestamp: now });
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    this.emit('flash_move', { tokenId, oldPrice: oldest.price, newPrice: price, velocity, timestamp: now });
                }
            }
        }
        history.push({ price, timestamp: now });
        if (history.length > 5)
            history.shift();
        this.priceHistory.set(tokenId, history);
    }
    async getLatestMovesFromDB() {
        const moves = await FlashMove.find({
            timestamp: { $gte: new Date(Date.now() - 900000) }
        }).sort({ timestamp: -1 }).limit(30).lean();
        return moves.map(m => ({
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
    stop() {
        this.isRunning = false;
        if (this.ws)
            this.ws.terminate();
    }
}
