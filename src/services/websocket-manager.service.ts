
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { WS_URLS } from '../config/env.js';

export interface WebSocketSubscription {
    type: 'market' | 'user';
    topic: string;
    asset_id?: string;
    callback?: (data: any) => void;
}

export interface FillEvent {
    asset_id: string;
    price: number;
    size: number;
    side: 'BUY' | 'SELL';
    order_id: string;
    timestamp: number;
}

export interface PriceEvent {
    asset_id: string;
    price: number;
    timestamp: number;
}

export interface TradeEvent {
    asset_id: string;
    price: number;
    size: number;
    side: 'BUY' | 'SELL';
    maker_address: string;
    taker_address: string;
    timestamp: number;
}

export interface WhaleTradeEvent {
    trader: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    timestamp: number;
    question?: string; // Optional question field for market context
}

/**
 * Centralized WebSocket Manager for Polymarket CLOB
 * 
 * This service manages single connections to both market and user channels,
 * eliminating duplicate connections across multiple services.
 * 
 * - Market Channel: Unauthenticated connection for price/trade data
 * - User Channel: Authenticated connection for fill events and order updates
 */
export class WebSocketManager extends EventEmitter {
    private marketWs?: WebSocket;
    private userWs?: WebSocket;
    private isMarketConnected = false;
    private isUserConnected = false;
    private isRunning = false;
    
    private marketPingInterval?: NodeJS.Timeout;
    private userPingInterval?: NodeJS.Timeout;
    
    private marketReconnectAttempts = 0;
    private userReconnectAttempts = 0;
    private readonly maxReconnectAttempts = 10;
    private readonly maxReconnectDelay = 30000;
    
    private marketSubscriptions = new Set<string>();
    private userSubscriptions = new Map<string, Set<(data: any) => void>>();
    
    // Track cleanup functions to prevent memory leaks
    private fillUnsubscribers: (() => void)[] = [];
    
    private readonly baseReconnectDelay = 1000;
    
    // Whale detection
    private whaleWatchlist: Set<string> = new Set();

    constructor(
        private logger: Logger,
        private adapter: IExchangeAdapter | null = null
    ) {
        super();
        this.setMaxListeners(1500); // Increased to handle multiple bot instances and prevent memory leak warnings
    }

    /**
     * Start the WebSocket manager and connect to both channels
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('WebSocketManager is already running');
            return;
        }

        this.isRunning = true;
        this.logger.info('🚀 Starting WebSocketManager...');

        try {
            await this.connectMarketChannel();
            await this.connectUserChannel();
            this.logger.success('✅ WebSocketManager started successfully');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start WebSocketManager:', err);
            this.isRunning = false;
            throw err;
        }
    }

    /**
     * Stop all WebSocket connections
     */
    public stop(): void {
        this.logger.info('🛑 Stopping WebSocketManager...');
        this.isRunning = false;

        this.stopMarketPing();
        this.stopUserPing();

        if (this.marketWs) {
            // FIX: removeAllListeners is available on Node.js WebSocket implementation from 'ws'
            this.marketWs.removeAllListeners();
            if (this.marketWs.readyState === WebSocket.OPEN) {
                this.marketWs.close();
            }
            this.marketWs = undefined;
        }

        if (this.userWs) {
            // FIX: removeAllListeners is available on Node.js WebSocket implementation from 'ws'
            this.userWs.removeAllListeners();
            if (this.userWs.readyState === WebSocket.OPEN) {
                this.userWs.close();
            }
            this.userWs = undefined;
        }

        this.isMarketConnected = false;
        this.isUserConnected = false;
        this.marketSubscriptions.clear();
        this.userSubscriptions.clear();

        // Clean up all fill unsubscribers to prevent memory leaks
        this.fillUnsubscribers.forEach(unsub => unsub());
        this.fillUnsubscribers = [];

        this.logger.info('✅ WebSocketManager stopped');
    }

    /**
     * Subscribe to market data updates for a specific token
     */
    public subscribeToToken(tokenId: string): void {
        if (!this.marketSubscriptions.has(tokenId)) {
            this.marketSubscriptions.add(tokenId);
            
            if (this.isMarketConnected && this.marketWs?.readyState === WebSocket.OPEN) {
                this.sendMarketSubscription(tokenId);
            }
        }
    }

