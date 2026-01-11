import { EventEmitter } from 'events';
// Fixed: Use named import for WebSocket to ensure constructability in Node ESM
import WebSocket from 'ws';
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
}

/**
 * MarketIntelligenceService
 * Single WebSocket connection for global market monitoring.
 * Detects "Flash Moves" based on price velocity.
 */
export class MarketIntelligenceService extends EventEmitter {
    private ws?: any;
    private isRunning = false;
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private tokenToConditionMap: Map<string, string> = new Map();
    
    // Thresholds: 5% move in 15 seconds
    private readonly VELOCITY_THRESHOLD = 0.05; 
    private readonly LOOKBACK_MS = 15000;      
    private readonly MAX_HISTORY = 5;

    constructor(private logger: Logger) {
        super();
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
        this.logger.info("📡 Market Intelligence: Monitoring Global Velocity...");
    }

    public stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.terminate();
        }
        this.logger.warn("📡 Market Intelligence: Suspended.");
    }

    private connect() {
        this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);

        this.ws.on('open', () => {
            this.logger.success('🔌 Intelligence WebSocket Active');
            // Global subscription to all trade events
            this.ws?.send(JSON.stringify({
                type: "subscribe",
                topic: "last_trade_price" 
            }));
        });

        this.ws.on('message', (data: any) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch (e) {}
        });

        this.ws.on('close', () => {
            if (this.isRunning) setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err: any) => {
            this.logger.error(`Intelligence WS Error: ${err.message}`);
        });
    }

    private handleMessage(msg: any) {
        if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
            const tokenId = msg.asset_id;
            const price = parseFloat(msg.price);
            const timestamp = Date.now();

            this.updatePriceHistory(tokenId, price, timestamp);
            this.emit('price_update', { tokenId, price, timestamp });
        }
    }

    private updatePriceHistory(tokenId: string, price: number, timestamp: number) {
        const history = this.priceHistory.get(tokenId) || [];
        
        if (history.length > 0) {
            const oldest = history[0];
            if (timestamp - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    const conditionId = this.tokenToConditionMap.get(tokenId) || tokenId;
                    this.emit('flash_move', {
                        tokenId,
                        conditionId,
                        oldPrice: oldest.price,
                        newPrice: price,
                        velocity,
                        timestamp
                    } as FlashMoveEvent);
                }
            }
        }

        history.push({ price, timestamp });
        if (history.length > this.MAX_HISTORY) history.shift();
        this.priceHistory.set(tokenId, history);
    }

    public mapTokenToCondition(tokenId: string, conditionId: string) {
        this.tokenToConditionMap.set(tokenId, conditionId);
    }
}