import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';

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
    // CHANGED: Use array for history instead of Map to prevent overwrites
    private moveHistory: FlashMoveEvent[] = [];
    private marketMetadata: Map<string, any> = new Map();
    
    private readonly VELOCITY_THRESHOLD = 0.05; 
    private readonly LOOKBACK_MS = 15000;      
    private readonly MAX_HISTORY = 50;

    constructor(private logger: Logger) {
        super();
    }

    /**
     * Called by ArbitrageScanner to bridge metadata to the Intelligence Engine
     */
    public updateMetadata(tokenId: string, data: any) {
        this.marketMetadata.set(tokenId, data);
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    public getLatestMoves(): FlashMoveEvent[] {
        const now = Date.now();
        // Return moves from the last 15 minutes
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
        });

        (this.ws as any).on('message', (data: any) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
                    this.processPriceUpdate(msg.asset_id, parseFloat(msg.price));
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

    private processPriceUpdate(tokenId: string, price: number) {
        const now = Date.now();
        this.emit(`price_${tokenId}`, { price, timestamp: now });

        const history = this.priceHistory.get(tokenId) || [];
        
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    // Enrich with metadata if available
                    const meta = this.marketMetadata.get(tokenId);
                    
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

                    // Add to history and prune
                    this.moveHistory.unshift(event);
                    if (this.moveHistory.length > this.MAX_HISTORY) {
                        this.moveHistory.pop();
                    }

                    this.emit('flash_move', event);
                }
            }
        }

        history.push({ price, timestamp: now });
        if (history.length > 5) history.shift();
        this.priceHistory.set(tokenId, history);
    }
}