    /**
     * Unsubscribe from market data updates for a specific token
     */
    public unsubscribeFromToken(tokenId: string): void {
        if (this.marketSubscriptions.has(tokenId)) {
            this.marketSubscriptions.delete(tokenId);
            
            if (this.isMarketConnected && this.marketWs?.readyState === WebSocket.OPEN) {
                this.marketWs.send(JSON.stringify({
                    assets_ids: [tokenId],
                    operation: "unsubscribe"
                }));
            }
        }
    }

    /**
     * Subscribe to user channel events (fills, order updates)
     */
    public subscribeToFills(callback: (fill: FillEvent) => void): () => void {
        const id = 'fills';
        if (!this.userSubscriptions.has(id)) {
            this.userSubscriptions.set(id, new Set());
        }
        this.userSubscriptions.get(id)!.add(callback);

        // Return unsubscribe function
        return () => {
            const callbacks = this.userSubscriptions.get(id);
            if (callbacks) {
                callbacks.delete(callback);
                if (callbacks.size === 0) {
                    this.userSubscriptions.delete(id);
                }
            }
        };
    }

    /**
     * Get connection status
     */
    public getConnectionStatus(): { market: boolean; user: boolean } {
        return {
            market: this.isMarketConnected && this.marketWs?.readyState === WebSocket.OPEN,
            user: this.isUserConnected && this.userWs?.readyState === WebSocket.OPEN
        };
    }

    /**
     * Connect to the market channel (unauthenticated)
     */
    private async connectMarketChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            const wsUrl = `${WS_URLS.CLOB}/ws/market`;
            this.logger.info(`🔌 Connecting to Market Channel: ${wsUrl}`);

            this.marketWs = new WebSocket(wsUrl);

            // FIX: Use .on instead of browser property handlers for Node.js WebSocket
            this.marketWs.on('open', () => {
                this.isMarketConnected = true;
                this.marketReconnectAttempts = 0;
                this.logger.success('✅ Market Channel Connected');

                // Subscribe to general topics
                this.marketWs?.send(JSON.stringify({ type: "market", assets_ids: [] }));
                this.marketWs?.send(JSON.stringify({ type: "subscribe", topic: "trades" }));

                // Resubscribe to all tokens
                this.resubscribeAllTokens();

                this.startMarketPing();
                resolve();
            });

            // FIX: Use any for data to avoid Namespace 'ws' has no exported member 'Data'
            this.marketWs.on('message', (data: any) => {
                try {
                    const message = data.toString();
                    if (message === 'PONG' || message === 'pong') return;

                    const msg = JSON.parse(message);
                    this.handleMarketMessage(msg);
                } catch (error) {
                    // Silent parse errors
                }
            });

            this.marketWs.on('close', (code: number) => {
                this.isMarketConnected = false;
                this.logger.warn(`📡 Market Channel closed: ${code}`);
                this.stopMarketPing();
                
                if (this.isRunning) {
                    this.handleMarketReconnect();
                }
            });

