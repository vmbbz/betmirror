import { EventEmitter } from 'events';
export class FomoRunnerService extends EventEmitter {
    intelligence;
    executor;
    adapter;
    logger;
    isEnabled = false;
    autoTpPercent = 0.20;
    activeSnipes = new Map();
    LIQUIDITY_FLOOR = 1000;
    STOP_LOSS_PCT = 0.10;
    constructor(intelligence, executor, adapter, logger) {
        super();
        this.intelligence = intelligence;
        this.executor = executor;
        this.adapter = adapter;
        this.logger = logger;
        this.intelligence.on('flash_move', (e) => this.handleFlashMove(e));
        // FIX: Listener now matches the correctly emitted event name from Intelligence service
        this.intelligence.on('price_update', (d) => this.handlePriceUpdate(d));
    }
    setConfig(enabled, tpPercent) {
        this.isEnabled = enabled;
        this.autoTpPercent = tpPercent;
        if (!enabled)
            this.activeSnipes.clear();
        this.logger.info(`🚀 [FOMO] Engine ${enabled ? 'ONLINE' : 'OFFLINE'} | TP: ${tpPercent * 100}%`);
    }
    getActiveSnipes() {
        return Array.from(this.activeSnipes.values());
    }
    async handleFlashMove(event) {
        if (!this.isEnabled) {
            this.logger.debug(`[FOMO] Move detected on ${event.tokenId.slice(0, 8)} but trader is disabled (Fund bot to activate)`);
            return;
        }
        if (this.activeSnipes.has(event.tokenId))
            return;
        if (event.velocity < 0.05)
            return;
        try {
            const metrics = await this.adapter.getLiquidityMetrics?.(event.tokenId, 'BUY');
            if (metrics && metrics.availableDepthUsd < this.LIQUIDITY_FLOOR) {
                this.logger.warn(`[FOMO] Skipping ${event.tokenId.slice(0, 8)}: Low liquidity ($${metrics.availableDepthUsd.toFixed(0)})`);
                return;
            }
            const slippagePrice = Math.min(0.99, event.newPrice * 1.01);
            this.logger.info(`[FOMO] Attempting SNIPE Entry on ${event.question || event.tokenId.slice(0, 8)} @ $${event.newPrice}`);
            const result = await this.executor.createOrder({
                marketId: event.conditionId,
                tokenId: event.tokenId,
                outcome: 'YES',
                side: 'BUY',
                sizeUsd: 50,
                orderType: 'FOK',
                priceLimit: slippagePrice
            });
            if (result.success && result.sharesFilled > 0) {
                const tpPrice = Math.min(0.99, result.priceFilled * (1 + this.autoTpPercent));
                this.activeSnipes.set(event.tokenId, {
                    tokenId: event.tokenId,
                    conditionId: event.conditionId,
                    entryPrice: result.priceFilled,
                    shares: result.sharesFilled,
                    timestamp: Date.now(),
                    targetPrice: tpPrice,
                    currentPrice: result.priceFilled,
                    question: event.question
                });
                this.logger.success(`[FOMO] Entry FILLED. Parking TP Limit at $${tpPrice.toFixed(2)}`);
                await this.executor.createOrder({
                    marketId: event.conditionId,
                    tokenId: event.tokenId,
                    outcome: 'YES',
                    side: 'SELL',
                    sizeShares: result.sharesFilled,
                    sizeUsd: result.sharesFilled * tpPrice,
                    priceLimit: tpPrice,
                    orderType: 'GTC'
                });
                this.emit('fomo_trade_filled', {
                    ...result,
                    serviceOrigin: 'FOMO',
                    marketId: event.conditionId,
                    targetPrice: tpPrice
                });
            }
            else {
                this.logger.warn(`[FOMO] Snipe entry FAILED or FOK expired: ${result.error || 'No liquidity at target price'}`);
            }
        }
        catch (e) {
            this.logger.error(`[FOMO] Error processing flash move: ${e.message}`);
        }
    }
    async handlePriceUpdate(data) {
        const snipe = this.activeSnipes.get(data.tokenId);
        if (!snipe)
            return;
        // Update current price for UI tracking
        snipe.currentPrice = data.price;
        const currentDrop = (snipe.entryPrice - data.price) / snipe.entryPrice;
        // Exit if position loses 10% of its entry value (Hard Stop Loss)
        if (currentDrop >= this.STOP_LOSS_PCT) {
            this.logger.error(`🚨 [FOMO] STOP LOSS TRIGGERED for ${snipe.tokenId.slice(0, 8)}. Reversing position...`);
            await this.executor.createOrder({
                marketId: snipe.conditionId,
                tokenId: snipe.tokenId,
                outcome: 'YES',
                side: 'SELL',
                sizeShares: snipe.shares,
                sizeUsd: snipe.shares * data.price,
                orderType: 'FAK'
            });
            this.activeSnipes.delete(data.tokenId);
        }
    }
}
