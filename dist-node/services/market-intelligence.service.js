import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
export class MarketIntelligenceService extends EventEmitter {
    logger;
    ws;
    isRunning = false;
    priceHistory = new Map();
    latestMoves = new Map();
    VELOCITY_THRESHOLD = 0.05;
    LOOKBACK_MS = 15000;
    constructor(logger) {
        super();
        this.logger = logger;
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.connect();
    }
    getLatestMoves() {
        const now = Date.now();
        return Array.from(this.latestMoves.values())
            .filter(m => now - m.timestamp < 600000)
            .sort((a, b) => b.timestamp - a.timestamp);
    }
    stop() {
        this.isRunning = false;
        if (this.ws)
            this.ws.terminate();
    }
    connect() {
        this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);
        this.ws.on('open', () => {
            this.logger.success('🔌 Intelligence WebSocket Online. Subscribing to trade feed...');
            this.ws?.send(JSON.stringify({
                type: "subscribe",
                topic: "last_trade_price"
            }));
        });
        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.event_type === 'last_trade_price' || msg.event_type === 'price_change') {
                    this.processPriceUpdate(msg.asset_id, parseFloat(msg.price));
                }
            }
            catch (e) { }
        });
        this.ws.on('close', () => {
            if (this.isRunning)
                setTimeout(() => this.connect(), 5000);
        });
    }
    processPriceUpdate(tokenId, price) {
        const now = Date.now();
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    const event = {
                        tokenId,
                        conditionId: tokenId,
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
        if (history.length > 5)
            history.shift();
        this.priceHistory.set(tokenId, history);
    }
}