            this.marketWs.on('error', (error: Error) => {
                this.logger.error(`❌ Market Channel error: ${error.message}`);
                reject(error);
            });
        });
    }

    /**
     * Connect to the user channel (authenticated)
     */
    private async connectUserChannel(): Promise<void> {
        if (!this.adapter) return;

        return new Promise((resolve, reject) => {
            const wsUrl = `${WS_URLS.CLOB}/ws/user`;
            this.logger.info(`🔌 Connecting to User Channel: ${wsUrl}`);

            // Connect without auth headers first, then send auth in subscription message
            this.userWs = new WebSocket(wsUrl);

            // FIX: Use .on for Node.js WebSocket
            this.userWs.on('open', () => {
                this.isUserConnected = true;
                this.userReconnectAttempts = 0;
                this.logger.success('✅ User Channel Connected (Authenticated)');
                
                // Send authentication message after connection as per docs
                const authHeaders = this.adapter && typeof (this.adapter as any).getAuthHeaders === 'function'
                    ? (this.adapter as any).getAuthHeaders()
                    : {};
                    
                // Verify all 3 fields exist
                if (!authHeaders.apiKey || !authHeaders.secret || !authHeaders.passphrase) {
                    this.logger.error('❌ Missing auth credentials for user channel');
                    this.logger.error(`Missing fields: ${!authHeaders.apiKey ? 'apiKey ' : ''}${!authHeaders.secret ? 'secret ' : ''}${!authHeaders.passphrase ? 'passphrase' : ''}`);
                    return;
                }
                    
                this.logger.debug(`Sending auth message: ${JSON.stringify(authHeaders)}`);
                
                this.userWs?.send(JSON.stringify({
                    type: "user",
                    auth: authHeaders,
                    markets: [] // Optional: filter to specific condition IDs
                }));
                
                this.startUserPing();
                resolve();
            });

            // FIX: Use any for data
            this.userWs.on('message', (data: any) => {
                try {
                    const message = data.toString();
                    if (message === 'PONG' || message === 'pong') return;

                    const msg = JSON.parse(message);
                    this.handleUserMessage(msg);
                } catch (error) {
                    // Silent parse errors
                }
            });

            this.userWs.on('close', (code: number) => {
                this.isUserConnected = false;
                this.logger.warn(`📡 User Channel closed: ${code}`);
                this.stopUserPing();
                
                if (this.isRunning) {
                    this.handleUserReconnect();
                }
            });

            this.userWs.on('error', (error: Error) => {
                this.logger.error(`❌ User Channel error: ${error.message}`);
                reject(error);
            });
        });
    }

    /**
     * Handle messages from the market channel
     */
    private handleMarketMessage(msg: any): void {
        if (!msg) return;

        // Propagate all market events to the bus
        this.emit('market_message', msg);

        // Handle initial orderbook dump
        if (msg.type === 'initial_dump' && Array.isArray(msg.data)) {
            this.logger.debug(`Processing initial dump for ${msg.data.length} markets`);
            for (const marketData of msg.data) {
                this.handleMarketMessage({
                    ...marketData,
                    event_type: 'best_bid_ask',
                    asset_id: marketData.asset_id || marketData.token_id
                });
            }
            return;
        }

        if (!msg.event_type) return;

        switch (msg.event_type) {
            case 'trade':
            case 'trades':  // Handle both singular and plural
                const tradeEvent: TradeEvent = {
                    asset_id: msg.asset_id,
                    price: parseFloat(msg.price),
                    size: parseFloat(msg.size),
                    side: msg.side.toUpperCase(),
                    maker_address: msg.maker_address,
                    taker_address: msg.taker_address,
                    timestamp: Date.now()
                };
                this.emit('trade', tradeEvent);
                this.checkAndEmitWhaleTrade(tradeEvent);
                this.logger.debug(`[WebSocketManager] Trade processed: ${msg.side} ${msg.size} @ ${msg.price} by ${msg.maker_address?.slice(0, 10)}...`);
                break;

            case 'best_bid_ask':
                this.handleBestBidAsk(msg);
                break;

            case 'book':
                this.handleBookUpdate(msg);
                break;

            case 'new_market':
                this.handleNewMarket(msg);
                break;

            case 'price_change':
                this.handlePriceChange(msg);
                break;

            case 'market_resolved':
                this.handleMarketResolved(msg);
                break;

            case 'last_trade_price':
                this.handleLastTradePrice(msg);
                break;

            case 'tick_size_change':
                this.handleTickSizeChange(msg);
                break;

            default:
                this.logger.debug(`Unhandled market message type: ${msg.event_type}`);
        }
    }

    /**
     * Handle best bid/ask updates
     */
    private handleBestBidAsk(msg: any): void {
        const tokenId = msg.asset_id || msg.token_id;
        if (!tokenId) return;

        const bestBid = parseFloat(msg.best_bid || '0');
        const bestAsk = parseFloat(msg.best_ask || '1');

        if (bestBid > 0 && bestAsk > 0 && bestAsk > bestBid) {
            const priceEvent: PriceEvent = {
                asset_id: tokenId,
                price: (bestBid + bestAsk) / 2, // Use midpoint as price
                timestamp: Date.now()
            };
            this.emit('price_update', priceEvent);
        }
    }

    /**
     * Handle book updates
     */
    private handleBookUpdate(msg: any): void {
        const tokenId = msg.asset_id;
        const bids = msg.bids || msg.buys || [];
        const asks = msg.asks || msg.sells || [];

        if (bids.length === 0 || asks.length === 0) return;

        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');

        if (bestBid > 0 && bestAsk > 0) {
            const priceEvent: PriceEvent = {
                asset_id: tokenId,
                price: (bestBid + bestAsk) / 2, // Use midpoint as price
                timestamp: Date.now()
            };
            this.emit('price_update', priceEvent);
        }
    }

    /**
     * Handle new market detection
     */
    private handleNewMarket(msg: any): void {
        const assetIds: string[] = msg.assets_ids || [];
        const question = msg.question || 'New Market';
        const conditionId = msg.market;

        if (assetIds.length !== 2) return;

        this.logger.info(`🆕 NEW MARKET DETECTED: ${question}`);

        // Emit new market event for services to handle
        this.emit('new_market', {
            conditionId,
            assetIds,
            question,
            timestamp: Date.now()
        });

        // Auto-subscribe to new market tokens
        assetIds.forEach(tokenId => {
            this.subscribeToToken(tokenId);
        });

        this.logger.success(`✨ Subscribed to new market: ${question.slice(0, 50)}...`);
    }

    /**
     * Handle price changes
     */
    private handlePriceChange(msg: any): void {
        const priceChanges = msg.price_changes || [];

        for (const change of priceChanges) {
            const tokenId = change.asset_id;
            const bestBid = parseFloat(change.best_bid || '0');
            const bestAsk = parseFloat(change.best_ask || '1');

            if (bestBid > 0 && bestAsk > 0) {
                const priceEvent: PriceEvent = {
                    asset_id: tokenId,
                    price: (bestBid + bestAsk) / 2, // Use midpoint as price
                    timestamp: Date.now()
                };
                this.emit('price_update', priceEvent);
            }
        }
    }

    /**
     * Handle market resolution
     */
    private handleMarketResolved(msg: any): void {
        const conditionId = msg.market;
        const winningOutcome = msg.winning_outcome;
        const winningAssetId = msg.winning_asset_id;
        const question = msg.question || 'Unknown';

        this.logger.info(`🏁 MARKET RESOLVED: ${question}`);
        this.logger.info(`🏆 Winner: ${winningOutcome} (${winningAssetId})`);

        // Emit market resolved event
        this.emit('market_resolved', {
            conditionId,
            winningOutcome,
            winningAssetId,
            question,
            timestamp: Date.now()
        });
    }

    /**
     * Handle last trade price updates
     */
    private handleLastTradePrice(msg: any): void {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);

        if (!tokenId || !price) return;

        // Emit price update event only - flash detection handled by FlashDetectionService
        const priceEvent: PriceEvent = {
            asset_id: tokenId,
            price,
            timestamp: Date.now()
        };
        this.emit('price_update', priceEvent);
    }

    /**
     * Handle tick size changes
     */
    private handleTickSizeChange(msg: any): void {
        const tokenId = msg.asset_id;
        const oldTickSize = msg.old_tick_size;
        const newTickSize = msg.new_tick_size;

        this.logger.warn(`📏 TICK SIZE CHANGE: ${tokenId} | ${oldTickSize} → ${newTickSize}`);

        // Emit tick size change event
        this.emit('tick_size_change', {
            tokenId,
            oldTickSize,
            newTickSize,
            timestamp: Date.now()
        });
    }

    /**
     * Handle messages from the user channel
     */
    private handleUserMessage(msg: any): void {
        if (msg.event_type === 'trade') {
            // Handle fills - status can be "MATCHED", "MINED", "CONFIRMED", etc.
            const event: FillEvent = {
                asset_id: msg.asset_id,
                price: parseFloat(msg.price),
                size: parseFloat(msg.size),
                side: msg.side.toUpperCase(),
                order_id: msg.taker_order_id,
                timestamp: Date.now()
            };
            
            this.emit('fill', event);
            
            // Notify fill subscribers
            const callbacks = this.userSubscriptions.get('fills');
            if (callbacks) {
                callbacks.forEach(callback => callback(event));
            }
        } else if (msg.event_type === 'order') {
            // Handle order placement/update/cancellation
            // msg.type will be "PLACEMENT", "UPDATE", or "CANCELLATION"
            this.logger.debug(`Order event: ${msg.type} for order ${msg.order_id}`);
        }
    }

    /**
     * Send subscription message for a specific token
     */
    private sendMarketSubscription(tokenId: string): void {
        if (this.marketWs?.readyState === WebSocket.OPEN) {
            this.marketWs.send(JSON.stringify({
                type: "market",
                assets_ids: [tokenId]
            }));
        }
    }

    /**
     * Resubscribe to all tracked tokens
     */
    private resubscribeAllTokens(): void {
        this.marketSubscriptions.forEach(tokenId => {
            this.sendMarketSubscription(tokenId);
        });
        
        if (this.marketSubscriptions.size > 0) {
            this.logger.info(`膨 Resubscribed to ${this.marketSubscriptions.size} tokens`);
        }
    }

    /**
     * Start ping interval for market connection
     */
    private startMarketPing(): void {
        this.stopMarketPing();
        this.marketPingInterval = setInterval(() => {
            if (this.marketWs?.readyState === WebSocket.OPEN) {
                this.marketWs.send('PING');
            }
        }, 10000);
    }

    /**
     * Start ping interval for user connection
     */
    private startUserPing(): void {
        this.stopUserPing();
        this.userPingInterval = setInterval(() => {
            if (this.userWs?.readyState === WebSocket.OPEN) {
                this.userWs.send('PING');
            }
        }, 10000);
    }

    /**
     * Stop market ping interval
     */
    private stopMarketPing(): void {
        if (this.marketPingInterval) {
            clearInterval(this.marketPingInterval);
            this.marketPingInterval = undefined;
        }
    }

    /**
     * Stop user ping interval
     */
    private stopUserPing(): void {
        if (this.userPingInterval) {
            clearInterval(this.userPingInterval);
            this.userPingInterval = undefined;
        }
    }

    /**
     * Handle reconnection for market channel
     */
    private handleMarketReconnect(): void {
        if (this.marketReconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max market reconnection attempts reached');
            return;
        }

        this.marketReconnectAttempts++;
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.marketReconnectAttempts),
            this.maxReconnectDelay
        );

        this.logger.info(`Attempting to reconnect market channel in ${delay}ms`);
        
        setTimeout(() => {
            if (this.isRunning) {
                this.connectMarketChannel().catch((error) => {
                    const err = error instanceof Error ? error : new Error(String(error));
                    this.logger.error(`Market reconnection failed: ${err.message}`, err);
                });
            }
        }, delay);
    }

    /**
     * Handle reconnection for user channel
     */
    private handleUserReconnect(): void {
        if (this.userReconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max user reconnection attempts reached');
            return;
        }

        this.userReconnectAttempts++;
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.userReconnectAttempts),
            this.maxReconnectDelay
        );

        this.logger.info(`Attempting to reconnect user channel in ${delay}ms`);
        
        setTimeout(() => {
            if (this.isRunning) {
                this.connectUserChannel().catch(() => {});
            }
        }, delay);
    }

    /**
     * Update whale watchlist
     */
    public updateWhaleWatchlist(addresses: string[]): void {
        this.whaleWatchlist = new Set(addresses.map(addr => addr.toLowerCase()));
        this.logger.debug(`[WebSocketManager] Whale watchlist updated: ${this.whaleWatchlist.size} whales`);
    }

    /**
     * Check if trade involves whale and emit whale_trade event
     */
    private checkAndEmitWhaleTrade(tradeEvent: TradeEvent): void {
        const maker = tradeEvent.maker_address?.toLowerCase();
        }
    }, delay);
}

