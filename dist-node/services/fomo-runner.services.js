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
        if (!this.isEnabled || this.activeSnipes.has(event.tokenId))
            return;
        if (event.velocity < 0.05)
            return;
        try {
            const metrics = await this.adapter.getLiquidityMetrics?.(event.tokenId, 'BUY');
            if (metrics && metrics.availableDepthUsd < this.LIQUIDITY_FLOOR)
                return;
            const slippagePrice = Math.min(0.99, event.newPrice * 1.01);
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
                    currentPrice: result.priceFilled
                });
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
        }
        catch (e) { }
    }
    /**
     * Hard Stop-Loss: Monitors the global WebSocket for price reversals
     */
    async handlePriceUpdate(data) {
        const snipe = this.activeSnipes.get(data.tokenId);
        if (!snipe)
            return;
        // Update current price for UI tracking
        snipe.currentPrice = data.price;
        const currentDrop = (snipe.entryPrice - data.price) / snipe.entryPrice;
        // Exit if position loses 10% of its entry value
        if (currentDrop >= this.STOP_LOSS_PCT) {
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
