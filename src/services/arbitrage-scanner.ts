import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { WS_URLS } from '../config/env.js';
import EventEmitter from 'events';
// FIX: Import WebSocket as a class from 'ws' for ESM compatibility in Node.js
import WebSocket from 'ws';
// FIX: Import RawData type for message handling
import type RawData from 'ws';

// FIX: Aligned MarketOpportunity with ArbitrageOpportunity for compatibility with BotEngine callbacks
export interface MarketOpportunity {
    marketId: string; // Added to match ArbitrageOpportunity
    conditionId: string;
    tokenId: string;
    question: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    spreadPct: number;
    midpoint: number;
    volume?: number;
    liquidity?: number;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
    timestamp: number;
    // Compatibility fields for UI
    roi: number; 
    combinedCost: number;
    capacityUsd: number;
}

interface TrackedMarket {
    conditionId: string;
    tokenId: string;
    question: string;
    bestBid: number;
    bestAsk: number;
    spread: number;
    volume?: number;
    liquidity?: number;
    rewardsMaxSpread?: number;
    rewardsMinSize?: number;
}

export interface MarketMakerConfig {
    minSpreadCents: number;      // Min spread to consider (e.g., 2 = 2 cents)
    maxSpreadCents: number;      // Max spread to consider (e.g., 10 cents)
    minVolume?: number;          // Minimum 24h volume USD
    minLiquidity?: number;       // Minimum liquidity USD
    preferRewardMarkets: boolean; // Prioritize markets with liquidity rewards
}

export class MarketMakingScanner extends EventEmitter {
    private isScanning = false;
    private isConnected = false;
    private ws?: WebSocket;
    private trackedMarkets: Map<string, TrackedMarket> = new Map();
    private opportunities: MarketOpportunity[] = [];
    private pingInterval?: NodeJS.Timeout;
    private reconnectAttempts = 0;
    private reconnectTimeout?: NodeJS.Timeout;
    private readonly maxReconnectAttempts = 10;
    private readonly maxReconnectDelay = 30000;

    private config: MarketMakerConfig = {
        minSpreadCents: 2,
        maxSpreadCents: 10,
        minVolume: 1000,
        minLiquidity: 500,
        preferRewardMarkets: true
    };

    constructor(
        private adapter: IExchangeAdapter,
        private logger: Logger,
        config?: Partial<MarketMakerConfig>
    ) {
        super();
        if (config) this.config = { ...this.config, ...config };
    }

    async start() {
        if (this.isScanning && this.isConnected) {
            this.logger.info('🔍 Market making scanner already running');
            return;
        }

        if (this.isScanning) {
            await this.stop();
        }

        this.isScanning = true;
        this.logger.info('🚀 Starting market making scanner...');

        try {
            // 1. Load markets from Gamma API with volume/liquidity filters
            await this.discoverMarkets();
            
            // 2. Connect to WebSocket for real-time spread updates
            this.connect();
            
            this.logger.success('📊 MM ENGINE: Spread Capture Mode Active');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to start scanner:', err);
            this.isScanning = false;
            throw err;
        }
    }

    /**
     * Discover markets via Gamma API, filter by volume/liquidity
     * Docs: https://gamma-api.polymarket.com/events?active=true&closed=false
     */
    private async discoverMarkets() {
        this.logger.info('📡 Discovering markets from Gamma API...');
        
        try {
            const response = await fetch(
                'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume&ascending=false'
            );
            const events = await response.json();

            for (const event of events) {
                if (!event.markets) continue;

                for (const market of event.markets) {
                    // Filter by volume
                    const volume = parseFloat(market.volume || '0');
                    if (this.config.minVolume && volume < this.config.minVolume) continue;

                    // Filter by liquidity
                    const liquidity = parseFloat(market.liquidity || '0');
                    if (this.config.minLiquidity && liquidity < this.config.minLiquidity) continue;

                    // Get token IDs from clobTokenIds
                    const tokenIds: string[] = market.clobTokenIds || [];
                    if (tokenIds.length === 0) continue;

                    // Check rewards config (from CLOB market object)
                    const rewards = market.rewards || {};

                    for (const tokenId of tokenIds) {
                        this.trackedMarkets.set(tokenId, {
                            conditionId: market.conditionId,
                            tokenId,
                            question: market.question,
                            bestBid: 0,
                            bestAsk: 0,
                            spread: 0,
                            volume,
                            liquidity,
                            rewardsMaxSpread: rewards.max_spread,
                            rewardsMinSize: rewards.min_size
                        });
                    }
                }
            }

            this.logger.info(`✅ Tracking ${this.trackedMarkets.size} tokens across ${events.length} events`);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('❌ Failed to discover markets:', err);
        }
    }

