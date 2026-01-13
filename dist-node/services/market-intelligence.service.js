import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { FlashMove } from '../database/index.js';
/**
 * GLOBAL INTELLIGENCE HUB: MarketIntelligenceService
 *
 * Purpose: This is the ONLY service that maintains the primary WebSocket firehose
 * to Polymarket. It acts as a data broker for all other bot modules.
 */
export class MarketIntelligenceService extends EventEmitter {
    logger;
    ws;
    isRunning = false;
    // Connection Management
    connectionAttempts = 0;
    maxConnectionAttempts = 5;
    baseReconnectDelay = 1000;
    maxReconnectDelay = 30000;
    circuitOpen = false;
    circuitResetTimeout = null;
    pingInterval = null;
    // Core Data Structures
    priceHistory = new Map();
    lastUpdateTrack = new Map();
    // Subscription Management
    tokenSubscriptionRefs = new Map();
    // Global Watchlist
    globalWatchlist = new Set();
    // Performance Parameters
    VELOCITY_THRESHOLD = 0.05;
    LOOKBACK_MS = 15000;
    JANITOR_INTERVAL_MS = 60 * 1000; // Aggressive: Check every minute
    PING_INTERVAL_MS = 10000;
    MAX_HISTORY_ITEMS = 3; // Capped at 3 to save heap memory
    // WebSocket URL per Polymarket docs
    WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    constructor(logger) {
        super();
        this.logger = logger;
        this.setMaxListeners(100);
        this.startJanitor();
    }
    /**
     * Updates the global whale filter.
     */
    updateWatchlist(addresses) {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
    }
    /**
     * Requests data for a specific token using correct Polymarket format.
     */
    subscribeToToken(tokenId) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        if (count === 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price", asset_id: tokenId }));
        }
    }
    /**
     * Decrements interest in a token. Unsubscribes if no bots remain.
     */
    unsubscribeFromToken(tokenId) {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
            this.priceHistory.delete(tokenId);
            this.lastUpdateTrack.delete(tokenId);
        }
        else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }
    /**
     * Janitor: Automatically prunes stale price data.
     */
    startJanitor() {
        setInterval(() => {
            if (!this.isRunning)
                return;
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
    startPingInterval() {
        this.stopPingInterval();
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, this.PING_INTERVAL_MS);
    }
    stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.connect();
    }
    connect() {
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
                const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.connectionAttempts), this.maxReconnectDelay);
                this.connectionAttempts++;
                this.logger.warn(`📡 Hub Connection Lost. Reconnecting in ${delay / 1000}s... (Attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);
                if (this.isRunning) {
                    setTimeout(() => this.connect(), delay);
                }
            });
            this.ws.on('error', (err) => {
                this.logger.error("Hub Socket Error: " + err.message);
            });
        }
        catch (error) {
            this.handleConnectionFailure();
        }
    }
    handleWebSocketMessage(data) {
        try {
            const message = data.toString();
            if (message === 'pong' || message === 'PONG' || message === 'PING')
                return;
            let msg;
            try {
                msg = JSON.parse(message);
            }
            catch (parseError) {
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
        }
        catch (e) {
            this.handleConnectionFailure();
        }
    }
    handleLastTradePrice(msg) {
        const tokenId = msg.asset_id;
        const price = parseFloat(msg.price);
        if (tokenId && !isNaN(price)) {
            this.processPriceUpdate(tokenId, price).catch(() => { });
        }
    }
    handleConnectionFailure() {
        this.connectionAttempts++;
        if (this.connectionAttempts >= this.maxConnectionAttempts) {
            this.tripCircuit();
        }
        else {
            const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.connectionAttempts), this.maxReconnectDelay);
            setTimeout(() => this.connect(), delay);
        }
    }
    tripCircuit() {
        this.emit('risk_alert', { level: 'CRITICAL', reason: 'Intelligence Hub instability detected' });
        this.logger.warn('⚠️ Intelligence Hub reporting instability - Monitor only mode enabled.');
        if (this.circuitResetTimeout)
            clearTimeout(this.circuitResetTimeout);
        this.circuitResetTimeout = setTimeout(() => {
            this.connectionAttempts = 0;
            this.logger.info('Instability timer cleared.');
        }, 60000);
    }
    processTradeMessage(msg) {
        const maker = (msg.maker_address || "").toLowerCase();
        const taker = (msg.taker_address || "").toLowerCase();
        const isMakerWhale = this.globalWatchlist.has(maker);
        const isTakerWhale = this.globalWatchlist.has(taker);
        if (isMakerWhale || isTakerWhale) {
            const whaleAddr = isMakerWhale ? maker : taker;
            const event = {
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
    async processPriceUpdate(tokenId, price) {
        const now = Date.now();
        this.lastUpdateTrack.set(tokenId, now);
        this.emit('price_update', { tokenId, price, timestamp: now });
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (now - oldest.timestamp < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    // DECOUPLED EMIT: This allows server.ts to broadcast alpha to the UI
                    // without waiting for specific bot execution loops.
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
        if (history.length > this.MAX_HISTORY_ITEMS)
            history.shift();
        this.priceHistory.set(tokenId, history);
    }
    isSpiking(tokenId) {
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length < 2)
            return false;
        const latest = history[history.length - 1];
        const initial = history[0];
        const velocity = (latest.price - initial.price) / initial.price;
        return velocity > this.VELOCITY_THRESHOLD;
    }
    async getLatestMoves() {
        const moves = await FlashMove.find({
            timestamp: { $gte: new Date(Date.now() - 900000) }
        }).sort({ timestamp: -1 }).limit(20).lean();
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
    stop() {
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
