
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.util.js';
import { FlashMove, MoneyMarketOpportunity, BotLog } from '../database/index.js';
import { WebSocketManager, WhaleTradeEvent, PriceEvent } from './websocket-manager.service.js';
import { FlashMoveService, EnhancedFlashMoveEvent } from './flash-move.service.js';
import axios from 'axios';

// Re-export events for consumer services
export type { WhaleTradeEvent, PriceEvent };

/**
 * GLOBAL INTELLIGENCE HUB: MarketIntelligenceService
 * 
 * Purpose: This is the ONLY service that maintains the primary WebSocket firehose 
 * to Polymarket. It acts as a data broker for all other bot modules.
 */
export class MarketIntelligenceService extends EventEmitter {
    public isRunning = false;
    
    // Subscription Management
    private tokenSubscriptionRefs: Map<string, number> = new Map();
    
    // Global Watchlist
    private globalWatchlist: Set<string> = new Set();
    
    // Performance Parameters
    private readonly JANITOR_INTERVAL_MS = 60 * 1000;

    constructor(public logger: Logger, public wsManager?: WebSocketManager, private flashMoveService?: FlashMoveService) {
        super();
        this.setMaxListeners(1500); // Increased to handle high-concurrency bot instances
        this.startJanitor();
        
        // Initialize Flash Move Service
        this.flashMoveService = flashMoveService;
        
        // If FlashMoveService is provided, forward its events
        if (this.flashMoveService) {
            this.setupFlashMoveForwarding();
        }
        
        // CRITICAL: Setup event routing from WebSocketManager to appropriate services
        if (this.wsManager) {
            // Route whale trades to TradeMonitorService consumers
            this.wsManager.on('whale_trade', (event) => {
                this.emit('whale_trade', event);
            });
            
            // Route price updates to FlashDetectionService
            this.wsManager.on('price_update', (event) => {
                this.emit('price_update', event);
            });
            
            // Route trade events for volume analysis
            this.wsManager.on('trade', (event) => {
                this.emit('trade', event);
            });
            
            // Route market events to appropriate handlers
            this.wsManager.on('new_market', (event) => {
                this.emit('new_market', event);
            });
            
            this.wsManager.on('market_resolved', (event) => {
                this.emit('market_resolved', event);
            });
        }
        
        this.logger.info('🔌 Initializing Master Intelligence Pipeline as Event Router...');
    }

    /**
     * Sets the global flash move service for the intelligence singleton
     */
    public setFlashMoveService(service: FlashMoveService): void {
        this.flashMoveService = service;
        this.setupFlashMoveForwarding();
    }

    private setupFlashMoveForwarding(): void {
        if (!this.flashMoveService) return;
        this.flashMoveService.on('flash_move_detected', (event) => {
            this.emit('flash_move_detected', event);
        });
    }

    /**
     * Updates the global whale filter.
     */
    public updateWatchlist(addresses: string[]): void {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
        
        // Also update WebSocketManager's whale watchlist
        if (this.wsManager) {
            this.wsManager.updateWhaleWatchlist(addresses);
        }
    }

    /**
     * Requests data for a specific token using correct Polymarket format.
     */
    public subscribeToToken(tokenId: string) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        
        if (this.wsManager) {
            this.wsManager.subscribeToToken(tokenId);
        }
    }

    /**
     * Decrements interest in a token. Unsubscribes if no bots remain.
     */
    public unsubscribeFromToken(tokenId: string): void {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
        } else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }

    private startJanitor(): void {
        setInterval(() => {
            if (!this.isRunning) return;
            // Clean up stale subscription tracking if needed
        }, this.JANITOR_INTERVAL_MS);
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    private connect() {
        if (this.wsManager) {
            this.wsManager.start().catch((error) => {
                this.logger.error(`❌ [GLOBAL HUB] WebSocket manager failed: ${error}`);
            });
        }
    }

    public async getLatestMoves(): Promise<EnhancedFlashMoveEvent[]> {
        const moves = await FlashMove.find({ 
            timestamp: { $gte: new Date(Date.now() - 86400000) } 
        }).sort({ timestamp: -1 }).limit(20).lean();

        return moves.map((m: any) => ({
            tokenId: m.tokenId,
            conditionId: m.conditionId || "",
            oldPrice: m.oldPrice || 0,
            newPrice: m.newPrice || 0,
            velocity: m.velocity || 0,
            momentum: 0,
            volumeSpike: 0,
            confidence: 0.8,
            timestamp: m.timestamp.getTime(),
            question: m.question,
            image: m.image,
            marketSlug: m.marketSlug,
            riskScore: 50,
            strategy: 'legacy'
        }));
    }

    public stop(): void {
        this.isRunning = false;
        this.tokenSubscriptionRefs.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}
