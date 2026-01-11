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
}

/**
 * MarketIntelligenceService
 * Monitors global price velocity across all markets via WebSocket.
 */
export class MarketIntelligenceService extends EventEmitter {
    private ws?: any;
    private isRunning = false;
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private latestMoves: Map<string, FlashMoveEvent> = new Map();
    
    private readonly VELOCITY_THRESHOLD = 0.05; // 5% move
    private readonly LOOKBACK_MS = 15000;      // 15 seconds

    constructor(private logger: Logger) {
        super();
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    public getLatestMoves(): FlashMoveEvent[] {
        const now = Date.now();
        // Return moves from the last 10 minutes, sorted by newest
        return Array.from(this.latestMoves.values())
            .filter(m => now - m.timestamp < 600000)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    public stop() {
        this.isRunning = false;
        if (this.ws) this.ws.terminate();
    }

    private connect() {
        this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);

        this.ws.on('open', () => {
            this.logger.success('🔌 Intelligence WebSocket Active');
            this.ws?.send(JSON.stringify({
                type: "subscribe",
                topic: "last_trade_price" 
            }));
        });

        this.ws.on('message', (data: any) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
                    this.processPriceUpdate(msg.asset_id, parseFloat(msg.price));
                }
            } catch (e) {}
        });

        this.ws.on('close', () => {
            if (this.isRunning) setTimeout(() => this.connect(), 5000);
        });
    }

    private processPriceUpdate(tokenId: string, price: number) {
        const now = Date.now();
        const history = this.priceHistory.get(tokenId) || [];
        
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (velocity >= this.VELOCITY_THRESHOLD) {
                    const event: FlashMoveEvent = {
                        tokenId,
                        conditionId: tokenId, // Simplified for now
                        oldPrice: oldest.price,
                        newPrice: price,
                        velocity,
                        timestamp: now
                    };
                    this.latestMoves.set(tokenId, event);
                    this.emit('flash_move', event);
                }
            }
        }

        history.push({ price, timestamp: now });
        if (history.length > 5) history.shift();
        this.priceHistory.set(tokenId, history);
    }
}
