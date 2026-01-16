import { EventEmitter } from 'events';
import type { Data } from 'ws';
import { Logger } from '../utils/logger.util.js';
import { FlashMove, MoneyMarketOpportunity } from '../database/index.js';
import { WebSocketManager } from './websocket-manager.service.js';
import { FlashMoveService, EnhancedFlashMoveEvent } from './flash-move.service.js';
import axios from 'axios';

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
    public isRunning = false;
    
    // Core Data Structures
    private lastUpdateTrack: Map<string, number> = new Map();
    
    // Subscription Management
    private tokenSubscriptionRefs: Map<string, number> = new Map();
    
    // Global Watchlist
    private globalWatchlist: Set<string> = new Set();
    
    // Performance Parameters
    private readonly JANITOR_INTERVAL_MS = 60 * 1000; // Aggressive: Check every minute

    constructor(public logger: Logger, public wsManager?: WebSocketManager, private flashMoveService?: FlashMoveService) {
        super();
        this.setMaxListeners(100); 
        this.startJanitor();
        
        // Initialize Flash Move Service
        this.flashMoveService = flashMoveService;
        
        this.logger.info('🔌 Initializing Master Intelligence Pipeline...');
    }

    /**
     * Updates the global whale filter.
     */
    public updateWatchlist(addresses: string[]): void {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
        
        // Also update WebSocketManager's whale watchlist
        if (this.wsManager) {
            (this.wsManager as any).updateWhaleWatchlist(addresses);
        }
    }

    /**
     * Requests data for a specific token using correct Polymarket format.
     */
    public subscribeToToken(tokenId: string) {
        const count = this.tokenSubscriptionRefs.get(tokenId) || 0;
        this.tokenSubscriptionRefs.set(tokenId, count + 1);
        
        // Use centralized manager if available, otherwise skip
        if (this.wsManager) return;
        
        // FIX: Access static OPEN property from imported WebSocket class
        if (count === 1 && false) {
            // this.ws?.send(JSON.stringify({ type: "subscribe", topic: "last_trade_price", asset_id: tokenId }));
        }
    }

    /**
     * Decrements interest in a token. Unsubscribes if no bots remain.
     */
    public unsubscribeFromToken(tokenId: string): void {
        const count = (this.tokenSubscriptionRefs.get(tokenId) || 0) - 1;
        if (count <= 0) {
            this.tokenSubscriptionRefs.delete(tokenId);
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
                    this.lastUpdateTrack.delete(tokenId);
                    prunedCount++;
                }
            }
            if (prunedCount > 50) {
                this.logger.debug(`[Janitor] Memory reclaimed: Removed ${prunedCount} stale token buffers.`);
            }
        }, this.JANITOR_INTERVAL_MS);
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    private connect() {
        this.logger.info("🔌 Initializing Master Intelligence Pipeline...");
        
        // Use centralized WebSocket manager
        if (this.wsManager) {
            this.logger.success('✅ [GLOBAL HUB] Using centralized WebSocket manager');
            this.isRunning = true;
            
            // CRITICAL: Actually start the WebSocket manager to connect to Polymarket!
            this.wsManager.start().then(() => {
                this.logger.success('🚀 [GLOBAL HUB] WebSocket manager started - connected to Polymarket');
            }).catch((error) => {
                this.logger.error(`❌ [GLOBAL HUB] Failed to start WebSocket manager: ${error}`);
            });
        } else {
            // Fallback to direct connection if no manager available
            try {
                // Note: Centralized manager handles WebSocket connections
                this.logger.warn('⚠️ [GLOBAL HUB] No WebSocket manager provided - skipping direct connection');
            } catch (error) {
                this.logger.error(`❌ [GLOBAL HUB] Failed to initialize: ${error}`);
            }
        }
    }

    
    public async getLatestMoves(): Promise<EnhancedFlashMoveEvent[]> {
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
        // Note: Centralized manager handles connection cleanup
        this.lastUpdateTrack.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}
