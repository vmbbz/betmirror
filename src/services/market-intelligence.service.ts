
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import { FlashMove } from '../database/index.js';
import axios from 'axios';

export interface PriceSnapshot {
    price: number;
    timestamp: number;
}
export interface WhaleTradeEvent {
    trader: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    timestamp: number;
}
export interface FlashMoveEvent {
    tokenId: string;
    conditionId: string;
    oldPrice: number;
    newPrice: number;
    velocity: number;
    timestamp: number;
    question?: string;
    image?: string;
    marketSlug?: string;
}

/**
 * WORLD CLASS: Global Intelligence Hub (True Singleton)
 * Optimized for low memory footprint and high-frequency data.
 */
export class MarketIntelligenceService extends EventEmitter {
    private ws?: WebSocket;
    private isRunning = false;
    
    // Memory-efficient storage
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private metadataCache: Map<string, { data: any, ts: number }> = new Map();
    private lastUpdateTrack: Map<string, number> = new Map();
    private mutedTokens: Set<string> = new Set();
    // Global Watchlist of addresses we are interested in across all users
    private globalWatchlist: Set<string> = new Set();
    
    private readonly VELOCITY_THRESHOLD = 0.05; 
    private readonly LOOKBACK_MS = 15000;      
    private readonly STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    private readonly JANITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    constructor(private logger: Logger) {
        super();
        this.setMaxListeners(10000);
        this.startJanitor();
    }

    /**
     * THE JANITOR
     * Periodically prunes stale data to prevent memory leaks (OOM).
     */
    private startJanitor() {
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
            if (pruneCount > 0) this.logger.info(`🧹 [Janitor] Pruned ${pruneCount} stale markets.`);
        }, this.JANITOR_INTERVAL_MS);
    }

    /**
     * Mute a token that is confirmed dead (404) or irrelevant.
     */
    public muteToken(tokenId: string) {
        this.mutedTokens.add(tokenId);
        this.priceHistory.delete(tokenId);
        this.lastUpdateTrack.delete(tokenId);
        this.metadataCache.delete(tokenId);
    }

    private async getRichMetadata(tokenId: string) {
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
            } else {
                // 404 or empty - Mute this token to stop the loop
                this.logger.warn(`🔇 Muting invalid token: ${tokenId}`);
                this.muteToken(tokenId);
            }
        } catch (e: any) {
            if (e.response?.status === 404) {
                this.muteToken(tokenId);
            }
        }
        return null;
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.logger.info("📡 [GLOBAL HUB] Initializing Shared Stream...");
        this.connect();
    }

    private connect() {
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
                    if (tokenId && !isNaN(price)) await this.processPriceUpdate(tokenId, price);
                }

                if (msg.event_type === 'trades') {
                    this.processTradeMessage(msg);
                }
            } catch (e) {}
        });

        this.ws.on('close', () => {
            if (this.isRunning) setTimeout(() => this.connect(), 5000);
        });
    }

    private processTradeMessage(msg: any) {
        // Polymarket trade events contain maker_address and taker_address
        const maker = (msg.maker_address || "").toLowerCase();
        const taker = (msg.taker_address || "").toLowerCase();

        const isMakerWhale = this.globalWatchlist.has(maker);
        const isTakerWhale = this.globalWatchlist.has(taker);

        if (isMakerWhale || isTakerWhale) {
            const whaleAddr = isMakerWhale ? maker : taker;
            const event: WhaleTradeEvent = {
                trader: whaleAddr,
                tokenId: msg.asset_id,
                side: msg.side.toUpperCase(),
                price: parseFloat(msg.price),
                size: parseFloat(msg.size),
                timestamp: Date.now()
            };

            this.logger.info(`🐳 [WHALE MOVE] Detected ${event.side} by ${whaleAddr.slice(0,8)}... via WebSocket`);
            this.emit('whale_trade', event);
        }
    }

    private async processPriceUpdate(tokenId: string, price: number) {
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
        if (history.length > 5) history.shift();
        this.priceHistory.set(tokenId, history);
    }

    public async getLatestMovesFromDB(): Promise<FlashMoveEvent[]> {
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

    public stop() {
        this.isRunning = false;
        if (this.ws) this.ws.terminate();
    }
}
