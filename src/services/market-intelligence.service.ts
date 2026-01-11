
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
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

export class MarketIntelligenceService extends EventEmitter {
    private ws?: WebSocket;
    private isRunning = false;
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private moveHistory: FlashMoveEvent[] = [];
    private marketMetadata: Map<string, any> = new Map();
    
    private readonly VELOCITY_THRESHOLD = 0.05; 
    private readonly LOOKBACK_MS = 15000;      
    private readonly MAX_HISTORY = 50;

    constructor(private logger: Logger) {
        super();
    }

    /**
     * Update metadata for a token (called by other scanners or internal fetch)
     */
    public updateMetadata(tokenId: string, data: any) {
        this.marketMetadata.set(tokenId, data);
    }

    /**
     * Proactive fetch for missing metadata to ensure UI cards have context
     */
    private async fetchMissingMetadata(tokenId: string) {
        try {
            // Attempt to find market by token ID via Polymarket's Gamma API
            const response = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
            const data = response.data?.[0];
            if (data) {
                this.updateMetadata(tokenId, {
                    conditionId: data.conditionId,
                    question: data.question,
                    image: data.image,
                    marketSlug: data.slug
                });
                return this.marketMetadata.get(tokenId);
            }
        } catch (e) {
            this.logger.debug(`Could not fetch metadata for token ${tokenId}`);
        }
        return null;
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    public getLatestMoves(): FlashMoveEvent[] {
        const now = Date.now();
        return this.moveHistory
            .filter(m => now - m.timestamp < 900000)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    public stop() {
        this.isRunning = false;
        if (this.ws) (this.ws as any).terminate();
    }

    private connect() {
        this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);

        (this.ws as any).on('open', () => {
            this.logger.success('🔌 Global Intelligence Stream Online.');
            this.ws?.send(JSON.stringify({
                type: "subscribe",
                topic: "last_trade_price" 
            }));
            this.ws?.send(JSON.stringify({
                type: "subscribe",
                topic: "price_change" 
            }));
        });

        (this.ws as any).on('message', async (data: any) => {
            try {
                const msg = JSON.parse(data.toString());
                
                // Unified handler for different message formats
                if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
                    const tokenId = msg.asset_id || msg.token_id;
                    const price = parseFloat(msg.price);
                    if (tokenId && !isNaN(price)) {
                        await this.processPriceUpdate(tokenId, price);
                    }
                } else if (msg.price_changes) {
                    for (const change of msg.price_changes) {
                        const price = parseFloat(change.price || change.best_bid || change.best_ask);
                        if (change.asset_id && !isNaN(price)) {
                            await this.processPriceUpdate(change.asset_id, price);
                        }
                    }
                }
            } catch (e) {}
        });

        (this.ws as any).on('close', () => {
            if (this.isRunning) {
                this.logger.warn('⚠️ Intelligence Stream Disconnected. Reconnecting...');
                setTimeout(() => this.connect(), 5000);
            }
        });
    }

    private async processPriceUpdate(tokenId: string, price: number) {
        const now = Date.now();
        
        // Broadcast price update for all listeners (FomoRunner, UI, etc)
        this.emit('price_update', { tokenId, price, timestamp: now });
        this.emit(`price_${tokenId}`, { price, timestamp: now });

        const history = this.priceHistory.get(tokenId) || [];
        
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    // Enrich with metadata
                    let meta = this.marketMetadata.get(tokenId);
                    if (!meta) {
                        meta = await this.fetchMissingMetadata(tokenId);
                    }
                    
                    const event: FlashMoveEvent = {
                        tokenId,
                        conditionId: meta?.conditionId || tokenId,
                        oldPrice: oldest.price,
                        newPrice: price,
                        velocity,
                        timestamp: now,
                        question: meta?.question,
                        image: meta?.image,
                        marketSlug: meta?.marketSlug
                    };

                    this.logger.success(`🚀 FLASH MOVE: ${(velocity * 100).toFixed(1)}% Velocity on ${event.question || tokenId.slice(0, 8)}`);

                    this.moveHistory.unshift(event);
                    if (this.moveHistory.length > this.MAX_HISTORY) {
                        this.moveHistory.pop();
                    }

                    this.emit('flash_move', event);
                }
            }
        }

        history.push({ price, timestamp: now });
        if (history.length > 10) history.shift();
        this.priceHistory.set(tokenId, history);
    }
}
