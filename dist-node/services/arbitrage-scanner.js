import { WS_URLS } from '../config/env.js';
import EventEmitter from 'events';
import WebSocket from 'ws';
export class ArbitrageScanner extends EventEmitter {
    adapter;
    logger;
    isScanning = false;
    ws;
    priceMap = new Map();
    opportunities = [];
    pingInterval;
    cryptoRegex = /\b(BTC|ETH|SOL|LINK|MATIC|DOGE|Price|climb|fall|above|below|closes|resolves)\b/i;
    constructor(adapter, logger) {
        super();
        this.adapter = adapter;
        this.logger = logger;
    }
    async start() {
        if (this.isScanning)
            return;
        this.isScanning = true;
        this.connect();
        this.logger.success(`🔍 ARB ENGINE: WebSocket Mode Active`);
    }
    connect() {
        if (!this.isScanning)
            return;
        this.logger.info(`🔌 Connecting to WebSocket: ${WS_URLS.CLOB}`);
        this.ws = new WebSocket(WS_URLS.CLOB);
        this.ws.on('open', () => {
            this.logger.info("✅ CLOB WSS: Connected successfully");
            this.subscribe();
            this.startPing();
        });
        this.ws.on('message', (data) => {
            try {
                const messageData = data.toString();
                if (messageData === "PONG")
                    return; // Handle pong response
                const messages = JSON.parse(messageData);
                if (Array.isArray(messages)) {
                    messages.forEach(m => this.processMessage(m));
                }
                else {
                    this.processMessage(messages);
                }
            }
            catch (e) {
                this.logger.error("WSS Message Error", e);
            }
        });
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`📡 CLOB WSS: Disconnected. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
            this.stopPing();
            if (this.isScanning) {
                this.logger.info("🔄 Attempting to reconnect in 5 seconds...");
                setTimeout(() => this.connect(), 5000);
            }
        });
        this.ws.on('error', (error) => {
            this.logger.error(`❌ WebSocket Error: ${error.message}`);
            console.error('WebSocket error details:', error);
        });
    }
    // FIX: Extracted ping logic with proper cleanup
    startPing() {
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send("PING");
            }
        }, 10000); // Per docs: ~10 seconds
    }
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }
    // FIX: Market channel is PUBLIC - no auth needed
    subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const subMsg = {
            type: "market",
            assets_ids: [],
            custom_feature_enabled: true // Required for new_market & best_bid_ask
        };
        this.ws.send(JSON.stringify(subMsg));
    }
    // FIX: Dynamic subscription to new market assets
    subscribeToAssets(assetIds) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !assetIds.length)
            return;
        this.ws.send(JSON.stringify({
            assets_ids: assetIds,
            operation: "subscribe"
        }));
        this.logger.info(`📡 Subscribed to ${assetIds.length} new assets`);
    }
    processMessage(msg) {
        if (msg.event_type === "new_market") {
            this.handleNewMarket(msg);
            return;
        }
        if (msg.event_type === "best_bid_ask") {
            this.handlePriceUpdate(msg);
            return;
        }
    }
    // FIX: Correct field names per docs (assets_ids, outcomes)
    handleNewMarket(msg) {
        const marketId = msg.market;
        const question = msg.question || "New Listing";
        const assetIds = msg.assets_ids || []; // Note: assets_ids (plural)
        const outcomes = msg.outcomes || [];
        const isCrypto = this.cryptoRegex.test(question);
        if (isCrypto) {
            this.logger.success(`✨ HIGH PRIORITY: New Crypto Market: ${question}`);
        }
        // Build outcomes map from event data
        const outcomesMap = {};
        assetIds.forEach((id, idx) => {
            outcomesMap[id] = {
                tokenId: id,
                outcome: outcomes[idx] || `Outcome ${idx}`,
                price: 0,
                size: 0
            };
        });
        this.priceMap.set(marketId, {
            question,
            isNegRisk: assetIds.length === 2,
            isCrypto,
            outcomes: outcomesMap,
            totalLegsExpected: assetIds.length
        });
        // Subscribe to price updates for this new market
        if (assetIds.length > 0) {
            this.subscribeToAssets(assetIds);
        }
    }
    // FIX: Correct field access per docs (best_bid, best_ask, spread)
    handlePriceUpdate(msg) {
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
            market = this.priceMap.get(marketId);
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
    analyzeMarketArb(marketId, market) {
        const legs = Object.values(market.outcomes);
        let combinedCost = 0;
        let minDepth = Infinity;
        for (const leg of legs) {
            if (leg.price >= 1.0 || leg.price <= 0)
                return;
            combinedCost += leg.price;
            minDepth = Math.min(minDepth, leg.size);
        }
        if (combinedCost < 0.995 && combinedCost > 0.01) {
            const profitPerShare = 1.0 - combinedCost;
            const roi = (profitPerShare / combinedCost) * 100;
            const minRoi = market.isCrypto ? 0.25 : 0.4;
            if (roi >= minRoi) {
                const opportunity = {
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
                }
                else {
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
