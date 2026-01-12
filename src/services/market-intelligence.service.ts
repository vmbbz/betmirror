import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
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
 * 
 * Efficiency: 
 * - One TCP connection for all bots.
 * - O(1) Whale lookups via Hash Sets.
 * - Ref-counted subscription management.
 */
export class MarketIntelligenceService extends EventEmitter {
    private ws?: WebSocket;
    private isRunning = false;
    
    // Connection Management
    private connectionAttempts = 0;
    private maxConnectionAttempts = 5;
    private baseReconnectDelay = 1000; // 1 second
    private maxReconnectDelay = 30000; // 30 seconds
    private circuitOpen = false;
    private circuitResetTimeout: NodeJS.Timeout | null = null;
    
    // Core Data Structures
    private priceHistory: Map<string, PriceSnapshot[]> = new Map();
    private lastUpdateTrack: Map<string, number> = new Map();
    
    // Subscription Management: Tracks how many modules are interested in a specific token
    private tokenSubscriptionRefs: Map<string, number> = new Map();
    
    // Global Watchlist: Aggregated set of all whale addresses followed by all users
    private globalWatchlist: Set<string> = new Set();
    
    // Performance Parameters
    private readonly VELOCITY_THRESHOLD = 0.05; // 5% move
    private readonly LOOKBACK_MS = 15000;      // 15 second window
    private readonly JANITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minute cleanup

    constructor(private logger: Logger) {
        super();
        // Allow the hub to scale to thousands of concurrent listeners without warnings
        this.setMaxListeners(10000); 
        this.startJanitor();
    }

    /**
     * Updates the global whale filter. 
     * When a new bot starts, it registers its whales here to enable O(1) matching 
     * on the incoming trade firehose.
     */
    public updateWatchlist(addresses: string[]) {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
    }

