
import { EventEmitter } from 'events';
import { TradeExecutorService } from './trade-executor.service.js';
import { MarketIntelligenceService, FlashMoveEvent } from './market-intelligence.service.js';
import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';

export interface ActiveSnipe {
    tokenId: string;
    conditionId: string;
    entryPrice: number;
    shares: number;
    timestamp: number;
    question?: string;
    targetPrice?: number;
    currentPrice?: number;
}

export class FomoRunnerService extends EventEmitter {
    private isEnabled = false;
    private autoTpPercent = 0.20; 
    private activeSnipes: Map<string, ActiveSnipe> = new Map();
    
    private readonly LIQUIDITY_FLOOR = 1000;
    private readonly STOP_LOSS_PCT = 0.10;

    constructor(
        private intelligence: MarketIntelligenceService,
        private executor: TradeExecutorService,
        private adapter: IExchangeAdapter,
        private logger: Logger
    ) {
        super();
        this.intelligence.on('flash_move', (e) => this.handleFlashMove(e));
        // FIX: Listener now matches the correctly emitted event name from Intelligence service
        this.intelligence.on('price_update', (d) => this.handlePriceUpdate(d));
    }

    public setConfig(enabled: boolean, tpPercent: number) {
        this.isEnabled = enabled;
        this.autoTpPercent = tpPercent;
        if (!enabled) this.activeSnipes.clear();
        this.logger.info(`🚀 [FOMO] Engine ${enabled ? 'ONLINE' : 'OFFLINE'} | TP: ${tpPercent * 100}%`);
    }

    public getActiveSnipes(): ActiveSnipe[] {
        return Array.from(this.activeSnipes.values());
    }

    private async handleFlashMove(event: FlashMoveEvent) {
        if (!this.isEnabled) {
            this.logger.debug(`[FOMO] Move detected on ${event.tokenId.slice(0,8)} but trader is disabled (Fund bot to activate)`);
            return;
        }

        if (this.activeSnipes.has(event.tokenId)) return;
        if (event.velocity < 0.05) return; 

        try {
            const metrics = await this.adapter.getLiquidityMetrics?.(event.tokenId, 'BUY');
            if (metrics && metrics.availableDepthUsd < this.LIQUIDITY_FLOOR) {
                this.logger.warn(`[FOMO] Skipping ${event.tokenId.slice(0,8)}: Low liquidity ($${metrics.availableDepthUsd.toFixed(0)})`);
                return;
            }

            const slippagePrice = Math.min(0.99, event.newPrice * 1.01);
            
            this.logger.info(`[FOMO] Attempting SNIPE Entry on ${event.question || event.tokenId.slice(0,8)} @ $${event.newPrice}`);

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
            } else {
                this.logger.warn(`[FOMO] Snipe entry FAILED or FOK expired: ${result.error || 'No liquidity at target price'}`);
            }
        } catch (e: any) {
            this.logger.error(`[FOMO] Error processing flash move: ${e.message}`);
        }
    }

    private async handlePriceUpdate(data: { tokenId: string, price: number }) {
        const snipe = this.activeSnipes.get(data.tokenId);
        if (!snipe) return;

        // Update current price for UI tracking
        snipe.currentPrice = data.price;

        const currentDrop = (snipe.entryPrice - data.price) / snipe.entryPrice;

        // Exit if position loses 10% of its entry value (Hard Stop Loss)
        if (currentDrop >= this.STOP_LOSS_PCT) {
            this.logger.error(`🚨 [FOMO] STOP LOSS TRIGGERED for ${snipe.tokenId.slice(0,8)}. Reversing position...`);
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
