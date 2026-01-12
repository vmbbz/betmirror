import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.util.js';
import { FlashMove } from '../database/index.js';

/**
 * PriceSnapshot: Simple structure for tracking price velocity.
 */
export interface PriceSnapshot {
    price: number;
    timestamp: number;
}

/**
 * FlashMoveEvent: Pushed when a token exhibits high price velocity.
 */
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
 * WhaleTradeEvent: Pushed when a whitelisted address executes a trade.
 */
export interface WhaleTradeEvent {
    trader: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    timestamp: number;
}

/**
 * GLOBAL INTELLIGENCE HUB: MarketIntelligenceService
 * 
 * Purpose: This is the ONLY service that maintains the primary WebSocket firehose 
 * to Polymarket. It acts as a data broker for all other bot modules.
 */
export class MarketIntelligenceService extends EventEmitter {
    private ws?: WebSocket;
    public isRunning = false;
    
    // Connection Management
    private connectionAttempts = 0;
    private maxConnectionAttempts = 5;
    private baseReconnectDelay = 1000;
    private maxReconnectDelay = 30000;
    private circuitOpen = false;
    private circuitResetTimeout: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    
    // Core Data Structures
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private lastUpdateTrack: Map<string, number> = new Map();
    
    // Subscription Management
    private tokenSubscriptionRefs: Map<string, number> = new Map();
    
    // Global Watchlist
    private globalWatchlist: Set<string> = new Set();
    
    // Performance Parameters
    private readonly VELOCITY_THRESHOLD = 0.05;
    private readonly LOOKBACK_MS = 15000;
    private readonly JANITOR_INTERVAL_MS = 5 * 60 * 1000;
    private readonly PING_INTERVAL_MS = 10000;
    
    // WebSocket URL per Polymarket docs
    private readonly WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

    constructor(private logger: Logger) {
        super();
        this.setMaxListeners(10000); 
        this.startJanitor();
    }

    /**
     * Updates the global whale filter.
     */
    public updateWatchlist(addresses: string[]): void {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
    }

    /**
     * Requests data for a specific token using correct Polymarket format.
     * Per docs: { assets_ids: [tokenId], operation: "subscribe" }
     */
    public subscribeToToken(tokenId: string) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        if (count === 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price", asset_id: tokenId }));
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "book", asset_id: tokenId }));
        }
    }

    /**
     * Decrements interest in a token. Unsubscribes if no bots remain.
     */
    public unsubscribeFromToken(tokenId: string): void {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ 
                    assets_ids: [tokenId], 
                    operation: "unsubscribe" 
                }));
            }
        } else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }

    /**
     * Janitor: Automatically prunes stale price data.
     */
    private startJanitor(): void {
        setInterval(() => {
            const now = Date.now();
            let prunedCount = 0;
            for (const [tokenId, lastTs] of this.lastUpdateTrack.entries()) {
                if (now - lastTs > 10 * 60 * 1000) {
                    this.priceHistory.delete(tokenId);
                    this.lastUpdateTrack.delete(tokenId);
                    prunedCount++;
                }
            }
            if (prunedCount > 0) {
                this.logger.debug(`[Janitor] Memory reclaimed: Removed ${prunedCount} stale token buffers.`);
            }
        }, this.JANITOR_INTERVAL_MS);
    }

    private startPingInterval(): void {
        this.stopPingInterval();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, this.PING_INTERVAL_MS);
    }

    private stopPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    private connect() {
        // FIX: Changed circuit breaker logic to NOT stop connection unless fatal.
        // During high volatility, we want to keep the data pipe open at all costs.
        this.logger.info("🔌 Initializing Master Intelligence Pipeline...");
        
        try {
            this.ws = new WebSocket(this.WS_URL);

            this.ws.on('open', () => {
                this.connectionAttempts = 0; 
                this.logger.success('🔌 [GLOBAL HUB] High-performance discovery engine: ONLINE.');
                
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price" }));
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "trades" }));
                
                for (const tokenId of this.tokenSubscriptionRefs.keys()) {
                    this.ws?.send(JSON.stringify({ type: "subscribe", topic: "book", asset_id: tokenId }));
                }
                this.startPingInterval();
            });

            this.ws.on('message', this.handleWebSocketMessage.bind(this));

            this.ws.on('close', () => {
                const delay = Math.min(
                    this.baseReconnectDelay * Math.pow(2, this.connectionAttempts),
                    this.maxReconnectDelay
                );

                this.connectionAttempts++;
                this.logger.warn(`📡 Hub Connection Lost. Reconnecting in ${delay/1000}s... (Attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);
                
                if (this.isRunning) {
                    setTimeout(() => this.connect(), delay);
                }
            });

            this.ws.on('error', (err: Error) => {
                this.logger.error("Hub Socket Error: " + err.message);
            });

        } catch (error) {
            this.handleConnectionFailure();
        }
    }

    private handleWebSocketMessage(data: WebSocket.Data) {
        try {
            const message = data.toString();
            if (message === 'pong' || message === 'PONG' || message === 'PING') return;
            
            let msg;
            try {
                msg = JSON.parse(message);
            } catch (parseError) {
                return;
            }

            if (msg.event_type === 'last_trade_price') {
                this.handleLastTradePrice(msg);
            }

            if (msg.event_type === 'trades') {
                this.processTradeMessage(msg);
            }

            if (msg.event_type === 'book') {
                this.emit('book_update', msg);
            }
        } catch (e) {
            this.handleConnectionFailure();
        }
    }

    private handleLastTradePrice(msg: any): void {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        
        if (tokenId && !isNaN(price)) {
            this.processPriceUpdate(tokenId, price).catch(() => {});
        }
    }

    private handleConnectionFailure(): void {
        this.connectionAttempts++;
        if (this.connectionAttempts >= this.maxConnectionAttempts) {
            this.tripCircuit();
        } else {
            const delay = Math.min(
                this.baseReconnectDelay * Math.pow(2, this.connectionAttempts),
                this.maxReconnectDelay
            );
            setTimeout(() => this.connect(), delay);
        }
    }

    private tripCircuit(): void {
        // FIX: Decoupled circuit breaker from connection lifecycle.
        // Instead of setting circuitOpen = true (which stops reconnection), we just emit an alert.
        this.emit('risk_alert', { level: 'CRITICAL', reason: 'Intelligence Hub instability detected' });
        this.logger.warn('⚠️ Intelligence Hub reporting instability - Monitor only mode enabled.');
        
        if (this.circuitResetTimeout) clearTimeout(this.circuitResetTimeout);
        this.circuitResetTimeout = setTimeout(() => {
            this.connectionAttempts = 0;
            this.logger.info('Instability timer cleared.');
        }, 60000);
    }

    private processTradeMessage(msg: any) {
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
            this.emit('whale_trade', event);
        }
    }

    private async processPriceUpdate(tokenId: string, price: number) {
        const now = Date.now();
        this.lastUpdateTrack.set(tokenId, now);
        
        // FIX: Emit global price tick so Arbitrage Scanner can re-calculate spreads immediately.
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

    public isSpiking(tokenId: string): boolean {
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length < 2) return false;
        const latest = history[history.length - 1];
        const initial = history[0];
        const velocity = (latest.price - initial.price) / initial.price;
        return velocity > this.VELOCITY_THRESHOLD;
    }

    public async getLatestMoves(): Promise<FlashMoveEvent[]> {
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

    public stop(): void {
        this.isRunning = false;
        this.stopPingInterval();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = undefined;
        }
        this.priceHistory.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}
