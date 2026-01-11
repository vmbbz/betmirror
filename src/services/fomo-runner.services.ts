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
        this.intelligence.on('price_update', async (data: { tokenId: string, price: number }) => {
            try {
                await this.handlePriceUpdate(data);
            } catch (e: any) {
                this.logger.error(`❌ [FOMO] Error in price update handler: ${e.message}`);
                this.emit('error', {
                    type: 'price_update_error',
                    tokenId: data.tokenId,
                    error: e.message,
                    timestamp: Date.now()
                });
            }
        });
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

        // Emit flash move detection
        this.emit('flash_move_detected', {
            tokenId: event.tokenId,
            conditionId: event.conditionId,
            velocity: event.velocity,
            price: event.newPrice,
            timestamp: Date.now()
        });

        // 1. Direction Filter: Only chase upward velocity
        if (event.velocity < 0.05) return; 

        // 2. Liquidity Guard: Check depth before committing capital
        try {
            const metrics = await this.adapter.getLiquidityMetrics?.(event.tokenId, 'BUY');
            const liquidity = metrics?.availableDepthUsd || 0;

            if (liquidity < this.LIQUIDITY_FLOOR) {
                const message = `🛡️ [FOMO] Snipe Aborted: ${event.tokenId.slice(0,8)} depth ($${liquidity.toFixed(0)}) below safety floor.`;
                this.logger.warn(message);
                this.emit('snipe_aborted', {
                    tokenId: event.tokenId,
                    reason: 'insufficient_liquidity',
                    liquidity,
                    message,
                    timestamp: Date.now()
                });
                return;
            }
        } catch (e) {
            const message = "Liquidity check bypassed due to RPC timeout";
            this.logger.debug(message);
            this.emit('snipe_aborted', {
                tokenId: event.tokenId,
                reason: 'rpc_timeout',
                message,
                timestamp: Date.now()
            });
        }

        this.logger.success(`🚀 [FOMO] Sniper Triggered: ${event.tokenId.slice(0,8)} (+${(event.velocity * 100).toFixed(1)}%). Executing...`);

        try {
            // Calculate a tight entry window (1% slippage cap)
            const slippagePrice = Math.min(0.99, event.newPrice * 1.01);
            
            const snipeAttempt = {
                tokenId: event.tokenId,
                conditionId: event.conditionId,
                direction: 'BUY',
                sizeUsd: 50,
                targetPrice: event.newPrice,
                maxSlippage: 0.01,
            };
            
            this.emit('snipe_attempt', snipeAttempt);
            
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
                const entry = {
                    tokenId: event.tokenId,
                    conditionId: event.conditionId,
                    entryPrice: result.priceFilled,
                    shares: result.sharesFilled,
                    timestamp: Date.now(),
                    positionValue: result.priceFilled * result.sharesFilled,
                    orderId: result.orderId
                };
                
                this.activeSnipes.set(event.tokenId, entry);
                
                this.emit('snipe_entered', {
                    ...entry,
                    orderDetails: result
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
    private async triggerStopLoss(snipe: ActiveSnipe) {
        const stopLossPrice = snipe.entryPrice * (1 - this.STOP_LOSS_PCT);
        this.logger.warn(`🛑 [FOMO] Stop-Loss Triggered for ${snipe.tokenId.slice(0,8)} at ${stopLossPrice.toFixed(4)}`);
        
        try {
            const result = await this.executor.createOrder({
                marketId: snipe.conditionId,
                tokenId: snipe.tokenId,
                outcome: 'YES',
                side: 'SELL',
                sizeShares: snipe.shares,
                sizeUsd: snipe.shares * 1.0, // Convert shares to USD (assuming 1:1 for simplicity)
                orderType: 'FAK',
                priceLimit: 0.01 // Emergency exit price
            });
            
            if (result.success) {
                this.emit('stop_loss_triggered', {
                    tokenId: snipe.tokenId,
                    conditionId: snipe.conditionId,
                    entryPrice: snipe.entryPrice,
                    exitPrice: result.priceFilled || stopLossPrice,
                    pnl: result.priceFilled ? ((result.priceFilled / snipe.entryPrice - 1) * 100) : -this.STOP_LOSS_PCT * 100,
                    shares: snipe.shares,
                    timestamp: Date.now(),
                    orderDetails: result
                });
            }
            
            this.activeSnipes.delete(snipe.tokenId);
        } catch (e: any) {
            this.logger.error(`❌ [FOMO] Stop-loss execution failed: ${e.message}`);
            this.emit('error', {
                type: 'stop_loss_failed',
                tokenId: snipe.tokenId,
                error: e.message,
                timestamp: Date.now()
            });
        }
    }

    private async handlePriceUpdate(data: { tokenId: string, price: number }) {
        const snipe = this.activeSnipes.get(data.tokenId);
        if (!snipe) return;

        // Emit price update for active position
        this.emit('position_update', {
            tokenId: data.tokenId,
            price: data.price,
            entryPrice: snipe.entryPrice,
            pnl: (data.price / snipe.entryPrice - 1) * 100,
            timestamp: Date.now()
        });

        // Hard Stop-Loss Check
        const currentLoss = (snipe.entryPrice - data.price) / snipe.entryPrice;
        if (currentLoss >= this.STOP_LOSS_PCT) {
            await this.triggerStopLoss(snipe);
            return;
        }
    }
}