    private connect() {
        if (!this.isScanning) return;

        const wsUrl = `${WS_URLS.CLOB}/ws/market`;
        this.logger.info(`🔌 Connecting to ${wsUrl}`);
        // FIX: Instantiate WebSocket correctly for Node.js
        this.ws = new WebSocket(wsUrl);

        // FIX: Use .on() for Node.js WebSocket events
        this.ws.on('open', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.logger.success('✅ WebSocket connected');
            this.subscribeToMarkets();
            this.startPing();
        });

        // FIX: Handle messages with RawData type
        this.ws.on('message', (data: RawData) => {
            try {
                const msg = data.toString();
                if (msg === 'PONG') return;
                
                const parsed = JSON.parse(msg);
                if (Array.isArray(parsed)) {
                    parsed.forEach(m => this.processMessage(m));
                } else {
                    this.processMessage(parsed);
                }
            } catch (error) {
                // Ignore parse errors for non-JSON messages
            }
        });

        this.ws.on('close', (code, reason) => {
            this.isConnected = false;
            this.logger.warn(`📡 WebSocket closed: ${code}`);
            this.stopPing();
            if (this.isScanning) this.handleReconnect();
        });

        this.ws.on('error', (error: Error) => {
            this.logger.error(`❌ WebSocket error: ${error.message}`);
        });
    }

    /**
     * Subscribe to market channel with custom_feature_enabled for best_bid_ask events
     * Per docs: best_bid_ask includes best_bid, best_ask, spread
     */
    private subscribeToMarkets() {
        // FIX: Use static OPEN property from WebSocket class
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const assetIds = Array.from(this.trackedMarkets.keys());
        
        // Subscribe with custom_feature_enabled for best_bid_ask messages
        const subscribeMsg = {
            type: 'market',
            assets_ids: assetIds,
            custom_feature_enabled: true  // Enables best_bid_ask events
        };

        this.ws.send(JSON.stringify(subscribeMsg));
        this.logger.info(`📡 Subscribed to ${assetIds.length} assets with best_bid_ask enabled`);
    }

    /**
     * Process WebSocket messages - focus on best_bid_ask for spread tracking
     * Per docs: best_bid_ask has best_bid, best_ask, spread (all strings)
     */
    private processMessage(msg: any) {
        if (!msg?.event_type) return;

        switch (msg.event_type) {
            case 'best_bid_ask':
                this.handleBestBidAsk(msg);
                break;
            case 'book':
                this.handleBookUpdate(msg);
                break;
            case 'new_market':
                this.handleNewMarket(msg);
                break;
        }
    }

    /**
     * Handle best_bid_ask events - primary spread tracking
     * Per docs: { best_bid, best_ask, spread, asset_id, market, timestamp }
     */
    private handleBestBidAsk(msg: any) {
        const tokenId = msg.asset_id;
        const bestBid = parseFloat(msg.best_bid || '0');
        const bestAsk = parseFloat(msg.best_ask || '1');
        const spread = parseFloat(msg.spread || '0');

        let market = this.trackedMarkets.get(tokenId);
        if (!market) {
            // New market we weren't tracking - add it
            market = {
                conditionId: msg.market,
                tokenId,
                question: 'Unknown',
                bestBid,
                bestAsk,
                spread
            };
            this.trackedMarkets.set(tokenId, market);
        } else {
            market.bestBid = bestBid;
            market.bestAsk = bestAsk;
            market.spread = spread;
        }

        this.evaluateOpportunity(market);
    }

    /**
     * Handle full book updates - fallback for spread calculation
     */
    private handleBookUpdate(msg: any) {
        const tokenId = msg.asset_id;
        const bids = msg.bids || [];
        const asks = msg.asks || [];

        if (bids.length === 0 || asks.length === 0) return;

        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');
        const spread = bestAsk - bestBid;

        let market = this.trackedMarkets.get(tokenId);
        if (market) {
            market.bestBid = bestBid;
            market.bestAsk = bestAsk;
            market.spread = spread;
            this.evaluateOpportunity(market);
        }
    }

    /**
     * Handle new market events - auto-subscribe to promising new markets
     */
    private handleNewMarket(msg: any) {
        const assetIds: string[] = msg.assets_ids || [];
        const question = msg.question || 'New Market';

        this.logger.info(`🆕 New Market: ${question}`);

        // Subscribe to new market's assets
        // FIX: Use static OPEN property from WebSocket class
        if (assetIds.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                assets_ids: assetIds,
                operation: 'subscribe'
            }));

            // Track the new market
            for (const tokenId of assetIds) {
                this.trackedMarkets.set(tokenId, {
                    conditionId: msg.market,
                    tokenId,
                    question,
                    bestBid: 0,
                    bestAsk: 0,
                    spread: 0
                });
            }
        }
    }

    /**
     * Evaluate if a market presents a good MM opportunity
     */
    private evaluateOpportunity(market: TrackedMarket) {
        const spreadCents = market.spread * 100; // Convert to cents
        const midpoint = (market.bestBid + market.bestAsk) / 2;

        // Filter by spread range
        if (spreadCents < this.config.minSpreadCents) return;
        if (spreadCents > this.config.maxSpreadCents) return;

        // Skip if no valid prices
        if (market.bestBid <= 0 || market.bestAsk >= 1) return;

        // FIX: Populated ROI and compatibility fields for UI
        const spreadPct = midpoint > 0 ? (market.spread / midpoint) * 100 : 0;

        const opportunity: MarketOpportunity = {
            marketId: market.conditionId, // Map conditionId to marketId for compatibility
            conditionId: market.conditionId,
            tokenId: market.tokenId,
            question: market.question,
            bestBid: market.bestBid,
            bestAsk: market.bestAsk,
            spread: market.spread,
            spreadPct: spreadPct,
            midpoint,
            volume: market.volume,
            liquidity: market.liquidity,
            rewardsMaxSpread: market.rewardsMaxSpread,
            rewardsMinSize: market.rewardsMinSize,
            timestamp: Date.now(),
            roi: spreadPct, // Compatibility ROI
            combinedCost: 1 - market.spread, // Statistical combined cost estimate
            capacityUsd: market.liquidity || 0
        };

        // Check if eligible for liquidity rewards
        const eligibleForRewards = market.rewardsMaxSpread && 
            spreadCents <= (market.rewardsMaxSpread * 100);

        // Update or add opportunity
        const existingIdx = this.opportunities.findIndex(
            o => o.tokenId === market.tokenId
        );

        if (existingIdx !== -1) {
            this.opportunities[existingIdx] = opportunity;
        } else {
            this.opportunities.push(opportunity);
            
            const rewardTag = eligibleForRewards ? '💰 REWARDS' : '';
            this.logger.success(
                `📊 MM Opportunity: ${market.question.slice(0, 50)}... | ` +
                `Spread: ${spreadCents.toFixed(1)}¢ | Mid: ${(midpoint * 100).toFixed(1)}¢ ${rewardTag}`
            );
        }

        // Sort by spread (wider = more profit potential)
        this.opportunities.sort((a, b) => b.spread - a.spread);

        // Emit for trade executor
        this.emit('opportunity', opportunity);
    }

    private startPing() {
        // FIX: Use static OPEN property from WebSocket class
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, 10000); // Per docs: ~10 seconds
    }

    private stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    private handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);

        this.logger.info(`Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            if (this.isScanning) this.connect();
        }, delay);
    }

    public stop() {
        this.logger.info('🛑 Stopping market making scanner...');
        this.isScanning = false;
        this.isConnected = false;
        this.stopPing();

        if (this.ws) {
            // FIX: Use standard event listener removal for Node.js WebSocket
            this.ws.removeAllListeners();
            // FIX: Use static OPEN property and correct termination for Node.js
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.terminate();
            }
            this.ws = undefined;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        this.logger.warn('🛑 Scanner stopped');
    }

    /**
     * Get current opportunities, filtered by freshness
     */
    getOpportunities(maxAgeMs = 60000): MarketOpportunity[] {
        const now = Date.now();
        return this.opportunities.filter(o => now - o.timestamp < maxAgeMs);
    }

    /**
     * Get opportunities eligible for liquidity rewards
     */
    getRewardEligibleOpportunities(): MarketOpportunity[] {
        return this.getOpportunities().filter(o => 
            o.rewardsMaxSpread && o.spread <= o.rewardsMaxSpread
        );
    }
}
