import { IExchangeAdapter, ArbitrageOpportunity } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { WS_URLS } from '../config/env.js';
import EventEmitter from 'events';
import WebSocket from 'ws';

interface MarketPrices {
    question: string;
    isNegRisk: boolean;
    isCrypto: boolean;
    outcomes: Record<string, {
        tokenId: string;
        outcome: string;
        price: number;
        size: number;
    }>;
    totalLegsExpected: number;
}

export class ArbitrageScanner extends EventEmitter {
    private isScanning = false;
    private isConnected = false;
    private ws?: WebSocket;
    private priceMap: Map<string, MarketPrices> = new Map();
    private opportunities: ArbitrageOpportunity[] = [];
    private pingInterval?: NodeJS.Timeout;
    private reconnectAttempts = 0;
    private reconnectDelay = 1000;
    private readonly maxReconnectAttempts = 10;
    private readonly maxReconnectDelay = 30000; // 30 seconds

    private readonly cryptoRegex = /\b(BTC|ETH|SOL|LINK|MATIC|DOGE|Price|climb|fall|above|below|closes|resolves)\b/i;

    constructor(
        private adapter: IExchangeAdapter,
        private logger: Logger
    ) {
        super();
    }

    async start() {
        if (this.isScanning) {
            this.logger.info('🔍 Arbitrage scanner is already running');
            return;
        }
        this.isScanning = true;
        this.logger.info('🚀 Starting arbitrage scanner...');
        this.connect();
        this.logger.success('🔍 ARB ENGINE: WebSocket Mode Active');
    }

