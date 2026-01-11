
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
 * WORLD CLASS: Global Intelligence Hub (Singleton)
 * Monitors the entire CLOB for high-velocity price action.
 */
export class MarketIntelligenceService extends EventEmitter {
    private ws?: WebSocket;
    private isRunning = false;
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private metadataCache: Map<string, any> = new Map();
    
    private readonly VELOCITY_THRESHOLD = 0.05; // 5% move
    private readonly LOOKBACK_MS = 15000;      // 15 second window

    constructor(private logger: Logger) {
        super();
        this.setMaxListeners(100);
    }

    /**
     * RICH METADATA ENRICHMENT
     * Uses the Gamma API to get full context for a token
     */
    private async getRichMetadata(tokenId: string) {
        if (this.metadataCache.has(tokenId)) return this.metadataCache.get(tokenId);

        try {
            // Pointing to the same Gamma enrichment logic used for positions
            const response = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
            const data = response.data?.[0];
            
            if (data) {
                const metadata = {
                    conditionId: data.conditionId,
                    question: data.question,
                    image: data.image,
                    marketSlug: data.slug,
                    eventSlug: data.eventSlug || ""
                };
                this.metadataCache.set(tokenId, metadata);
                return metadata;
            }
        } catch (e) {
            this.logger.error(`Failed metadata enrichment for ${tokenId}`);
        }
        return null;
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.logger.info("📡 [GLOBAL HUB] Initializing Market Discovery...");
        this.connect();
    }

    private connect() {
        this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);

        this.ws.on('open', () => {
            this.logger.success('🔌 [GLOBAL HUB] Single Market Stream Active.');
            this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price" }));
            this.ws?.send(JSON.stringify({ type: "subscribe", topic: "price_change" }));
        });

        this.ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
                    const tokenId = msg.asset_id || msg.token_id;
                    const price = parseFloat(msg.price);
                    if (tokenId && !isNaN(price)) await this.processPriceUpdate(tokenId, price);
                }
            } catch (e) {}
        });

        this.ws.on('close', () => {
            if (this.isRunning) {
                setTimeout(() => this.connect(), 5000);
            }
        });
    }

    private async processPriceUpdate(tokenId: string, price: number) {
        const now = Date.now();
        this.emit('price_update', { tokenId, price, timestamp: now });

        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    // CRITICAL THINKING: Fetch full metadata for the spike
                    const meta = await this.getRichMetadata(tokenId);
                    
                    const event: FlashMoveEvent = {
                        tokenId,
                        conditionId: meta?.conditionId || tokenId,
                        oldPrice: oldest.price,
                        newPrice: price,
                        velocity,
                        timestamp: now,
                        question: meta?.question || "Unknown Market",
                        image: meta?.image || "",
                        marketSlug: meta?.marketSlug || ""
                    };

                    // Persist Alpha for UI History
                    await FlashMove.create({ ...event, timestamp: new Date(event.timestamp) }).catch(() => {});
                    
                    this.logger.success(`🚀 [GLOBAL ALPHA] ${(velocity * 100).toFixed(1)}% Spike: ${event.question}`);
                    this.emit('flash_move', event);
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
        }).sort({ timestamp: -1 }).limit(50).lean();

        return moves.map(m => ({
            tokenId: m.tokenId,
            conditionId: m.conditionId,
            oldPrice: m.oldPrice,
            newPrice: m.newPrice,
            velocity: m.velocity,
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
