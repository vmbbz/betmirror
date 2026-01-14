import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import type { Data } from 'ws';
import { Logger } from '../utils/logger.util.js';
import { FlashMove, MoneyMarketOpportunity } from '../database/index.js';
import axios from 'axios';

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
    conditionId?: string; // Optional because raw stream only has asset_id
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
    private readonly VELOCITY_THRESHOLD = 0.03; // Adjusted to 3% to catch more alpha
    private readonly LOOKBACK_MS = 30000;      // 30 second window for smoother velocity
    private readonly JANITOR_INTERVAL_MS = 60 * 1000; // Aggressive: Check every minute
    private readonly PING_INTERVAL_MS = 10000;
    private readonly MAX_HISTORY_ITEMS = 5; // Capped at 5 for better velocity calculation
    
    // WebSocket URL per Polymarket docs
    private readonly WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

    constructor(private logger: Logger) {
        super();
        this.setMaxListeners(100); 
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
     */
    public subscribeToToken(tokenId: string) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        
        // FIX: Access static OPEN property from imported WebSocket class
        if (count === 1 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price", asset_id: tokenId }));
        }
    }

    /**
     * Decrements interest in a token. Unsubscribes if no bots remain.
     */
    public unsubscribeFromToken(tokenId: string): void {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
            this.priceHistory.delete(tokenId); 
            this.lastUpdateTrack.delete(tokenId);
        } else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }

    /**
     * Janitor: Automatically prunes stale price data.
     */
    private startJanitor(): void {
        setInterval(() => {
            if (!this.isRunning) return;
            const now = Date.now();
            let prunedCount = 0;
            for (const [tokenId, lastTs] of this.lastUpdateTrack.entries()) {
                if (now - lastTs > 15 * 60 * 1000) {
                    this.priceHistory.delete(tokenId);
                    this.lastUpdateTrack.delete(tokenId);
                    prunedCount++;
                }
            }
            if (prunedCount > 50) {
                this.logger.debug(`[Janitor] Memory reclaimed: Removed ${prunedCount} stale token buffers.`);
            }
        }, this.JANITOR_INTERVAL_MS);
    }

    private startPingInterval(): void {
        this.stopPingInterval();
        this.pingInterval = setInterval(() => {
            // FIX: Access static OPEN property from imported WebSocket class
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
        this.logger.info("🔌 Initializing Master Intelligence Pipeline...");
        
        try {
            // FIX: Using named import for WebSocket construction
            this.ws = new WebSocket(this.WS_URL);

            // FIX: Using explicit cast to any to satisfy TS for Node.js EventEmitter-style 'on' method
            const ws = this.ws as any;

            ws.on('open', () => {
                this.connectionAttempts = 0; 
                this.logger.success('🔌 [GLOBAL HUB] High-performance discovery engine: ONLINE.');
                
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price" }));
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "trades" }));
                
                for (const tokenId of this.tokenSubscriptionRefs.keys()) {
                    this.ws?.send(JSON.stringify({ type: "subscribe", topic: "book", asset_id: tokenId }));
                }
                this.startPingInterval();
            });

            ws.on('message', (data: Data) => this.handleWebSocketMessage(data));

            ws.on('close', () => {
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

            ws.on('error', (err: Error) => {
                this.logger.error("Hub Socket Error: " + err.message);
            });

        } catch (error) {
            this.handleConnectionFailure();
        }
    }

    private handleWebSocketMessage(data: Data) {
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
        this.emit('risk_alert', { level: 'CRITICAL', reason: 'Intelligence Hub instability detected' });
        this.logger.warn('⚠️ Intelligence Hub reporting instability - Monitor only mode enabled.');
        
        if (this.circuitResetTimeout) clearTimeout(this.circuitResetTimeout);
        this.circuitResetTimeout = setTimeout(() => {
            this.connectionAttempts = 0;
            this.logger.info('Instability timer cleared.');
        }, 60000);
    }

    private processTradeMessage(msg: any) {
        // Normalizing addresses to lowercase for consistent matching
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
        this.emit('price_update', { tokenId, price, timestamp: now });

        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    
                    // --- METADATA ENRICHMENT ENGINE ---
                    // Raw stream only has asset_id. We must find the question/image for the UI.
                    let question = "Aggressive Price Action";
                    let image = "";
                    let marketSlug = "";
                    let conditionId = "";

                    try {
                        // 1. Check local Market Making cache (fastest)
                        const existingOpp = await MoneyMarketOpportunity.findOne({ tokenId });
                        if (existingOpp) {
                            question = existingOpp.question;
                            image = existingOpp.image || "";
                            marketSlug = existingOpp.marketSlug || "";
                            conditionId = existingOpp.marketId;
                        } else {
                            // 2. Fallback to Gamma API
                            const res = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
                            if (res.data?.[0]) {
                                const m = res.data[0];
                                question = m.question;
                                image = m.image;
                                marketSlug = m.slug;
                                conditionId = m.conditionId;
                            }
                        }
                    } catch (e) {}

                    const event: FlashMoveEvent = { 
                        tokenId, 
                        conditionId,
                        oldPrice: oldest.price, 
                        newPrice: price, 
                        velocity, 
                        timestamp: now,
                        question,
                        image,
                        marketSlug
                    };
                    
                    // PERSIST TO DB: This ensures getLatestMoves() actually returns data to the UI
                    try {
                        await FlashMove.create({
                            tokenId: event.tokenId,
                            conditionId: event.conditionId,
                            oldPrice: event.oldPrice,
                            newPrice: event.newPrice,
                            velocity: event.velocity,
                            timestamp: new Date(event.timestamp),
                            question: event.question,
                            image: event.image,
                            marketSlug: event.marketSlug
                        });
                    } catch (dbErr) {
                        this.logger.debug(`Failed to persist flash move: ${tokenId}`);
                    }

                    this.emit('flash_move', event);
                }
            }
        }
        history.push({ price, timestamp: now });
        if (history.length > this.MAX_HISTORY_ITEMS) history.shift();
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
        // Extended lookback to 24 hours to ensure UI hydration on load
        const moves = await FlashMove.find({ 
            timestamp: { $gte: new Date(Date.now() - 86400000) } 
        }).sort({ timestamp: -1 }).limit(20).lean();

        return moves.map((m: any) => ({
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
            const ws = this.ws as any;
            ws.removeAllListeners();
            ws.terminate();
            this.ws = undefined;
        }
        this.priceHistory.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}