    private connect() {
        if (!this.isScanning) {
            this.logger.warn('⚠️ Cannot connect: scanner is not in scanning state');
            return;
        }

        this.logger.info(`🔌 Connecting to Polymarket WebSocket: ${WS_URLS.CLOB}`);
        this.ws = new WebSocket(WS_URLS.CLOB);
        this.logger.debug('WebSocket instance created, setting up event handlers...');

        this.ws.on('open', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
            this.logger.success('✅ WebSocket connected successfully');
            this.subscribeToMarkets();
            this.startPing();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const messageData = data.toString();
                if (messageData === 'PONG') return; // Handle pong response
                
                let messages;
                try {
                    messages = JSON.parse(messageData);
                } catch (e) {
                    const error = e instanceof Error ? e : new Error(String(e));
                    this.logger.error('Failed to parse WebSocket message', error);
                    return;
                }

                if (Array.isArray(messages)) {
                    messages.forEach(m => this.processMessage(m));
                } else {
                    this.processMessage(messages);
                }
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                this.logger.error('Error processing WebSocket message', err);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.isConnected = false;
            this.logger.warn(`📡 WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
            this.stopPing();
            if (this.isScanning) {
                this.handleReconnect();
            }
        });

        this.ws.on('error', (error: Error) => {
            this.logger.error(`❌ WebSocket error: ${error.message}`);
        });
    }

    private handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached. Giving up.');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        
        this.logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        setTimeout(() => {
            if (this.isScanning) {
                this.connect();
            }
        }, delay);
    }

    // FIX: Extracted ping logic with proper cleanup
    private startPing() {
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send("PING");
            }
        }, 10000); // Per docs: ~10 seconds
    }

    private stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    private subscribeToMarkets() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.warn('⚠️ Cannot subscribe: WebSocket is not open');
            return;
        }

        const subscribeMessage = {
            type: 'subscribe',
            channel: 'markets',
            id: `markets-${Date.now()}`,
            payload: {}
        };

        this.logger.debug(`Subscribing to market updates: ${JSON.stringify(subscribeMessage)}`);
        this.ws.send(JSON.stringify(subscribeMessage));
        this.logger.info('📡 Subscribed to market updates');
    }

    // FIX: Updated for RTDS API
    private subscribeToAssets(assetIds: string[]) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !assetIds.length) return;

        const subMsg = {
            type: "subscribe",
            channel: "orderbook",
            id: `orderbook-${Date.now()}`,
            payload: {
                market: "all",
                asset_ids: assetIds
            }
        };

        this.ws.send(JSON.stringify(subMsg));
        this.logger.info(`📡 Subscribed to ${assetIds.length} assets`);
    }

    private processMessage(msg: any) {
        if (!msg) {
            this.logger.warn('Received empty message');
            return;
        }

        this.logger.debug(`Received message: ${JSON.stringify(msg)}`);

        switch (msg.event_type) {
            case 'new_market':
                this.logger.info(`🆕 New market detected: ${msg.question || 'Unknown market'}`);
                this.handleNewMarket(msg);
                break;
                
            case 'best_bid_ask':
                this.logger.debug(`🔁 Price update received for market: ${msg.market}`);
                this.handlePriceUpdate(msg);
                break;
                
            case 'market_resolved':
                this.logger.info(`🏁 Market resolved: ${msg.market}`);
                // Handle resolved market if needed
                break;
                
            default:
                this.logger.debug(`Unhandled message type: ${msg.event_type}`);
        }
    }

    private handleNewMarket(msg: any) {
        const marketId = msg.market;
        const question = msg.question || 'New Market';
        const assetIds: string[] = msg.assets_ids || [];
        const outcomes: string[] = msg.outcomes || [];
        const isCrypto = this.cryptoRegex.test(question);
        
        this.logger.info(`🆕 New Market: ${question} (${marketId})`);
        this.logger.debug(`Market details: ${JSON.stringify({
            question,
            assetIds,
            outcomes,
            timestamp: msg.timestamp ? new Date(parseInt(msg.timestamp)).toISOString() : 'unknown'
        })}`);

        if (isCrypto) {
            this.logger.success(`✨ HIGH PRIORITY: New Crypto Market: ${question}`);
        }

        // Build outcomes map from event data
        const outcomesMap: Record<string, any> = {};
        assetIds.forEach((id, idx) => {
            const outcome = outcomes[idx] || `Outcome ${idx}`;
            outcomesMap[id] = {
                tokenId: id,
                outcome,
                price: 0,
                size: 0
            };
            this.logger.debug(`  - Outcome ${idx + 1}: ${outcome} (${id})`);
        });

        this.priceMap.set(marketId, {
            question,
            isNegRisk: assetIds.length === 2, // Binary markets are negative risk
            isCrypto,
            outcomes: outcomesMap,
            totalLegsExpected: assetIds.length
        });

        // Subscribe to price updates for this new market
        if (assetIds.length > 0) {
            this.logger.info(`🔍 Subscribing to ${assetIds.length} assets for new market: ${question}`);
            this.subscribeToAssets(assetIds);
        } else {
            this.logger.warn(`⚠️ No asset IDs found for market: ${marketId}`);
        }
    }

    // FIX: Correct field access per docs (best_bid, best_ask, spread)
    private handlePriceUpdate(msg: any) {
        const marketId = msg.market;
        const tokenId = msg.asset_id;
        // Per docs: best_bid_ask has best_bid, best_ask, spread (all strings)
        const bestAsk = parseFloat(msg.best_ask || "1");
        const bestBid = parseFloat(msg.best_bid || "0");
        // Note: best_bid_ask does NOT include size/depth - use REST /book endpoint

        let market = this.priceMap.get(marketId);

        if (!market) {
            this.priceMap.set(marketId, {
                question: "Syncing...",
                isNegRisk: true,
                isCrypto: false,
                outcomes: {},
                totalLegsExpected: 2
            });
            market = this.priceMap.get(marketId)!;
        }

        market.outcomes[tokenId] = {
            tokenId,
            outcome: market.outcomes[tokenId]?.outcome || "UNK",
            price: bestAsk,
            size: 0 // best_bid_ask doesn't include depth
        };

        if (Object.keys(market.outcomes).length >= market.totalLegsExpected) {
            this.analyzeMarketArb(marketId, market);
        }
    }

    private analyzeMarketArb(marketId: string, market: MarketPrices) {
        const legs = Object.values(market.outcomes);
        let combinedCost = 0;
        let minDepth = Infinity;

        for (const leg of legs) {
            if (leg.price >= 1.0 || leg.price <= 0) return;
            combinedCost += leg.price;
            minDepth = Math.min(minDepth, leg.size);
        }

        if (combinedCost < 0.995 && combinedCost > 0.01) {
            const profitPerShare = 1.0 - combinedCost;
            const roi = (profitPerShare / combinedCost) * 100;
            const minRoi = market.isCrypto ? 0.25 : 0.4;

            if (roi >= minRoi) {
                const opportunity: ArbitrageOpportunity = {
                    marketId,
                    question: market.question,
                    combinedCost,
                    potentialProfit: profitPerShare,
                    roi,
                    capacityUsd: minDepth * combinedCost,
                    legs: legs.map(l => ({
                        tokenId: l.tokenId,
                        outcome: l.outcome,
                        price: l.price,
                        depth: l.size
                    })),
                    timestamp: Date.now()
                };

                const existingIdx = this.opportunities.findIndex(o => o.marketId === marketId);
                if (existingIdx !== -1) {
                    if (roi > this.opportunities[existingIdx].roi + 0.1) {
                        this.opportunities[existingIdx] = opportunity;
                        this.emit('opportunity', opportunity);
                    }
                } else {
                    this.opportunities.push(opportunity);
                    this.opportunities.sort((a, b) => b.roi - a.roi);
                    this.emit('opportunity', opportunity);
                    this.logger.success(`💎 ARB FOUND: ${market.question} | ROI: ${roi.toFixed(2)}%`);
                }
            }
        }
    }

    stop() {
        this.isScanning = false;
        this.stopPing();
        if (this.ws) {
            this.ws.terminate();
            this.ws = undefined;
        }
        this.logger.warn('🛑 Arbitrage scanner stopped');
    }

    getLatestOpportunities() {
        const now = Date.now();
        this.opportunities = this.opportunities.filter(o => now - o.timestamp < 120000);
        return this.opportunities;
    }
}