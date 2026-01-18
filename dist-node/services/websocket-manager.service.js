import { EventEmitter } from 'events';
// FIX: Use named import for WebSocket class. The Node.js 'ws' package exports it this way.
import { WebSocket } from 'ws';
import { WS_URLS } from '../config/env.js';
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
    logger;
    adapter;
    marketWs;
    userWs;
    isMarketConnected = false;
    isUserConnected = false;
    isRunning = false;
    marketPingInterval;
    userPingInterval;
    marketReconnectAttempts = 0;
    userReconnectAttempts = 0;
    maxReconnectAttempts = 10;
    maxReconnectDelay = 30000;
    marketSubscriptions = new Set();
    userSubscriptions = new Map();
    // Track cleanup functions to prevent memory leaks
    fillUnsubscribers = [];
    baseReconnectDelay = 1000;
    // Whale detection
    whaleWatchlist = new Set();
    constructor(logger, adapter = null) {
        super();
        this.logger = logger;
        this.adapter = adapter;
        this.setMaxListeners(1500); // Increased to handle high-concurrency bot instances
    }
    /**
     * Start the WebSocket manager and connect to both channels
     */
    async start() {
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
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start WebSocketManager:', err);
            this.isRunning = false;
            throw err;
        }
    }
    /**
     * Stop all WebSocket connections
     */
    stop() {
        this.logger.info('🛑 Stopping WebSocketManager...');
        this.isRunning = false;
        this.stopMarketPing();
        this.stopUserPing();
        if (this.marketWs) {
            // FIX: removeAllListeners is available on Node.js WebSocket implementation from 'ws'
            this.marketWs.removeAllListeners();
            // FIX: Use explicit 1 (OPEN) for readyState check
            if (this.marketWs.readyState === 1) {
                this.marketWs.close();
            }
            this.marketWs = undefined;
        }
        if (this.userWs) {
            // FIX: removeAllListeners is available on Node.js WebSocket implementation from 'ws'
            this.userWs.removeAllListeners();
            // FIX: Use explicit 1 (OPEN) for readyState check
            if (this.userWs.readyState === 1) {
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
    subscribeToToken(tokenId) {
        if (!this.marketSubscriptions.has(tokenId)) {
            this.marketSubscriptions.add(tokenId);
            // FIX: Use explicit 1 (OPEN) for readyState check
            if (this.isMarketConnected && this.marketWs?.readyState === 1) {
                this.sendMarketSubscription(tokenId);
            }
        }
    }
    /**
     * Unsubscribe from market data updates for a specific token
     */
    unsubscribeFromToken(tokenId) {
        if (this.marketSubscriptions.has(tokenId)) {
            this.marketSubscriptions.delete(tokenId);
            // FIX: Use explicit 1 (OPEN) for readyState check
            if (this.isMarketConnected && this.marketWs?.readyState === 1) {
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
    subscribeToFills(callback) {
        const id = 'fills';
        if (!this.userSubscriptions.has(id)) {
            this.userSubscriptions.set(id, new Set());
        }
        this.userSubscriptions.get(id).add(callback);
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
    getConnectionStatus() {
        // FIX: Use explicit 1 (OPEN) for readyState check
        return {
            market: this.isMarketConnected && this.marketWs?.readyState === 1,
            user: this.isUserConnected && this.userWs?.readyState === 1
        };
    }
    /**
     * Connect to the market channel (unauthenticated)
     */
    async connectMarketChannel() {
        return new Promise((resolve, reject) => {
            const wsUrl = `${WS_URLS.CLOB}/ws/market`;
            this.logger.info(`🔌 Connecting to Market Channel: ${wsUrl}`);
            this.marketWs = new WebSocket(wsUrl);
            const wsAny = this.marketWs;
            // FIX: Use .on instead of browser property handlers for Node.js WebSocket
            wsAny.on('open', () => {
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
            // FIX: Use RawData/any for message handling
            wsAny.on('message', (data) => {
                try {
                    const message = data.toString();
                    if (message === 'PONG' || message === 'pong')
                        return;
                    const msg = JSON.parse(message);
                    this.handleMarketMessage(msg);
                }
                catch (error) {
                    // Silent parse errors
                }
            });
            wsAny.on('close', (code) => {
                this.isMarketConnected = false;
                this.logger.warn(`📡 Market Channel closed: ${code}`);
                this.stopMarketPing();
                if (this.isRunning) {
                    this.handleMarketReconnect();
                }
            });
            wsAny.on('error', (error) => {
                this.logger.error(`❌ Market Channel error: ${error.message}`);
                reject(error);
            });
        });
    }
    /**
     * Connect to the user channel (authenticated)
     */
    async connectUserChannel() {
        if (!this.adapter)
            return;
        return new Promise((resolve, reject) => {
            const wsUrl = `${WS_URLS.CLOB}/ws/user`;
            this.logger.info(`🔌 Connecting to User Channel: ${wsUrl}`);
            // Connect without auth headers first, then send auth in subscription message
            this.userWs = new WebSocket(wsUrl);
            const wsAny = this.userWs;
            // FIX: Use .on for Node.js WebSocket
            wsAny.on('open', () => {
                this.isUserConnected = true;
                this.userReconnectAttempts = 0;
                this.logger.success('✅ User Channel Connected (Authenticated)');
                // Send authentication message after connection as per docs
                const authHeaders = this.adapter && typeof this.adapter.getAuthHeaders === 'function'
                    ? this.adapter.getAuthHeaders()
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
            // FIX: Use any for message data
            wsAny.on('message', (data) => {
                try {
                    const message = data.toString();
                    if (message === 'PONG' || message === 'pong')
                        return;
                    const msg = JSON.parse(message);
                    this.handleUserMessage(msg);
                }
                catch (error) {
                    // Silent parse errors
                }
            });
            wsAny.on('close', (code) => {
                this.isUserConnected = false;
                this.logger.warn(`📡 User Channel closed: ${code}`);
                this.stopUserPing();
                if (this.isRunning) {
                    this.handleUserReconnect();
                }
            });
            wsAny.on('error', (error) => {
                this.logger.error(`❌ User Channel error: ${error.message}`);
                reject(error);
            });
        });
    }
    /**
     * Handle messages from the market channel
     */
    handleMarketMessage(msg) {
        if (!msg)
            return;
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
        if (!msg.event_type)
            return;
        switch (msg.event_type) {
            case 'trade':
            case 'trades': // Handle both singular and plural
                const tradeEvent = {
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
    handleBestBidAsk(msg) {
        const tokenId = msg.asset_id || msg.token_id;
        if (!tokenId)
            return;
        const bestBid = parseFloat(msg.best_bid || '0');
        const bestAsk = parseFloat(msg.best_ask || '1');
        if (bestBid > 0 && bestAsk > 0 && bestAsk > bestBid) {
            const priceEvent = {
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
    handleBookUpdate(msg) {
        const tokenId = msg.asset_id;
        const bids = msg.bids || msg.buys || [];
        const asks = msg.asks || msg.sells || [];
        if (bids.length === 0 || asks.length === 0)
            return;
        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');
        if (bestBid > 0 && bestAsk > 0) {
            const priceEvent = {
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
    handleNewMarket(msg) {
        const assetIds = msg.assets_ids || [];
        const question = msg.question || 'New Market';
        const conditionId = msg.market;
        if (assetIds.length !== 2)
            return;
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
    handlePriceChange(msg) {
        const priceChanges = msg.price_changes || [];
        for (const change of priceChanges) {
            const tokenId = change.asset_id;
            const bestBid = parseFloat(change.best_bid || '0');
            const bestAsk = parseFloat(change.best_ask || '1');
            if (bestBid > 0 && bestAsk > 0) {
                const priceEvent = {
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
    handleMarketResolved(msg) {
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
    handleLastTradePrice(msg) {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        if (!tokenId || !price)
            return;
        // Emit price update event only - flash detection handled by FlashDetectionService
        const priceEvent = {
            asset_id: tokenId,
            price,
            timestamp: Date.now()
        };
        this.emit('price_update', priceEvent);
    }
    /**
     * Handle tick size changes
     */
    handleTickSizeChange(msg) {
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
    handleUserMessage(msg) {
        if (msg.event_type === 'trade') {
            // Handle fills - status can be "MATCHED", "MINED", "CONFIRMED", etc.
            const event = {
                asset_id: msg.asset_id,
                price: parseFloat(msg.price),
                size: parseFloat(msg.size),
                side: msg.side.toUpperCase(),
                order_id: msg.taker_order_id || msg.order_id,
                timestamp: Date.now()
            };
            this.emit('fill', event);
            // Notify fill subscribers
            const callbacks = this.userSubscriptions.get('fills');
            if (callbacks) {
                callbacks.forEach(callback => callback(event));
            }
        }
        else if (msg.event_type === 'order') {
            // Handle order placement/update/cancellation
            // msg.type will be "PLACEMENT", "UPDATE", or "CANCELLATION"
            this.logger.debug(`Order event: ${msg.type} for order ${msg.order_id}`);
        }
    }
    /**
     * Send subscription message for a specific token
     */
    sendMarketSubscription(tokenId) {
        // FIX: Use explicit 1 (OPEN) for readyState check
        if (this.marketWs?.readyState === 1) {
            this.marketWs.send(JSON.stringify({
                type: "market",
                assets_ids: [tokenId]
            }));
        }
    }
    /**
     * Resubscribe to all tracked tokens
     */
    resubscribeAllTokens() {
        this.marketSubscriptions.forEach(tokenId => {
            this.sendMarketSubscription(tokenId);
        });
        if (this.marketSubscriptions.size > 0) {
            this.logger.info(`🔌 Resubscribed to ${this.marketSubscriptions.size} tokens`);
        }
    }
    /**
     * Start ping interval for market connection
     */
    startMarketPing() {
        this.stopMarketPing();
        this.marketPingInterval = setInterval(() => {
            // FIX: Use explicit 1 (OPEN) for readyState check
            if (this.marketWs?.readyState === 1) {
                this.marketWs.send('PING');
            }
        }, 10000);
    }
    /**
     * Start ping interval for user connection
     */
    startUserPing() {
        this.stopUserPing();
        this.userPingInterval = setInterval(() => {
            // FIX: Use explicit 1 (OPEN) for readyState check
            if (this.userWs?.readyState === 1) {
                this.userWs.send('PING');
            }
        }, 10000);
    }
    /**
     * Stop market ping interval
     */
    stopMarketPing() {
        if (this.marketPingInterval) {
            clearInterval(this.marketPingInterval);
            this.marketPingInterval = undefined;
        }
    }
    /**
     * Stop user ping interval
     */
    stopUserPing() {
        if (this.userPingInterval) {
            clearInterval(this.userPingInterval);
            this.userPingInterval = undefined;
        }
    }
    /**
     * Handle reconnection for market channel
     */
    handleMarketReconnect() {
        if (this.marketReconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max market reconnection attempts reached');
            return;
        }
        this.marketReconnectAttempts++;
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.marketReconnectAttempts), this.maxReconnectDelay);
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
    handleUserReconnect() {
        if (this.userReconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max user reconnection attempts reached');
            return;
        }
        this.userReconnectAttempts++;
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.userReconnectAttempts), this.maxReconnectDelay);
        this.logger.info(`Attempting to reconnect user channel in ${delay}ms`);
        setTimeout(() => {
            if (this.isRunning) {
                this.connectUserChannel().catch(() => { });
            }
        }, delay);
    }
    /**
     * Update whale watchlist
     */
    updateWhaleWatchlist(addresses) {
        this.whaleWatchlist = new Set(addresses.map(addr => addr.toLowerCase()));
        this.logger.debug(`[WebSocketManager] Whale watchlist updated: ${this.whaleWatchlist.size} whales`);
    }
    /**
     * Check if trade involves whale and emit whale_trade event
     */
    checkAndEmitWhaleTrade(tradeEvent) {
        const maker = tradeEvent.maker_address?.toLowerCase();
        const taker = tradeEvent.taker_address?.toLowerCase();
        if (this.whaleWatchlist.has(maker) || this.whaleWatchlist.has(taker)) {
            const whaleTrader = this.whaleWatchlist.has(maker) ? maker : taker;
            const whaleEvent = {
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
}
