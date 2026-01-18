import { EventEmitter } from 'events';
import { FlashMove } from '../database/index.js';
import { SportsIntelligenceService } from './sports-intelligence.service.js';
/**
 * GLOBAL INTELLIGENCE HUB: MarketIntelligenceService
 *
 * Purpose: This is the ONLY service that maintains the primary WebSocket firehose
 * to Polymarket. It acts as a data broker for all other bot modules.
 *
 * It manages:
 * 1. Global Price/Trade Feed (via WebSocketManager)
 * 2. Real-world Sports Events (via SportsIntelligenceService)
 * 3. High-Velocity Detection (via forwarding FlashMoveService events)
 */
export class MarketIntelligenceService extends EventEmitter {
    logger;
    wsManager;
    flashMoveService;
    marketMetadataService;
    isRunning = false;
    // Subscription Management
    tokenSubscriptionRefs = new Map();
    // Global Watchlist
    globalWatchlist = new Set();
    // Specialized Services
    sportsIntelligence;
    // Performance Parameters
    JANITOR_INTERVAL_MS = 60 * 1000;
    constructor(logger, wsManager, flashMoveService, marketMetadataService) {
        super();
        this.logger = logger;
        this.wsManager = wsManager;
        this.flashMoveService = flashMoveService;
        this.marketMetadataService = marketMetadataService;
        this.setMaxListeners(1500); // Increased to handle high-concurrency bot instances
        this.startJanitor();
        // Initialize Specialized Sports Sniper (Nexus)
        this.sportsIntelligence = new SportsIntelligenceService(logger);
        // Initialize Flash Move Service
        this.flashMoveService = flashMoveService;
        if (this.flashMoveService) {
            this.setupFlashMoveForwarding();
        }
        // CRITICAL: Setup event routing from WebSocketManager and Sports Feed
        if (this.wsManager) {
            this.setupEventRouting();
        }
        this.logger.info('🔌 Initializing Master Intelligence Pipeline as Event Router...');
    }
    /**
     * Centralized event router. Captures events from source services and
     * broadcasts them to the entire bot network.
     */
    setupEventRouting() {
        if (!this.wsManager)
            return;
        // ENRICHMENT ROUTER: Capture whale trades and attach metadata
        this.wsManager.on('whale_trade', async (event) => {
            let enrichedEvent = { ...event };
            // LAZY ENRICHMENT: Only try to add metadata if we have it locally (skipApi = true)
            // This prevents the bot from hitting Polymarket API for every whale signal
            if (this.marketMetadataService) {
                try {
                    const meta = await this.marketMetadataService.getMetadata(event.tokenId, true);
                    if (meta) {
                        enrichedEvent.question = meta.question;
                        enrichedEvent.marketSlug = meta.marketSlug;
                        enrichedEvent.eventSlug = meta.eventSlug;
                        enrichedEvent.conditionId = meta.conditionId;
                    }
                }
                catch (e) {
                    this.logger.debug(`Metadata enrichment skipped for ${event.tokenId} (Cache Miss)`);
                }
            }
            this.emit('whale_trade', enrichedEvent);
        });
        // Route raw price and trade events
        this.wsManager.on('price_update', (event) => this.emit('price_update', event));
        this.wsManager.on('trade', (event) => this.emit('trade', event));
        this.wsManager.on('new_market', (event) => this.emit('new_market', event));
        this.wsManager.on('market_resolved', (event) => this.emit('market_resolved', event));
        // Router for Sports Snipes (The Nexus Feed)
        this.sportsIntelligence.on('sports_score_update', (event) => {
            this.emit('sports_score_update', event);
        });
    }
    /**
     * Sets the global flash move service for the intelligence singleton
     */
    setFlashMoveService(service) {
        this.flashMoveService = service;
        this.setupFlashMoveForwarding();
    }
    /**
     * Sets the global metadata service for enrichment
     */
    setMarketMetadataService(service) {
        this.marketMetadataService = service;
    }
    setupFlashMoveForwarding() {
        if (!this.flashMoveService)
            return;
        this.flashMoveService.on('flash_move_detected', (event) => {
            this.emit('flash_move_detected', event);
        });
    }
    /**
     * Updates the global whale filter and notifies the WebSocket manager.
     */
    updateWatchlist(addresses) {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
        if (this.wsManager) {
            this.wsManager.updateWhaleWatchlist(addresses);
        }
    }
    /**
     * Requests data for a specific token using reference counting.
     */
    subscribeToToken(tokenId) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        if (this.wsManager) {
            this.wsManager.subscribeToToken(tokenId);
        }
    }
    /**
     * Decrements interest in a token. Unsubscribes if no bots remain.
     */
    unsubscribeFromToken(tokenId) {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
            if (this.wsManager) {
                this.wsManager.unsubscribeFromToken(tokenId);
            }
        }
        else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }
    startJanitor() {
        setInterval(() => {
            if (!this.isRunning)
                return;
            // Subscription cleanup logic if needed
        }, this.JANITOR_INTERVAL_MS);
    }
    /**
     * Starts the Intelligence Hub and its underlying specialized feeds.
     */
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        // Start the Main CLOB Feed
        if (this.wsManager) {
            await this.wsManager.start();
        }
        // Start the Sports Nexus Feed
        await this.sportsIntelligence.start();
        this.logger.success('🔌 Global Hub Intelligence Pipeline: ONLINE.');
    }
    /**
     * Fetches the most recent flash moves from the database for UI hydration.
     */
    async getLatestMoves() {
        const moves = await FlashMove.find({
            timestamp: { $gte: new Date(Date.now() - 86400000) }
        }).sort({ timestamp: -1 }).limit(20).lean();
        return moves.map((m) => ({
            tokenId: m.tokenId,
            conditionId: m.conditionId || "",
            oldPrice: m.oldPrice || 0,
            newPrice: m.newPrice || 0,
            velocity: m.velocity || 0,
            momentum: m.momentum || 0,
            volumeSpike: m.volumeSpike || 0,
            confidence: m.confidence || 0.8,
            timestamp: m.timestamp.getTime(),
            question: m.question,
            image: m.image,
            marketSlug: m.marketSlug,
            riskScore: m.riskScore || 50,
            strategy: m.strategy || 'legacy'
        }));
    }
    /**
     * Shuts down the hub and all feeds.
     */
    stop() {
        this.isRunning = false;
        if (this.wsManager)
            this.wsManager.stop();
        this.sportsIntelligence.stop();
        this.tokenSubscriptionRefs.clear();
        this.logger.warn("🔌 Global Hub Intelligence Pipeline: OFFLINE.");
    }
}
