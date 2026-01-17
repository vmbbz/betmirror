
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.util.js';
import { FlashMove, MoneyMarketOpportunity } from '../database/index.js';
import { WebSocketManager, WhaleTradeEvent, PriceEvent } from './websocket-manager.service.js';

// ADDED: Re-export events for consumer services
export { WhaleTradeEvent, PriceEvent };

/**
 * GLOBAL INTELLIGENCE HUB: MarketIntelligenceService
 * 
 * Purpose: This is the ONLY service that maintains the primary WebSocket firehose 
 * to Polymarket. It acts as a data broker for all other bot modules.
 */
export class MarketIntelligenceService extends EventEmitter {
    public isRunning = false;
    
    // Core Data Structures
    private priceHistory: Map<string, Array<{price: number, ts: number}>> = new Map();
    private lastUpdateTrack: Map<string, number> = new Map();
    
    // Global Watchlist for Copy Trading
    private globalWatchlist: Set<string> = new Set();
    
    // Thresholds
    private readonly VELOCITY_THRESHOLD = 0.03; // 3% move triggers flash move
    private readonly LOOKBACK_MS = 30000;      // 30 second window for velocity check
    private readonly JANITOR_INTERVAL_MS = 60 * 1000;

    constructor(public logger: Logger, public wsManager: WebSocketManager) {
        super();
        this.setMaxListeners(100); 
        this.startJanitor();
        this.logger.info('🔌 Initializing Master Intelligence Pipeline...');
    }

    /**
     * Updates the global whale filter.
     */
    public updateWatchlist(addresses: string[]): void {
        addresses.forEach(addr => this.globalWatchlist.add(addr.toLowerCase()));
        this.wsManager.updateWhaleWatchlist(addresses);
        this.logger.debug(`[Intelligence] Global hub watchlist updated: ${this.globalWatchlist.size} whales total.`);
    }

    /**
     * Requests data for a specific token.
     */
    public subscribeToToken(tokenId: string) {
        this.wsManager.subscribeToToken(tokenId);
    }

    /**
     * Automatic memory management for price data.
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
                this.logger.debug(`[Janitor] Memory reclaimed: Removed ${prunedCount} stale tokens.`);
            }
        }, this.JANITOR_INTERVAL_MS);
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        
        // Setup Relay Listeners
        this.setupRelay();
        
        // Start the shared connection
        await this.wsManager.start();
    }

    private setupRelay() {
        // Relay Whale Trades
        this.wsManager.on('whale_trade', (e: WhaleTradeEvent) => {
            this.emit('whale_trade', e);
        });

        // Relay and Process Prices (Flash Detection)
        this.wsManager.on('price_update', (e: PriceEvent) => {
            this.handlePriceUpdate(e);
        });

        // Relay Market Status Updates
        this.wsManager.on('new_market', (e) => this.emit('new_market', e));
        this.wsManager.on('market_resolved', (e) => this.emit('market_resolved', e));
    }

    private async handlePriceUpdate(event: PriceEvent) {
        const { asset_id: tokenId, price, timestamp } = event;
        this.lastUpdateTrack.set(tokenId, timestamp);
        this.emit('price_update', event);

        // --- Flash Move Detection Logic ---
        const history = this.priceHistory.get(tokenId) || [];
        if (history.length > 0) {
            const oldest = history[0];
            if (timestamp - oldest.ts < this.LOOKBACK_MS) {
                const velocity = (price - oldest.price) / oldest.price;
                if (Math.abs(velocity) >= this.VELOCITY_THRESHOLD) {
                    await this.triggerFlashMove(tokenId, oldest.price, price, velocity, timestamp);
                }
            }
        }
        
        history.push({ price, ts: timestamp });
        if (history.length > 5) history.shift();
        this.priceHistory.set(tokenId, history);
    }

    private async triggerFlashMove(tokenId: string, oldPrice: number, newPrice: number, velocity: number, ts: number) {
        let question = "Aggressive Price Action";
        let image = "";
        let marketSlug = "";
        let conditionId = "";

        // Attempt to find metadata from DB if scanner populated it
        const dbOpp = await MoneyMarketOpportunity.findOne({ tokenId }).lean();
        if (dbOpp) {
            question = dbOpp.question;
            image = dbOpp.image || "";
            marketSlug = dbOpp.marketSlug || "";
            conditionId = dbOpp.marketId;
        }

        const event = { tokenId, conditionId, oldPrice, newPrice, velocity, timestamp: ts, question, image, marketSlug };
        
        // Save to DB for historical heat display
        await FlashMove.create({ ...event, timestamp: new Date(ts) });
        
        this.emit('flash_move', event);
        this.logger.success(`🔥 [FLASH] ${velocity > 0 ? 'Spike' : 'Crash'} detected: ${question.slice(0, 30)}...`);
    }

    public async getLatestMoves(): Promise<any[]> {
        const moves = await FlashMove.find({ 
            timestamp: { $gte: new Date(Date.now() - 86400000) } 
        }).sort({ timestamp: -1 }).limit(20).lean();
        return moves;
    }

    public stop(): void {
        this.isRunning = false;
        this.wsManager.stop();
        this.priceHistory.clear();
        this.logger.info("🔌 Global Hub Shutdown: OFFLINE.");
    }
}