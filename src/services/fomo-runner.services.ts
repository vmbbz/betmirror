import { EventEmitter } from 'events';
import { TradeExecutorService } from './trade-executor.service.js';
import { MarketIntelligenceService, FlashMoveEvent } from './market-intelligence.service.js';
import { Logger } from '../utils/logger.util.js';
import { IExchangeAdapter } from '../adapters/interfaces.js';

interface ActiveSnipe {
    tokenId: string;
    conditionId: string;
    entryPrice: number;
    shares: number;
    timestamp: number;
}

/**
 * FomoRunnerService
 * Autonomous momentum sniper with liquidity guard and safety stop-loss.
 */
export class FomoRunnerService extends EventEmitter {
    private isEnabled = false;
    private autoTpPercent = 0.20; 
    private activeSnipes: Map<string, ActiveSnipe> = new Map();
    
    // Constraints for Pro Performance
    private readonly LIQUIDITY_FLOOR = 1000; // $1,000 min depth to avoid slippage traps
    private readonly STOP_LOSS_PCT = 0.10;   // 10% hard exit to protect capital

    constructor(
        private intelligence: MarketIntelligenceService,
        private executor: TradeExecutorService,
        private adapter: IExchangeAdapter,
        private logger: Logger
    ) {
        super();
        this.intelligence.on('flash_move', (event: FlashMoveEvent) => this.handleFlashMove(event));
        this.intelligence.on('price_update', (data: { tokenId: string, price: number }) => this.handlePriceUpdate(data));
    }

    public setConfig(enabled: boolean, tpPercent: number) {
        this.isEnabled = enabled;
        this.autoTpPercent = tpPercent;
        if (!enabled) this.activeSnipes.clear();
    }

    /**
     * Entry Logic with Liquidity Guard
     */
    private async handleFlashMove(event: FlashMoveEvent) {
        if (!this.isEnabled) return;
        if (this.activeSnipes.has(event.tokenId)) return;

        // 1. Direction Filter: Only chase upward velocity
        if (event.velocity < 0.05) return; 

        // 2. Liquidity Guard: Check depth before committing capital
        try {
            const metrics = await this.adapter.getLiquidityMetrics?.(event.tokenId, 'BUY');
            const liquidity = metrics?.availableDepthUsd || 0;

            if (liquidity < this.LIQUIDITY_FLOOR) {
                this.logger.warn(`🛡️ [FOMO] Snipe Aborted: ${event.tokenId.slice(0,8)} depth ($${liquidity.toFixed(0)}) below safety floor.`);
                return;
            }
        } catch (e) {
            this.logger.debug("Liquidity check bypassed due to RPC timeout");
        }

        this.logger.success(`🚀 [FOMO] Sniper Triggered: ${event.tokenId.slice(0,8)} (+${(event.velocity * 100).toFixed(1)}%). Executing...`);

        try {
            // Calculate a tight entry window (1% slippage cap)
            const slippagePrice = Math.min(0.99, event.newPrice * 1.01);
            
            const result = await this.executor.createOrder({
                marketId: event.conditionId,
                tokenId: event.tokenId,
                outcome: 'YES',
                side: 'BUY',
                sizeUsd: 50, // Standard test size for flash entries
                orderType: 'FOK',
                priceLimit: slippagePrice
            });

            if (result.success && result.sharesFilled > 0) {
                this.activeSnipes.set(event.tokenId, {
                    tokenId: event.tokenId,
                    conditionId: event.conditionId,
                    entryPrice: result.priceFilled,
                    shares: result.sharesFilled,
                    timestamp: Date.now()
                });

                // Immediate Take-Profit Chain: Post a GTC sell limit order instantly
                const tpPrice = Math.min(0.99, result.priceFilled * (1 + this.autoTpPercent));
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

                this.emit('fomo_trade_filled', { ...result, serviceOrigin: 'FOMO', marketId: event.conditionId });
            }
        } catch (e: any) {
            this.logger.error(`❌ [FOMO] Entry failed: ${e.message}`);
        }
    }

    /**
     * Hard Stop-Loss: Monitors the global WebSocket for price reversals
     */
    private async handlePriceUpdate(data: { tokenId: string, price: number }) {
        const snipe = this.activeSnipes.get(data.tokenId);
        if (!snipe) return;

        const currentDrop = (snipe.entryPrice - data.price) / snipe.entryPrice;

        // Exit if position loses 10% of its entry value
        if (currentDrop >= this.STOP_LOSS_PCT) {
            this.logger.error(`🚨 [FOMO] Stop-Loss Hit! Reversal of ${(currentDrop * 100).toFixed(1)}% detected on ${data.tokenId.slice(0,8)}...`);
            
            try {
                // Cancel the resting TP order first
                await this.executor.cancelExistingQuotes(data.tokenId);
                
                // Market sell to exit the position immediately
                const result = await this.executor.createOrder({
                    marketId: snipe.conditionId,
                    tokenId: snipe.tokenId,
                    outcome: 'YES',
                    side: 'SELL',
                    sizeShares: snipe.shares,
                    sizeUsd: snipe.shares * data.price,
                    orderType: 'FAK' 
                });

                if (result.success) {
                    this.logger.success(`🛡️ [FOMO] Emergency exit confirmed. Portfolio protected.`);
                    this.activeSnipes.delete(data.tokenId);
                }
            } catch (e: any) {
                this.logger.error(`❌ [FOMO] Emergency exit failed: ${e.message}`);
            }
        }
    }
}