/**
 * Update whale watchlist
 */
public updateWhaleWatchlist(addresses: string[]): void {
    this.whaleWatchlist = new Set(addresses.map(addr => addr.toLowerCase()));
    this.logger.debug(`[WebSocketManager] Whale watchlist updated: ${this.whaleWatchlist.size} whales`);
}

/**
 * Check if trade involves whale and emit whale_trade event
 */
private checkAndEmitWhaleTrade(tradeEvent: TradeEvent): void {
    const maker = tradeEvent.maker_address?.toLowerCase();
    const taker = tradeEvent.taker_address?.toLowerCase();
    
    if (this.whaleWatchlist.has(maker) || this.whaleWatchlist.has(taker)) {
        const whaleTrader = this.whaleWatchlist.has(maker) ? maker : taker;
        
        const whaleEvent: WhaleTradeEvent = {
            trader: whaleTrader,
            tokenId: tradeEvent.asset_id,
            side: tradeEvent.side,
            price: tradeEvent.price,
            size: tradeEvent.size,
            timestamp: tradeEvent.timestamp,
            question: undefined // Will be enriched by TradeMonitorService
        };
        
        this.emit('whale_trade', whaleEvent);
        this.logger.debug(`[WebSocketManager] Whale trade detected: ${whaleTrader.slice(0, 10)}... ${tradeEvent.side} ${tradeEvent.size} @ ${tradeEvent.price}`);
    }
}