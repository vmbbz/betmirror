import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { TOKENS } from '../config/env.js';
import { LiquidityHealth } from '../adapters/interfaces.js';
import axios from 'axios';
export class TradeExecutorService {
    deps;
    balanceCache = new Map();
    // ACCOUNTING CORE: Tracks capital in transit
    pendingSpend = 0;
    pendingOrders = new Map();
    lastQuoteTime = new Map();
    inventory = new Map();
    isListening = false;
    isWsRunning = false;
    fillListener; // Store listener reference
    CACHE_TTL = 5 * 60 * 1000;
    PENDING_ORDER_TIMEOUT = 10 * 60 * 1000; // 10 minutes
    REQUOTE_THROTTLE_MS = 8000; // 8 seconds per token re-quote
    cleanupInterval;
    /**
     * Update the pending spend amount for buy orders
     * @param amount - The amount to add or subtract from pending spend
     * @param isAdd - Whether to add (true) or subtract (false) the amount
     * @param orderId - Optional order ID to track pending orders
     */
    updatePendingSpend(amount, isAdd, orderId) {
        if (isAdd) {
            this.pendingSpend += amount;
            if (orderId) {
                this.pendingOrders.set(orderId, { amount, timestamp: Date.now() });
                // Set a timeout to clear pending if not confirmed
                setTimeout(() => {
                    if (this.pendingOrders.has(orderId)) {
                        this.pendingSpend = Math.max(0, this.pendingSpend - amount);
                        this.pendingOrders.delete(orderId);
                    }
                }, 300000); // 5 minutes timeout
            }
        }
        else if (orderId && this.pendingOrders.has(orderId)) {
            const order = this.pendingOrders.get(orderId);
            this.pendingSpend = Math.max(0, this.pendingSpend - order.amount);
            this.pendingOrders.delete(orderId);
        }
        else if (!orderId) {
            this.pendingSpend = Math.max(0, this.pendingSpend - amount);
        }
    }
    // Market Making state
    activeQuotes = new Map();
    // Position tracking
    positionTracking = new Map();
    // Market state tracking
    marketState = new Map();
    // Position scaling configuration
    POSITION_SCALING = {
        VOLATILITY_WINDOW: 20, // Number of periods for volatility calculation
        MAX_SCALING_FACTOR: 2.0, // Maximum position size multiplier
        MIN_SCALING_FACTOR: 0.5, // Minimum position size multiplier
        VOLUME_WINDOW: 10, // Number of periods for volume analysis
        LIQUIDITY_THRESHOLD: 0.1 // Min liquidity as % of position size
    };
    mmConfig = {
        // Core parameters
        quoteSize: 50, // $50 per side default
        spreadOffset: 0.01, // 1 cent from midpoint
        maxPositionUsd: 500, // Max $500 inventory per token
        maxOpenOrdersPerToken: 2, // 1 bid + 1 ask
        rebalanceThreshold: 0.3, // 30% skew triggers rebalance
        // Risk management parameters
        volatilityLookback: 20, // 20 periods for volatility calculation
        maxDailyDrawdown: 0.05, // 5% max daily drawdown
        stopLossPct: 0.03, // 3% stop loss
        positionSizing: {
            baseSize: 0.02, // 2% of portfolio per position
            maxSize: 0.1, // 10% max position size
            volatilityAdjustment: true
        },
        // Advanced controls
        enableDynamicSpreads: true,
        maxSpreadMultiplier: 3.0, // 3x base spread
        minSpreadMultiplier: 0.5 // 0.5x base spread
    };
    constructor(deps, mmConfig) {
        this.deps = deps;
        if (mmConfig)
            this.mmConfig = { ...this.mmConfig, ...mmConfig };
        // Initialize inventory sync
        this.initializeInventory().catch(e => this.deps.logger.error("Inventory Sync Failed", e));
    }
    /**
     * Starts the accounting engine by wiring listeners to the Private WebSocket.
     */
    async start() {
        if (this.isListening)
            return;
        this.isListening = true;
        // Start fill monitor using centralized WebSocket manager
        this.connectUserChannel();
        this.setupFillAccounting();
        // Start cleanup interval for stale orders
        this.startCleanupInterval();
        this.deps.logger.info("💰 Trade Executor: Accounting Heart Activated.");
    }
    /**
     * Stops listeners and cleans up.
     */
    async stop() {
        this.isListening = false;
        // Remove only our listener, not all fill listeners
        if (this.fillListener && this.deps.wsManager) {
            this.deps.wsManager.removeListener('fill', this.fillListener);
            this.fillListener = undefined;
        }
        // Stop cleanup interval
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
        // Clear pending orders on stop to prevent capital lock
        this.pendingOrders.clear();
        this.pendingSpend = 0;
        this.deps.logger.warn('💰 Trade Executor: Accounting Heart Paused.');
    }
    /**
     * Start periodic cleanup of stale pending orders
     */
    startCleanupInterval() {
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleOrders();
        }, 60000); // Check every minute
    }
    /**
     * Remove stale pending orders that have timed out
     */
    cleanupStaleOrders() {
        const now = Date.now();
        const staleOrders = [];
        for (const [orderId, order] of this.pendingOrders.entries()) {
            if (now - order.timestamp > this.PENDING_ORDER_TIMEOUT) {
                staleOrders.push(orderId);
            }
        }
        if (staleOrders.length > 0) {
            let totalReleased = 0;
            for (const orderId of staleOrders) {
                const order = this.pendingOrders.get(orderId);
                if (order) {
                    totalReleased += order.amount;
                    this.pendingSpend = Math.max(0, this.pendingSpend - order.amount);
                    this.pendingOrders.delete(orderId);
                }
            }
            this.deps.logger.warn(`⏰ Cleaned up ${staleOrders.length} stale orders, released $${totalReleased.toFixed(2)}`);
        }
    }
    async initializeInventory() {
        this.deps.logger.info("📦 Synchronizing Executor inventory cache...");
        const positions = await this.deps.adapter.getPositions(this.deps.proxyWallet);
        positions.forEach(p => {
            this.inventory.set(p.tokenId, p.balance);
        });
        this.deps.logger.success(`✅ Inventory synced: ${this.inventory.size} active positions loaded.`);
    }
    /**
     * Connect to user channel using centralized WebSocket manager
     * Note: WebSocket manager should already be started by BotEngine
     */
    connectUserChannel() {
        if (!this.deps.wsManager) {
            this.deps.logger.error('❌ WebSocket manager not available');
            return;
        }
        this.isWsRunning = true;
        this.deps.logger.success('✅ Executor Fill Monitor Connected (Authenticated).');
    }
    setupFillAccounting() {
        if (!this.deps.wsManager) {
            this.deps.logger.error('❌ WebSocket manager not available for fill accounting');
            return;
        }
        // Store listener reference for clean removal
        this.fillListener = (fill) => {
            if (this.isListening) {
                this.handleLiveFill(fill);
            }
        };
        this.deps.wsManager.on('fill', this.fillListener);
        this.deps.logger.debug('🔌 Fill accounting listener registered');
    }
    /**
     * Handles real-time fill events from WebSocket.
     * Updates inventory and pending spend immediately.
     */
    handleLiveFill(fill) {
        try {
            const { asset_id, price, size, side, order_id } = fill;
            // Validate required fields
            if (!asset_id || !price || !size || !side) {
                this.deps.logger.warn('⚠️ Invalid fill event received');
                this.deps.logger.debug(`Fill data: ${JSON.stringify(fill)}`);
                return;
            }
            const isBuy = side.toUpperCase() === 'BUY';
            const tokenId = asset_id;
            const fillSize = parseFloat(size);
            const fillPrice = parseFloat(price);
            if (isNaN(fillSize) || isNaN(fillPrice) || fillSize <= 0 || fillPrice <= 0) {
                this.deps.logger.warn('⚠️ Invalid fill values');
                this.deps.logger.debug(`Fill data: ${JSON.stringify({ asset_id, price, size, side })}`);
                return;
            }
            this.deps.logger.success(`⚡ [FILL DETECTED] ${side} ${fillSize} units @ $${fillPrice}`);
            // 1. Update Inventory Ledger
            const currentInv = this.inventory.get(tokenId) || 0;
            this.inventory.set(tokenId, isBuy ? currentInv + fillSize : currentInv - fillSize);
            // 2. RELEASE Pending Capital if it was a buy
            if (isBuy && order_id) {
                const order = this.pendingOrders.get(order_id);
                if (order) {
                    this.pendingSpend = Math.max(0, this.pendingSpend - order.amount);
                    this.pendingOrders.delete(order_id);
                    this.deps.logger.debug(`💰 Released $${order.amount.toFixed(2)} from pending spend.`);
                }
                else {
                    this.deps.logger.debug(`ℹ️ No pending order found for ${order_id}`);
                }
            }
        }
        catch (error) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            this.deps.logger.error('❌ Error processing fill event', errorObj);
            this.deps.logger.debug(`Fill data: ${JSON.stringify(fill)}`);
        }
    }
    /**
     * Calculate dynamic position size based on volatility and portfolio
     */
    calculateDynamicPositionSize(opportunity, currentInventory) {
        const { midpoint, volatility = 0.05 } = opportunity;
        const { baseSize, maxSize, volatilityAdjustment } = this.mmConfig.positionSizing;
        // Base position size as percentage of portfolio
        let positionPct = baseSize;
        // Adjust for volatility if enabled
        if (volatilityAdjustment) {
            const volAdjustment = Math.min(2, 0.1 / (volatility + 0.05)); // Cap at 2x
            positionPct = Math.min(maxSize, baseSize * volAdjustment);
        }
        // Get portfolio value
        const portfolioValue = this.getPortfolioValue();
        // Calculate max position value and size
        const maxPositionValue = portfolioValue * positionPct;
        const positionSize = maxPositionValue / midpoint;
        return { maxPositionValue, positionSize };
    }
    /**
     * Check if stop loss conditions are met for a position
     */
    async checkStopLossTriggers(tokenId, currentInventory, currentPrice) {
        if (currentInventory <= 0)
            return false;
        // Get average entry price from your position tracking
        const avgEntryPrice = await this.getAverageEntryPrice(tokenId);
        if (!avgEntryPrice)
            return false;
        // Calculate PnL percentage
        const pnlPct = (currentPrice - avgEntryPrice) / avgEntryPrice;
        // Check stop loss
        if (pnlPct <= -this.mmConfig.stopLossPct) {
            this.deps.logger.warn(`[MM] Stop loss triggered for ${tokenId}: ${(pnlPct * 100).toFixed(2)}% < -${(this.mmConfig.stopLossPct * 100).toFixed(2)}%`);
            return true;
        }
        return false;
    }
    /**
     * Calculate dynamic bid/ask prices with inventory skew and volatility adjustment
     */
    calculateDynamicPrices(opportunity, currentInventory, market) {
        const { midpoint, volatility = 0.05, skew = 0 } = opportunity;
        const tickSize = parseFloat(market.tickSize) || 0.01;
        // Base spread offset
        let spreadOffset = this.mmConfig.spreadOffset;
        // Adjust spread based on volatility if enabled
        if (this.mmConfig.enableDynamicSpreads) {
            const volFactor = Math.sqrt(volatility / 0.05); // Normalize to 5% vol
            const spreadMultiplier = Math.max(this.mmConfig.minSpreadMultiplier, Math.min(this.mmConfig.maxSpreadMultiplier, volFactor));
            spreadOffset *= spreadMultiplier;
        }
        // Calculate skew adjustment (more aggressive as inventory increases)
        const maxSkewAdjustment = spreadOffset * 0.5; // Up to 50% of spread
        const skewAdjustment = skew * maxSkewAdjustment;
        // Calculate raw prices
        let bidPrice = midpoint - spreadOffset - skewAdjustment;
        let askPrice = midpoint + spreadOffset - skewAdjustment;
        // Round to nearest tick
        bidPrice = Math.floor(bidPrice / tickSize) * tickSize;
        askPrice = Math.ceil(askPrice / tickSize) * tickSize;
        // Ensure minimum spread
        const minSpread = tickSize * 2;
        if (askPrice - bidPrice < minSpread) {
            const mid = (bidPrice + askPrice) / 2;
            bidPrice = mid - minSpread / 2;
            askPrice = mid + minSpread / 2;
        }
        // Ensure valid price range
        bidPrice = Math.max(0.01, Math.min(0.99, bidPrice));
        askPrice = Math.max(0.01, Math.min(0.99, askPrice));
        return { bidPrice, askPrice };
    }
    /**
     * Calculate optimal order sizes considering inventory and risk limits
     */
    async calculateOptimalSizes(opportunity, currentInventory, positionSize, prices) {
        const { tokenId, rewardsMinSize, midpoint } = opportunity;
        const minSize = rewardsMinSize || 5;
        // Get position scaling factor based on market conditions
        const scalingFactor = this.getPositionScalingFactor(tokenId);
        // Calculate base sizes with scaling
        let bidSize = positionSize.positionSize * scalingFactor;
        let askSize = Math.min(positionSize.positionSize * scalingFactor, currentInventory);
        // Get position score and adjust sizes
        const position = this.positionTracking.get(tokenId);
        if (position) {
            const positionBias = (position.positionScore - 50) / 50; // -1 to 1
            bidSize *= (1 - positionBias * 0.5); // Reduce bid size for high scores
            askSize *= (1 + positionBias * 0.5); // Increase ask size for high scores
        }
        // Adjust for available balance
        const balance = await this.deps.adapter.fetchBalance(this.deps.proxyWallet);
        const availableForBid = Math.max(0, balance - this.pendingSpend);
        if (availableForBid < bidSize * prices.bidPrice) {
            const oldBidSize = bidSize;
            bidSize = availableForBid / prices.bidPrice;
            // Skip market making if balance is critically low
            if (bidSize < minSize || availableForBid < 10) { // $10 minimum threshold
                this.deps.logger.warn(`[MM] Insufficient balance ($${availableForBid.toFixed(2)}) for market making on ${tokenId}`);
                bidSize = 0;
            }
            else {
                this.deps.logger.info(`[MM] Adjusted bid size from ${oldBidSize.toFixed(2)} to ${bidSize.toFixed(2)} for ${tokenId}`);
            }
        }
        // Ensure minimum size requirements
        if (bidSize < minSize) {
            bidSize = 0;
            this.deps.logger.debug(`[MM] Bid size below minimum (${minSize}) for ${tokenId}`);
        }
        if (askSize < minSize) {
            askSize = 0;
            this.deps.logger.debug(`[MM] Ask size below minimum (${minSize}) for ${tokenId}`);
        }
        // Check inventory rebalancing needs
        const inventorySkew = currentInventory / (positionSize.positionSize * 2);
        if (Math.abs(inventorySkew) > this.mmConfig.rebalanceThreshold) {
            if (inventorySkew > 0) {
                // Increase ask size to reduce long inventory
                askSize = Math.min(askSize * 1.5, currentInventory);
                bidSize = Math.max(0, bidSize * 0.5);
            }
            else {
                // Increase bid size to reduce short inventory
                bidSize = Math.max(bidSize * 1.5, 0);
                askSize = Math.min(askSize * 0.5, currentInventory);
            }
            this.deps.logger.info(`[MM] Rebalancing inventory for ${tokenId}: skew=${inventorySkew.toFixed(2)}`);
        }
        // Final validation
        if (bidSize <= 0 && askSize <= 0) {
            return {
                bidSize: 0,
                askSize: 0,
                reason: 'No valid order sizes after all adjustments'
            };
        }
        return {
            bidSize: Math.max(0, bidSize),
            askSize: Math.max(0, askSize)
        };
    }
    getPortfolioValue() {
        return 10000; // Simplified static portfolio size for scoring
    }
    async getAverageEntryPrice(tokenId) {
        const position = this.positionTracking.get(tokenId);
        return position?.entryPrice || null;
    }
    /**
     * Update position tracking with new trade information
     */
    updatePosition(tokenId, price, size, isBuy) {
        const current = this.positionTracking.get(tokenId) || {
            entryPrice: 0,
            size: 0,
            pnl: 0,
            lastUpdated: Date.now(),
            positionScore: 50 // Neutral score
        };
        const newSize = isBuy ? current.size + size : current.size - size;
        // Calculate new average entry price
        let newEntryPrice = current.entryPrice;
        if (isBuy && newSize > 0) {
            newEntryPrice = ((current.entryPrice * current.size) + (price * size)) / newSize;
        }
        // Update position tracking
        this.positionTracking.set(tokenId, {
            entryPrice: newEntryPrice,
            size: newSize,
            pnl: current.pnl + (isBuy ? 0 : (price - current.entryPrice) * size),
            lastUpdated: Date.now(),
            positionScore: this.calculatePositionScore(tokenId, price, newSize, newEntryPrice)
        });
        // Clean up if position is closed
        if (newSize <= 0) {
            this.positionTracking.delete(tokenId);
        }
    }
    /**
     * Calculate a position health score (0-100)
     */
    calculatePositionScore(tokenId, currentPrice, size, entryPrice) {
        // Base score components (0-100)
        const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
        const positionSizeScore = Math.min(100, (Math.abs(size) / (this.mmConfig.maxPositionUsd / currentPrice)) * 100);
        // Get market state
        const marketState = this.marketState.get(tokenId);
        const volatilityScore = marketState?.volatility.length
            ? Math.min(100, (1 / (marketState.volatility[marketState.volatility.length - 1] * 100)) * 100)
            : 50; // Neutral if no data
        // Combine scores with weights
        const weights = {
            pnl: 0.4,
            size: 0.3,
            volatility: 0.3
        };
        // Normalize PnL to 0-100 scale
        const normalizedPnl = Math.min(100, Math.max(0, 50 + (pnlPct * 10)));
        // Calculate weighted score
        return Math.round((normalizedPnl * weights.pnl) +
            (positionSizeScore * weights.size) +
            (volatilityScore * weights.volatility));
    }
    /**
     * Get position scaling factor based on market conditions
     */
    getPositionScalingFactor(tokenId) {
        const market = this.marketState.get(tokenId);
        if (!market || market.volatility.length < 2)
            return 1.0;
        // Calculate average volatility over window
        const avgVolatility = market.volatility.reduce((a, b) => a + b, 0) / market.volatility.length;
        // Calculate volume trend
        const volumeAvg = market.volume.reduce((a, b) => a + b, 0) / market.volume.length;
        const recentVolume = market.volume[market.volume.length - 1];
        const volumeRatio = volumeAvg > 0 ? recentVolume / volumeAvg : 1.0;
        // Calculate spread factor (wider spread = smaller position)
        const avgSpread = market.spread.reduce((a, b) => a + b, 0) / market.spread.length;
        const spreadFactor = Math.max(0.5, Math.min(2.0, 1 / (avgSpread * 10)));
        // Combine factors with weights
        const volFactor = Math.min(2.0, Math.max(0.5, 1 / (avgVolatility * 10)));
        const volumeFactor = Math.min(1.5, Math.max(0.5, volumeRatio));
        // Apply constraints
        return Math.max(this.POSITION_SCALING.MIN_SCALING_FACTOR, Math.min(this.POSITION_SCALING.MAX_SCALING_FACTOR, volFactor * 0.6 + volumeFactor * 0.3 + spreadFactor * 0.1));
    }
    /**
     * Get the exchange adapter instance
     */
    getAdapter() {
        return this.deps.adapter;
    }
    /**
     * Create a direct order through the executor (handles pending spend tracking)
     */
    async createOrder(params) {
        const { adapter, logger } = this.deps;
        try {
            const result = await adapter.createOrder(params);
            // Update pending spend if it's a successful buy order to maintain accurate balance tracking
            if (result.success && params.side === 'BUY') {
                const amount = result.usdFilled || (result.sharesFilled * (result.priceFilled || 0));
                if (amount > 0) {
                    this.updatePendingSpend(amount, true, result.orderId);
                }
            }
            return result;
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[Executor] Direct order failed: ${err.message}`, err);
            throw err;
        }
    }
    /**
     * Update market state with latest price and volume data
     */
    updateMarketStateInternal(tokenId, price, volume, spread) {
        const state = this.marketState.get(tokenId) || {
            volatility: [],
            volume: [],
            spread: [],
            lastMidPrice: price
        };
        // Calculate price change for volatility
        if (state.lastMidPrice > 0) {
            const priceChange = Math.abs((price - state.lastMidPrice) / state.lastMidPrice);
            state.volatility.push(priceChange);
            // Maintain rolling window
            if (state.volatility.length > this.POSITION_SCALING.VOLATILITY_WINDOW) {
                state.volatility.shift();
            }
        }
        // Update volume and spread
        state.volume.push(volume);
        state.spread.push(spread);
        // Maintain rolling windows
        if (state.volume.length > this.POSITION_SCALING.VOLUME_WINDOW) {
            state.volume.shift();
        }
        if (state.spread.length > this.POSITION_SCALING.VOLATILITY_WINDOW) {
            state.spread.shift();
        }
        state.lastMidPrice = price;
        this.marketState.set(tokenId, state);
    }
    async executeMarketMakingQuotes(opportunity) {
        const { logger, adapter, proxyWallet } = this.deps;
        const { tokenId, conditionId, midpoint, spread, rewardsMaxSpread, rewardsMinSize } = opportunity;
        const now = Date.now();
        // 1. Re-quote Throttle Check (Crucial for Rate Limits & Stability)
        const last = this.lastQuoteTime.get(tokenId) || 0;
        if (now - last < this.REQUOTE_THROTTLE_MS) {
            return { tokenId, status: 'SKIPPED', reason: 'throttled' };
        }
        this.lastQuoteTime.set(tokenId, now);
        const vol = opportunity.volatility || 0.05;
        const volume = opportunity.volume || 0;
        // Update market state with latest data
        this.updateMarketStateInternal(tokenId, midpoint, volume, spread);
        const failResult = (reason) => ({
            tokenId,
            status: 'FAILED',
            reason
        });
        try {
            this.deps.logger.info(`⚡ [MM Quote] Processing ${opportunity.question.slice(0, 25)}... (Mid: ${midpoint.toFixed(2)}, Spread: ${(spread * 100).toFixed(1)}¢)`);
            // 2. Check if market is still active
            const market = await this.validateMarketForMM(conditionId);
            if (!market.valid) {
                return failResult(market.reason || 'market_invalid');
            }
            // 3. Cancel existing quotes for this token before placing new ones
            await this.cancelExistingQuotes(tokenId);
            // 4. Check inventory limits with dynamic position sizing
            const currentInventory = await this.getTokenInventory(tokenId);
            const inventoryValueUsd = currentInventory * midpoint;
            // Calculate dynamic position size based on volatility and portfolio
            const positionSize = this.calculateDynamicPositionSize(opportunity, currentInventory);
            // Check if we need to reduce position due to stop loss or drawdown
            if (await this.checkStopLossTriggers(tokenId, currentInventory, midpoint)) {
                logger.warn(`[MM] Stop loss triggered for ${tokenId}, reducing position`);
                return await this.postSingleSideQuote(opportunity, 'SELL', currentInventory);
            }
            // Check if we've hit max position size
            if (inventoryValueUsd >= positionSize.maxPositionValue) {
                logger.warn(`[MM] Position limit reached for ${tokenId}: $${inventoryValueUsd.toFixed(2)}`);
                // Only post asks to reduce inventory
                return await this.postSingleSideQuote(opportunity, 'SELL', currentInventory);
            }
            // 5. Calculate dynamic spreads with inventory skew and volatility adjustment
            const { bidPrice, askPrice } = this.calculateDynamicPrices(opportunity, currentInventory, market);
            // 6. Calculate order sizes with inventory management
            const optimalSizes = await this.calculateOptimalSizes(opportunity, currentInventory, positionSize, { bidPrice, askPrice });
            // If no valid sizes after all adjustments, skip this market
            if (optimalSizes.bidSize <= 0 && optimalSizes.askSize <= 0) {
                return {
                    tokenId,
                    status: 'SKIPPED',
                    reason: 'insufficient_size_after_risk_checks'
                };
            }
            // 7. Final size adjustments
            let finalBidSize = optimalSizes.bidSize;
            let finalAskSize = optimalSizes.askSize;
            // Check rewards min_size requirement
            const minSize = rewardsMinSize || market.minOrderSize || 5;
            if (finalBidSize > 0 && finalBidSize < minSize)
                finalBidSize = minSize;
            if (finalAskSize > 0 && finalAskSize < minSize && currentInventory >= minSize)
                finalAskSize = minSize;
            // Check balance for bid
            const balance = await adapter.fetchBalance(proxyWallet);
            const availableForBid = Math.max(0, balance - this.pendingSpend);
            if (availableForBid < finalBidSize * bidPrice) {
                finalBidSize = availableForBid / bidPrice;
            }
            // 8. Place orders using GTC
            const result = {
                tokenId,
                status: 'POSTED',
                bidPrice,
                askPrice
            };
            // Place BID (buy order)
            if (finalBidSize >= minSize) {
                const bidOrder = await this.placeGTCOrder({
                    tokenId,
                    conditionId,
                    side: 'BUY',
                    price: bidPrice,
                    size: finalBidSize,
                    negRisk: market.negRisk,
                    tickSize: market.tickSize
                });
                if (bidOrder.success) {
                    result.bidOrderId = bidOrder.orderId;
                    this.pendingSpend += finalBidSize * bidPrice;
                }
                else {
                    result.status = 'PARTIAL';
                }
            }
            // Place ASK (sell order)
            if (finalAskSize >= minSize && currentInventory >= minSize) {
                const askOrder = await this.placeGTCOrder({
                    tokenId,
                    conditionId,
                    side: 'SELL',
                    price: askPrice,
                    size: finalAskSize,
                    negRisk: market.negRisk,
                    tickSize: market.tickSize
                });
                if (askOrder.success) {
                    result.askOrderId = askOrder.orderId;
                }
                else {
                    if (!result.bidOrderId)
                        result.status = 'FAILED';
                    else
                        result.status = 'PARTIAL';
                }
            }
            // Track active quotes
            this.activeQuotes.set(tokenId, {
                bidOrderId: result.bidOrderId,
                askOrderId: result.askOrderId
            });
            return result;
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[MM] Quote execution failed: ${err.message}`, err);
            return failResult(err.message);
        }
    }
    /**
     * Place a GTC limit order (required for liquidity rewards)
     */
    async placeGTCOrder(params) {
        const { adapter } = this.deps;
        try {
            const tickSize = parseFloat(params.tickSize) || 0.01;
            const roundedPrice = Math.round(params.price / tickSize) * tickSize;
            const response = await adapter.createOrder({
                marketId: params.conditionId,
                tokenId: params.tokenId,
                outcome: params.side === 'BUY' ? 'YES' : 'NO',
                side: params.side,
                sizeUsd: roundedPrice * params.size,
                sizeShares: params.size,
                priceLimit: roundedPrice,
                orderType: 'GTC'
            });
            if (response.success) {
                return { success: true, orderId: response.orderId };
            }
            else {
                return { success: false, error: response.error || 'Order rejected' };
            }
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return { success: false, error: err.message };
        }
    }
    /**
     * Cancel existing quotes for a token before placing new ones
     */
    async cancelExistingQuotes(tokenId) {
        const { adapter, logger } = this.deps;
        logger.info(`[Executor] Purging existing quotes for token: ${tokenId}`);
        const orders = await adapter.getOpenOrders();
        for (const order of orders) {
            if (order.tokenId === tokenId || order.asset_id === tokenId) {
                await adapter.cancelOrder(order.orderID || order.id);
                logger.debug(`[MM] Cancelled order ${order.orderID || order.id} for token ${tokenId}`);
            }
        }
    }
    /**
     * Post single-side quote (for inventory management)
     */
    async postSingleSideQuote(opportunity, side, inventory) {
        const { logger } = this.deps;
        const { tokenId, conditionId, midpoint, rewardsMaxSpread, rewardsMinSize } = opportunity;
        const market = await this.validateMarketForMM(conditionId);
        if (!market.valid) {
            return { tokenId, status: 'FAILED', reason: market.reason };
        }
        const offset = rewardsMaxSpread ? Math.min(this.mmConfig.spreadOffset, rewardsMaxSpread / 2) : this.mmConfig.spreadOffset;
        const price = side === 'BUY'
            ? Math.max(0.01, midpoint - offset)
            : Math.min(0.99, midpoint + offset);
        const size = side === 'SELL'
            ? Math.min(this.mmConfig.quoteSize / price, inventory)
            : this.mmConfig.quoteSize / price;
        const minSize = rewardsMinSize || market.minOrderSize || 5;
        if (size < minSize) {
            return { tokenId, status: 'SKIPPED', reason: `size_below_minimum: ${size} < ${minSize}` };
        }
        const result = await this.placeGTCOrder({
            tokenId,
            conditionId,
            side,
            price,
            size,
            negRisk: market.negRisk,
            tickSize: market.tickSize
        });
        if (result.success) {
            logger.success(`[MM] ${side} posted: ${size.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
            return {
                tokenId,
                status: 'POSTED',
                [side === 'BUY' ? 'bidOrderId' : 'askOrderId']: result.orderId,
                [side === 'BUY' ? 'bidPrice' : 'askPrice']: price
            };
        }
        return { tokenId, status: 'FAILED', reason: result.error };
    }
    /**
     * Validate market is suitable for market making
     */
    async validateMarketForMM(conditionId) {
        const { adapter } = this.deps;
        const client = adapter.getRawClient?.();
        try {
            const market = await client.getMarket(conditionId);
            if (!market)
                return { valid: false, reason: 'market_not_found', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            if (market.closed)
                return { valid: false, reason: 'market_closed', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            if (!market.active)
                return { valid: false, reason: 'market_inactive', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            if (!market.accepting_orders)
                return { valid: false, reason: 'not_accepting_orders', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            // Skip markets without rewards
            if (!market.rewards?.rates) {
                return { valid: false, reason: 'no_rewards', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
            }
            return {
                valid: true,
                negRisk: market.neg_risk || false,
                tickSize: market.minimum_tick_size?.toString() || '0.01',
                minOrderSize: market.minimum_order_size || 5
            };
        }
        catch (error) {
            return { valid: false, reason: 'validation_error', negRisk: false, tickSize: '0.01', minOrderSize: 5 };
        }
    }
    /**
     * Get current token inventory (share balance)
     */
    async getTokenInventory(tokenId) {
        const { adapter, proxyWallet } = this.deps;
        try {
            const positions = await adapter.getPositions(proxyWallet);
            const position = positions.find(p => p.tokenId === tokenId);
            return position?.balance || 0;
        }
        catch {
            return this.inventory.get(tokenId) || 0;
        }
    }
    /**
     * Cancel all market making quotes (kill switch)
     */
    async cancelAllMMQuotes() {
        const { adapter, logger } = this.deps;
        const client = adapter.getRawClient?.();
        if (!client)
            return;
        try {
            await client.cancelAll();
            this.activeQuotes.clear();
            this.pendingSpend = 0;
            logger.warn('[MM] 🛑 All quotes cancelled');
        }
        catch (error) {
            logger.error(`[MM] Failed to cancel all quotes: ${error}`);
        }
    }
    async checkMarketResolution(position) {
        const { logger, adapter } = this.deps;
        const conditionId = position.conditionId || position.marketId;
        try {
            let market = null;
            let source;
            const client = adapter.getRawClient?.();
            if (client) {
                try {
                    market = await client.getMarket(conditionId);
                    if (market)
                        source = 'CLOB';
                }
                catch (e) {
                    logger.debug(`CLOB 404 for ${conditionId}, checking Gamma fallback...`);
                }
            }
            if (!market) {
                try {
                    const gammaUrl = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
                    const res = await axios.get(gammaUrl);
                    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
                        market = res.data[0];
                        source = 'GAMMA';
                    }
                }
                catch (e) {
                    logger.error(`Gamma fallback failed for ${conditionId}`);
                }
            }
            if (!market) {
                logger.warn(`❌ Market resolution check failed: ID ${conditionId} not found.`);
                return { resolved: false, conditionId };
            }
            logger.info(`📊 Resolution Metadata [${source}] for ${conditionId}: closed=${market.closed}, active=${market.active}, status=${market.status}`);
            const isResolved = market.closed === true || market.status === 'resolved' || market.archived === true;
            if (!isResolved) {
                logger.debug(`⏳ Market ${conditionId} is not resolved yet.`);
                return { resolved: false, market, conditionId, source };
            }
            let winningOutcome;
            let userWon = false;
            if (market.tokens && Array.isArray(market.tokens)) {
                const winningToken = market.tokens.find((t) => t.winner === true);
                if (winningToken)
                    winningOutcome = winningToken.outcome;
            }
            else if (market.winning_outcome) {
                winningOutcome = market.winning_outcome;
            }
            if (winningOutcome) {
                userWon = position.outcome.toUpperCase() === winningOutcome.toUpperCase();
                logger.info(`🏆 Resolution result: Winning=${winningOutcome}, Mine=${position.outcome}, Result=${userWon ? 'WON' : 'LOST'}`);
            }
            return {
                resolved: true,
                winningOutcome,
                userWon,
                market,
                conditionId,
                source
            };
        }
        catch (error) {
            logger.error(`❌ Error in resolution engine: ${error.message}`);
            return { resolved: false, conditionId };
        }
    }
    async executeManualExit(position, currentPrice) {
        const { logger, adapter } = this.deps;
        let remainingShares = position.shares;
        try {
            if (remainingShares < 5) {
                logger.error(`🚨 Cannot Exit: Your balance (${remainingShares.toFixed(2)}) is below the exchange minimum of 5 shares.`);
                return false;
            }
            logger.info(`📉 Executing Market Exit: Offloading ${remainingShares} shares of ${position.tokenId}...`);
            const result = await adapter.createOrder({
                marketId: position.marketId,
                tokenId: position.tokenId,
                outcome: position.outcome,
                side: 'SELL',
                sizeUsd: 0,
                sizeShares: remainingShares,
                priceLimit: 0.001
            });
            if (result.success) {
                const filled = result.sharesFilled || 0;
                const diff = position.shares - filled;
                if (diff > 0.01) {
                    logger.warn(`⚠️ Partial Fill: Only liquidated ${filled}/${position.shares} shares.`);
                }
                logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
                return true;
            }
            else {
                if (result.error?.includes("No orderbook") || result.error?.includes("404")) {
                    logger.info(`Market appears resolved. Checking resolution status...`);
                    const resolution = await this.checkMarketResolution(position);
                    if (resolution.resolved) {
                        if (resolution.userWon) {
                            logger.success(`Market resolved in your favor! Winning outcome: ${resolution.winningOutcome}`);
                            const redeemResult = await adapter.redeemPosition(position.marketId, position.tokenId);
                            if (redeemResult.success) {
                                logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                                return true;
                            }
                            else {
                                logger.error(`Redemption failed: ${redeemResult.error}`);
                                return false;
                            }
                        }
                        else {
                            logger.warn(`Market resolved but you did not win. Winning outcome: ${resolution.winningOutcome || 'Unknown'}`);
                            return false;
                        }
                    }
                    else {
                        logger.warn(`Market status unclear. Attempting redemption as fallback...`);
                        const redeemResult = await adapter.redeemPosition(position.marketId, position.tokenId);
                        if (redeemResult.success) {
                            logger.success(`Redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                            return true;
                        }
                        else {
                            logger.error(`Redemption failed: ${redeemResult.error}`);
                            return false;
                        }
                    }
                }
                logger.error(`Exit attempt failed: ${result.error || "Unknown Error"}`);
                return false;
            }
        }
        catch (e) {
            logger.error(`Failed to execute manual exit: ${e.message}`, e);
            return false;
        }
    }
    async copyTrade(signal) {
        const { logger, env, adapter, proxyWallet } = this.deps;
        const failResult = (reason, status = 'SKIPPED') => ({
            status,
            executedAmount: 0,
            executedShares: 0,
            priceFilled: 0,
            reason
        });
        try {
            try {
                const market = await adapter.getRawClient().getMarket(signal.marketId);
                if (!market) {
                    logger.warn(`[Market Not Found] ${signal.marketId} - Skipping`);
                    return failResult("market_not_found");
                }
                if (market.closed) {
                    logger.warn(`[Market Closed] ${signal.marketId} - Skipping`);
                    return failResult("market_closed");
                }
                if (!market.active || !market.accepting_orders) {
                    logger.warn(`[Market Inactive] ${signal.marketId} - Skipping`);
                    return failResult("market_not_accepting_orders");
                }
                if (market.archived) {
                    logger.warn(`[Market Archived] ${signal.marketId} - Skipping`);
                    return failResult("market_archived");
                }
            }
            catch (e) {
                if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
                    logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position`);
                    try {
                        const positions = await adapter.getPositions(proxyWallet);
                        const existingPosition = positions.find(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                        if (existingPosition) {
                            logger.info(`[Auto-Redeem] Found position: ${existingPosition.balance} shares of ${signal.outcome}`);
                            const redeemResult = await adapter.redeemPosition(signal.marketId, existingPosition.tokenId);
                            if (redeemResult.success) {
                                logger.success(`[Auto-Redeem] Successfully redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                                return {
                                    status: 'FILLED',
                                    executedAmount: redeemResult.amountUsd || 0,
                                    executedShares: existingPosition.balance,
                                    priceFilled: 1.0,
                                    reason: 'Auto-redeemed resolved market position'
                                };
                            }
                            else {
                                logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                                return failResult("redemption_failed", 'FAILED');
                            }
                        }
                        else {
                            logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
                            return failResult("orderbook_not_found");
                        }
                    }
                    catch (redeemError) {
                        logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
                        return failResult("redemption_error", 'FAILED');
                    }
                }
                throw e;
            }
            if (this.deps.adapter.getLiquidityMetrics) {
                try {
                    const metrics = await this.deps.adapter.getLiquidityMetrics(signal.tokenId, signal.side);
                    const minRequired = this.deps.env.minLiquidityFilter || 'LOW';
                    const ranks = {
                        [LiquidityHealth.HIGH]: 3,
                        [LiquidityHealth.MEDIUM]: 2,
                        [LiquidityHealth.LOW]: 1,
                        [LiquidityHealth.CRITICAL]: 0
                    };
                    if (ranks[metrics.health] < ranks[minRequired]) {
                        const msg = `[Liquidity Filter] Health: ${metrics.health} (Min: ${minRequired}) | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)} -> SKIPPING`;
                        logger.warn(msg);
                        return failResult("insufficient_liquidity", "ILLIQUID");
                    }
                    logger.info(`[Liquidity OK] Health: ${metrics.health} | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)}`);
                }
                catch (e) {
                    if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
                        logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position (liquidity check)`);
                        try {
                            const positions = await adapter.getPositions(proxyWallet);
                            const existingPosition = positions.find(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                            if (existingPosition) {
                                logger.info(`[Auto-Redeem] Found position: ${existingPosition.balance} shares of ${signal.outcome}`);
                                const redeemResult = await adapter.redeemPosition(signal.marketId, existingPosition.tokenId);
                                if (redeemResult.success) {
                                    logger.success(`[Auto-Redeem] Successfully redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                                    return {
                                        status: 'FILLED',
                                        executedAmount: redeemResult.amountUsd || 0,
                                        executedShares: existingPosition.balance,
                                        priceFilled: 1.0,
                                        reason: 'Auto-redeemed resolved market position'
                                    };
                                }
                                else {
                                    logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                                    return failResult("redemption_failed", 'FAILED');
                                }
                            }
                            else {
                                logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
                                return failResult("orderbook_not_found");
                            }
                        }
                        catch (redeemError) {
                            logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
                            return failResult("redemption_error", 'FAILED');
                        }
                    }
                    throw e;
                }
            }
            let usableBalanceForTrade = 0;
            let currentShareBalance = 0;
            const [positions, traderBalance] = await Promise.all([
                adapter.getPositions(proxyWallet),
                this.getTraderBalance(signal.trader)
            ]);
            const myPosition = positions.find(p => p.tokenId === signal.tokenId);
            if (myPosition) {
                currentShareBalance = myPosition.balance;
            }
            // Get minimum order size
            let minOrderSize = 5;
            try {
                const book = await adapter.getOrderBook(signal.tokenId);
                if (book.min_order_size)
                    minOrderSize = Number(book.min_order_size);
            }
            catch (e) { }
            // Calculate initial sizing with current balance
            let sizing = computeProportionalSizing({
                yourUsdBalance: 0,
                yourShareBalance: currentShareBalance,
                traderUsdBalance: traderBalance,
                traderTradeUsd: signal.sizeUsd,
                multiplier: env.tradeMultiplier,
                currentPrice: signal.price,
                maxTradeAmount: env.maxTradeAmount,
                minOrderSize: minOrderSize,
                side: signal.side
            });
            if (signal.side === 'BUY') {
                const chainBalance = await adapter.fetchBalance(proxyWallet);
                usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
                sizing = computeProportionalSizing({
                    yourUsdBalance: usableBalanceForTrade,
                    yourShareBalance: currentShareBalance,
                    traderUsdBalance: traderBalance,
                    traderTradeUsd: signal.sizeUsd,
                    multiplier: env.tradeMultiplier,
                    currentPrice: signal.price,
                    maxTradeAmount: env.maxTradeAmount,
                    minOrderSize: minOrderSize,
                    side: signal.side
                });
                if (usableBalanceForTrade < sizing.targetUsdSize) {
                    sizing.targetUsdSize = Math.min(sizing.targetUsdSize, usableBalanceForTrade);
                    if (signal.price > 0) {
                        sizing.targetShares = sizing.targetUsdSize / signal.price;
                    }
                }
            }
            else {
                if (!myPosition || myPosition.balance <= 0)
                    return failResult("no_position_to_sell");
                usableBalanceForTrade = myPosition.valueUsd;
            }
            if (sizing.targetShares <= 0) {
                return failResult(sizing.reason || "skipped_by_sizing_engine");
            }
            if (signal.side === 'BUY' && usableBalanceForTrade < sizing.targetUsdSize) {
                const chainBalance = await adapter.fetchBalance(proxyWallet);
                return failResult(`insufficient_funds (balance: $${chainBalance.toFixed(2)}, ` +
                    `pending: $${this.pendingSpend.toFixed(2)}, ` +
                    `available: $${usableBalanceForTrade.toFixed(2)}, ` +
                    `required: $${sizing.targetUsdSize.toFixed(2)})`, "FAILED");
            }
            let priceLimit = undefined;
            if (signal.side === 'BUY') {
                priceLimit = Math.min(0.99, signal.price * 1.05);
            }
            else {
                priceLimit = Math.max(0.001, signal.price * 0.90);
            }
            logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares) | Reason: ${sizing.reason}`);
            const anyAdapter = adapter;
            if (signal.side === 'BUY' && anyAdapter.safeManager) {
                const safeManager = anyAdapter.safeManager;
                const requiredAmount = BigInt(Math.ceil(sizing.targetUsdSize * 1e6));
                const spender = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
                try {
                    this.deps.logger.info(`[Allowance] Checking USDC allowance for trade: $${sizing.targetUsdSize.toFixed(2)}`);
                    await safeManager.setDynamicAllowance(TOKENS.USDC_BRIDGED, spender, requiredAmount);
                }
                catch (e) {
                    return failResult(`allowance_error: ${e.message}`, 'FAILED');
                }
            }
            const result = await adapter.createOrder({
                marketId: signal.marketId,
                tokenId: signal.tokenId,
                outcome: signal.outcome,
                side: signal.side,
                sizeUsd: sizing.targetUsdSize,
                sizeShares: signal.side === 'SELL' ? sizing.targetShares : undefined,
                priceLimit: priceLimit
            });
            if (!result.success) {
                return {
                    status: 'FAILED',
                    executedAmount: 0,
                    executedShares: 0,
                    priceFilled: 0,
                    reason: result.error || 'Unknown error'
                };
            }
            if (signal.side === 'BUY' && result.sharesFilled > 0) {
                const filledAmount = result.sharesFilled * (result.priceFilled || signal.price || 0);
                this.updatePendingSpend(filledAmount, true, result.orderId);
            }
            return {
                status: 'FILLED',
                txHash: result.orderId || result.txHash,
                executedAmount: result.sharesFilled * (result.priceFilled || signal.price || 0),
                executedShares: result.sharesFilled,
                priceFilled: result.priceFilled || signal.price || 0,
                reason: sizing?.reason
            };
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to copy trade: ${errorMessage}`, err);
            return {
                status: 'FAILED',
                executedAmount: 0,
                executedShares: 0,
                priceFilled: 0,
                reason: errorMessage
            };
        }
    }
    async getTraderBalance(trader) {
        const cached = this.balanceCache.get(trader);
        if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
            return cached.value;
        }
        try {
            const positions = await httpGet(`https://data-api.polymarket.com/positions?user=${trader}`);
            const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
            const val = Math.max(1000, totalValue);
            this.balanceCache.set(trader, { value: val, timestamp: Date.now() });
            return val;
        }
        catch {
            return 10000;
        }
    }
}
