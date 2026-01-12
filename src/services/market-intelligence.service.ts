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
    private isRunning = false;
    
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
    public subscribeToToken(tokenId: string): void {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);

        if (count === 0 && this.ws?.readyState === WebSocket.OPEN) {
            // Correct format per Polymarket WSS Overview docs
            this.ws.send(JSON.stringify({ 
                assets_ids: [tokenId], 
                operation: "subscribe" 
            }));
            
            // Only log first 3 subscriptions, then summarize
            if (this.tokenSubscriptionRefs.size <= 3) {
                this.logger.debug(`📡 [NEW SUB] Firehose opened for token: ${tokenId.slice(0, 12)}...`);
            } else if (this.tokenSubscriptionRefs.size % 10 === 0) {
                // Log every 10th subscription after the first 3
                this.logger.debug(`📡 [SUBS] Now tracking ${this.tokenSubscriptionRefs.size} tokens...`);
            }
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
                // Correct unsubscribe format per docs
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

    /**
     * Starts the ping interval to maintain WebSocket connection.
     * Per Polymarket RTDS docs: send PING every ~10 seconds
     */
    private startPingInterval(): void {
        this.stopPingInterval();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, this.PING_INTERVAL_MS);
    }

    /**
     * Stops the ping interval.
     */
    private stopPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    /**
     * Starts the global data hub.
     */
    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    /**
     * Establish the Master WebSocket connection with circuit breaker pattern.
     * Uses correct URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
     */
    private connect(): void {
        if (this.circuitOpen) {
            this.logger.warn('Circuit breaker is open, not attempting to connect');
            return;
        }

        this.logger.info("🔌 Initializing Master Intelligence Pipeline...");
        
        try {
            // Correct WebSocket URL per Polymarket docs
            this.ws = new WebSocket(this.WS_URL);

            this.ws.on('open', () => {
                this.connectionAttempts = 0;
                this.logger.success('🔌 [GLOBAL HUB] High-performance discovery engine: ONLINE.');
                
                // Get all currently subscribed token IDs
                const assetIds = Array.from(this.tokenSubscriptionRefs.keys());
                
                // Correct initial subscription format per Market Channel docs:
                // { type: "market", assets_ids: [...] }
                const subscribeMessage = {
                    type: "market",
                    assets_ids: assetIds.length > 0 ? assetIds : []
                };
                
                this.ws?.send(JSON.stringify(subscribeMessage));
                
                // Start ping keepalive per docs
                this.startPingInterval();
            });

            this.ws.on('message', this.handleWebSocketMessage.bind(this));

            this.ws.on('close', (code: number, reason: Buffer) => {
                this.stopPingInterval();
                
                if (this.connectionAttempts >= this.maxConnectionAttempts) {
                    this.tripCircuit();
                    return;
                }

                const delay = Math.min(
                    this.baseReconnectDelay * Math.pow(2, this.connectionAttempts),
                    this.maxReconnectDelay
                );

                this.connectionAttempts++;
                this.logger.warn(`📡 Hub Connection Lost (code: ${code}). Reconnecting in ${delay/1000}s... (Attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);
                
                if (this.isRunning) {
                    setTimeout(() => this.connect(), delay);
                }
            });

            this.ws.on('error', (err: Error) => {
                this.logger.error("Hub Socket Error: " + err.message);
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error("WebSocket connection error: " + errorMessage);
            this.handleConnectionFailure();
        }
    }

    /**
     * Handles incoming WebSocket messages with proper error handling.
     * Handles PONG responses and various event types per Market Channel docs.
     */
    private handleWebSocketMessage(data: WebSocket.Data): void {
        try {
            const message = data.toString();
            
            // Handle ping/pong keepalive responses
            if (message === 'PONG' || message === 'pong') {
                return;
            }
            
            // Handle PING from server (respond with PONG)
            if (message === 'PING' || message === 'ping') {
                this.ws?.send('PONG');
                return;
            }
            
            // Handle "INVALID OPERATION" - this means wrong message format was sent
            if (message === 'INVALID OPERATION') {
                this.logger.warn('Received INVALID OPERATION - check subscription message format');
                return;
            }
            
            // Parse JSON messages
            let msg: any;
            try {
                msg = JSON.parse(message);
            } catch (parseError) {
                // Non-JSON message that isn't a known control message
                this.logger.debug(`[WebSocket] Received unknown non-JSON message: ${message.substring(0, 50)}`);
                return;
            }

            // Reset error count on successful message processing
            this.connectionAttempts = 0;

            // Handle event types per Market Channel documentation
            switch (msg.event_type) {
                case 'last_trade_price':
                    this.handleLastTradePrice(msg);
                    break;
                    
                case 'book':
                    this.emit('book_update', msg);
                    break;
                    
                case 'price_change':
                    this.emit('price_change', msg);
                    break;
                    
                case 'tick_size_change':
                    this.emit('tick_size_change', msg);
                    break;
                    
                default:
                    // Check for trade data (whale detection)
                    if (msg.maker_address || msg.taker_address) {
                        this.processTradeMessage(msg);
                    }
                    break;
            }

        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            this.logger.error("Failed to process hub message: " + errorMessage);
        }
    }

    /**
     * Handles last_trade_price events per Market Channel docs.
     */
    private handleLastTradePrice(msg: any): void {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        
        if (tokenId && !isNaN(price)) {
            this.processPriceUpdate(tokenId, price).catch(err => 
                this.logger.error('Error processing price update: ' + err.message)
            );
        }
    }

    /**
     * Handles connection failures with exponential backoff.
     */
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

    /**
     * Trips the circuit breaker to prevent cascading failures.
     */
    private tripCircuit(): void {
        this.circuitOpen = true;
        this.logger.error('🚨 Circuit breaker tripped! Too many connection failures.');
        
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
        }, 60000);
    }

    /**
     * Filters the global trade stream for whale matches.
     */
    private processTradeMessage(msg: any): void {
        const maker = (msg.maker_address || "").toLowerCase();
        const taker = (msg.taker_address || "").toLowerCase();

        const isMakerWhale = this.globalWatchlist.has(maker);
        const isTakerWhale = this.globalWatchlist.has(taker);

        if (isMakerWhale || isTakerWhale) {
            const whaleAddr = isMakerWhale ? maker : taker;
            const event: WhaleTradeEvent = {
                trader: whaleAddr,
                tokenId: msg.asset_id,
                side: (msg.side || '').toUpperCase() as 'BUY' | 'SELL',
                price: parseFloat(msg.price),
                size: parseFloat(msg.size),
                timestamp: Date.now()
            };
            
            this.emit('whale_trade', event);
        }
    }

    /**
     * Processes raw price ticks into velocity metrics.
     */
    private async processPriceUpdate(tokenId: string, price: number): Promise<void> {
        const now = Date.now();
        this.lastUpdateTrack.set(tokenId, now); 
        
        this.emit('price_update', { tokenId, price, timestamp: now });

        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                
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
        
        history.push({ price, timestamp: now });
        if (history.length > 5) history.shift();
        this.priceHistory.set(tokenId, history);
    }

    /**
     * Returns true if the token is currently in a high-velocity spike.
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
     * Fetches recent flash moves for UI hydration.
     */
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

    /**
     * Disconnects the hub and shuts down the firehose.
     */
    public stop(): void {
        this.isRunning = false;
        this.stopPingInterval();
        
        if (this.circuitResetTimeout) {
            clearTimeout(this.circuitResetTimeout);
            this.circuitResetTimeout = null;
        }
        
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = undefined;
        }
        
        this.priceHistory.clear();
        this.tokenSubscriptionRefs.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}