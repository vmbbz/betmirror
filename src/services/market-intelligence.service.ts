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
    
    // Core Data Structures
    private lastUpdateTrack: Map<string, number> = new Map();
    
    // Subscription Management
    private tokenSubscriptionRefs: Map<string, number> = new Map();
    
    // Global Watchlist
    private globalWatchlist: Set<string> = new Set();
    private processedHashes: Map<string, number> = new Map();
    
    // Performance Parameters
    private readonly JANITOR_INTERVAL_MS = 60 * 1000; // Aggressive: Check every minute
    private whaleWatcherInterval: NodeJS.Timeout | null = null;

    constructor(public logger: Logger, public wsManager?: WebSocketManager, private flashMoveService?: FlashMoveService) {
        super();
        this.setMaxListeners(200); // Increased to handle multiple bot instances
        this.startJanitor();
        
        // Initialize Flash Move Service
        this.flashMoveService = flashMoveService;
        
        // If FlashMoveService is provided, forward its events
        if (this.flashMoveService) {
            this.flashMoveService.on('flash_move_detected', (event) => {
                this.emit('flash_move_detected', event);
            });
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
            
            // Route trade events to FlashDetectionService for volume analysis
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
            this.lastUpdateTrack.delete(tokenId);
        } else {
            this.tokenSubscriptionRefs.set(tokenId, count);
        }
    }

    /**
     * Centralized Whale Watcher: Polls activity for all whales in the global watchlist.
     */
    private async startWhaleWatcher() {
        if (this.whaleWatcherInterval) clearInterval(this.whaleWatcherInterval);

        this.whaleWatcherInterval = setInterval(async () => {
            if (!this.isRunning || this.globalWatchlist.size === 0) return;

            // Iterate through watchlist and fetch activity
            const whales = Array.from(this.globalWatchlist);
            for (const address of whales) {
                try {
                    const res = await axios.get(`https://data-api.polymarket.com/activity?user=${address}&limit=5`);
                    if (res.data && Array.isArray(res.data)) {
                        for (const act of res.data) {
                            if (act.type !== 'TRADE' && act.type !== 'ORDER_FILLED') continue;
                            
                            const hash = `${address}-${act.asset}-${act.timestamp}`;
                            if (this.processedHashes.has(hash)) continue;
                            this.processedHashes.set(hash, Date.now());

                            const whaleEvent: WhaleTradeEvent = {
                                trader: address,
                                tokenId: act.asset,
                                side: act.side.toUpperCase() as 'BUY' | 'SELL',
                                price: act.price,
                                size: act.size,
                                timestamp: act.timestamp * 1000,
                                question: act.question
                            };

                            this.logger.success(`🐋 [WHALE HUB] Detected Trade from ${address.slice(0, 10)}...`);
                            this.emit('whale_trade', whaleEvent);
                        }
                    }
                } catch (e) {
                    this.logger.debug(`Whale poll failed for ${address}`);
                }
                // Small sleep to avoid hitting rate limits
                await new Promise(r => setTimeout(r, 200));
            }
        }, 10000); // Poll every 10 seconds
    }

    /**
     * Janitor: Automatically prunes stale data.
     */
    private startJanitor(): void {
        setInterval(() => {
            if (!this.isRunning) return;
            const now = Date.now();
            
            // Prune update track
            let prunedTrack = 0;
            for (const [tokenId, lastTs] of this.lastUpdateTrack.entries()) {
                if (now - lastTs > 15 * 60 * 1000) {
                    this.lastUpdateTrack.delete(tokenId);
                    prunedTrack++;
                }
            }

            // Prune hashes
            let prunedHashes = 0;
            for (const [hash, ts] of this.processedHashes.entries()) {
                if (now - ts > 60 * 60 * 1000) {
                    this.processedHashes.delete(hash);
                    prunedHashes++;
                }
            }
            
            if (prunedTrack > 0 || prunedHashes > 0) {
                this.logger.debug(`[Janitor] Memory reclaimed: ${prunedTrack} tracks, ${prunedHashes} hashes.`);
            }
        }, this.JANITOR_INTERVAL_MS);
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
        this.startWhaleWatcher();
    }

    private connect() {
        this.logger.info("🔌 Initializing Master Intelligence Pipeline...");
        
        if (this.wsManager) {
            this.logger.success('✅ [GLOBAL HUB] Using centralized WebSocket manager');
            this.wsManager.start().then(() => {
                this.logger.success('🚀 [GLOBAL HUB] WebSocket manager started - connected to Polymarket');
            }).catch((error) => {
                this.logger.error(`❌ [GLOBAL HUB] Failed to start WebSocket manager: ${error}`);
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
        if (this.whaleWatcherInterval) clearInterval(this.whaleWatcherInterval);
        this.lastUpdateTrack.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}