    /**
     * Requests data for a specific token (Prices + Orderbook).
     * Uses ref-counting to ensure we only send one 'subscribe' message to the server.
     */
    public subscribeToToken(tokenId: string) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);

        if (count === 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price", asset_id: tokenId }));
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "book", asset_id: tokenId }));
            this.logger.debug(`📡 [NEW SUB] Firehose opened for token: ${tokenId.slice(0, 12)}...`);
        }
    }

    /**
     * Decrements interest in a token. Closes the pipe to the server if no bots remain.
     */
    public unsubscribeFromToken(tokenId: string) {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
            // Optional: Send unsubscribe message if Polymarket supports it to reduce bandwidth
        } else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }

    /**
     * Janitor: Automatically prunes stale price data to prevent memory leaks.
     */
    private startJanitor() {
        setInterval(() => {
            const now = Date.now();
            let prunedCount = 0;
            for (const [tokenId, lastTs] of this.lastUpdateTrack.entries()) {
                if (now - lastTs > 10 * 60 * 1000) { // Prune after 10 mins of silence
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

    /**
     * Starts the global data hub.
     */
    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    /**
     * Establish the Master WebSocket connection with circuit breaker pattern.
     */
    private connect() {
        if (this.circuitOpen) {
            this.logger.warn('Circuit breaker is open, not attempting to connect');
            return;
        }

        this.logger.info("🔌 Initializing Master Intelligence Pipeline...");
        
        try {
            this.ws = new WebSocket(`${WS_URLS.CLOB}/ws/market`);

            this.ws.on('open', () => {
                this.connectionAttempts = 0; // Reset on successful connection
                this.logger.success('🔌 [GLOBAL HUB] High-performance discovery engine: ONLINE.');
                
                // Subscribe to the global 'firehose' topics
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price" }));
                this.ws?.send(JSON.stringify({ type: "subscribe", topic: "trades" }));
                
                // Re-sync any specific token interests
                for (const tokenId of this.tokenSubscriptionRefs.keys()) {
                    this.ws?.send(JSON.stringify({ type: "subscribe", topic: "book", asset_id: tokenId }));
                }
            });

            this.ws.on('message', this.handleWebSocketMessage.bind(this));

            this.ws.on('close', () => {
                if (this.connectionAttempts >= this.maxConnectionAttempts) {
                    this.tripCircuit();
                    return;
                }

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
            const errorMessage = error instanceof Error ? error : new Error(String(error));
            this.logger.error("WebSocket connection error: " + errorMessage.message);
            this.handleConnectionFailure();
        }
    }

    /**
     * Handles incoming WebSocket messages with proper error handling
     */
    private handleWebSocketMessage(data: WebSocket.Data) {
        try {
            // First, check if the message is a string
            const message = data.toString();
            
            // Handle ping/pong messages
            if (message === 'pong' || message === 'PONG' || message === 'PING') {
                return;
            }
            
            // Try to parse as JSON, but handle non-JSON messages
            let msg;
            try {
                msg = JSON.parse(message);
            } catch (parseError) {
                const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
                this.logger.debug(`Received non-JSON message: ${message} - ${errorMessage}`);
                return;
            }

            // Reset error count on successful message processing
            this.connectionAttempts = 0;

            // Handle Price Updates (FOMO Detection)
            if (msg.event_type === 'last_trade_price') {
                const tokenId = msg.asset_id || msg.token_id;
                const price = parseFloat(msg.price);
                if (tokenId && !isNaN(price)) {
                    this.processPriceUpdate(tokenId, price).catch(err => 
                        this.logger.error('Error processing price update:', err)
                    );
                }
            }

            // Handle Global Trades (Whale Detection)
            if (msg.event_type === 'trades') {
                this.processTradeMessage(msg);
            }

            // Handle Order Book Updates (Money Market / Liquidity Rewards)
            if (msg.event_type === 'book') {
                this.emit('book_update', msg);
            }

        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            this.logger.error("Failed to process hub message: " + errorMessage);
            this.handleConnectionFailure();
        }
    }

    /**
     * Handles connection failures with exponential backoff
     */
    private handleConnectionFailure() {
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

    /**
     * Trips the circuit breaker to prevent cascading failures
     */
    private tripCircuit() {
        this.circuitOpen = true;
        this.logger.error('🚨 Circuit breaker tripped! Too many connection failures.');
        
        // Try to reset the circuit after a delay
        if (this.circuitResetTimeout) {
            clearTimeout(this.circuitResetTimeout);
        }
        
        this.circuitResetTimeout = setTimeout(() => {
            this.circuitOpen = false;
            this.connectionAttempts = 0;
            this.logger.info('Circuit breaker reset, attempting to reconnect...');
            if (this.isRunning) {
                this.connect();
            }
        }, 60000); // Reset after 60 seconds
    }

    /**
     * Filters the global trade stream for whale matches.
     * Matches are emitted immediately to the TradeMonitorService logic layer.
     */
    private processTradeMessage(msg: any) {
        const maker = (msg.maker_address || "").toLowerCase();
        const taker = (msg.taker_address || "").toLowerCase();

        // O(1) check against the global watchlist
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
            
            // Broadcast the signal to all passive monitor listeners
            this.emit('whale_trade', event);
        }
    }

    /**
     * Processes raw price ticks into velocity metrics.
     * Triggers FOMO signals if velocity thresholds are broken.
     */
    private async processPriceUpdate(tokenId: string, price: number) {
        const now = Date.now();
        this.lastUpdateTrack.set(tokenId, now); 
        
        // Pass price update to any interested listeners (like MM module)
        this.emit('price_update', { tokenId, price, timestamp: now });

        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                
                // Detection logic for a "Flash Move"
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    this.emit('flash_move', { 
                        tokenId, 
                        oldPrice: oldest.price, 
                        newPrice: price, 
                        velocity, 
                        timestamp: now 
                    });
                }
            }
        }
        
        // Update history window for next velocity check
        history.push({ price, timestamp: now });
        if (history.length > 5) history.shift();
        this.priceHistory.set(tokenId, history);
    }

    /**
     * VIBE CHECK: Returns true if the token is currently in a high-velocity spike.
     * Used by Copy-Trading to avoid buying at the peak of a pump.
     */
    public isSpiking(tokenId: string): boolean {
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length < 2) return false;
        
        const latest = history[history.length - 1];
        const initial = history[0];
        const velocity = (latest.price - initial.price) / initial.price;
        
        return velocity > this.VELOCITY_THRESHOLD;
    }

    /**
     * Fetches recent flash moves for UI hydration and historical alpha analysis.
     */
    public async getLatestMovesFromDB(): Promise<FlashMoveEvent[]> {
        // Fetch moves from the last 15 minutes
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

    /**
     * Disconnects the hub and shuts down the firehose.
     */
    public stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
        }
        this.priceHistory.clear();
        this.tokenSubscriptionRefs.clear();
        this.logger.info("🔌 Global Hub Hub Shutdown: OFFLINE.");
    }
}
