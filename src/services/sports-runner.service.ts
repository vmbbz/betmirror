
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { SportsIntelService, SportsMatch } from './sports-intel.service.js';
import { TradeExecutorService } from './trade-executor.service.js';

interface ActiveScalp {
    matchKey: string;
    conditionId: string;
    tokenId: string;
    entryPrice: number;
    targetPrice: number;
    startTime: number;
    lastBid: number;
    stallTicks: number;
    shares: number;
}

export class SportsRunnerService {
    private activeScalps: Map<string, ActiveScalp> = new Map();
    private monitorInterval?: NodeJS.Timeout;

    constructor(
        private adapter: IExchangeAdapter,
        private intel: SportsIntelService,
        private executor: TradeExecutorService,
        private logger: Logger
    ) {
        this.setupEvents();
        this.monitorInterval = setInterval(() => this.evaluateScalpExits(), 5000);
    }

    private setupEvents() {
        this.intel.on('inferredEvent', (data) => this.handleSpikeEntry(data));
    }

    private async handleSpikeEntry(data: { match: SportsMatch, type: string, magnitude: number }) {
        const { match } = data;
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        
        if (this.activeScalps.has(matchKey) || match.confidence < 0.6) return;

        const edge = match.fairValue - (match.marketPrice || 0);
        
        if (edge < 0.12) {
            this.logger.info(`🛡️ Edge too thin ($${edge.toFixed(2)}). Awaiting Alpha Expansion.`);
            return;
        }

        this.logger.success(`🎯 [ALPHA WINDOW] Frontrunning Edge detected: $${edge.toFixed(2)}. Sweeping stale book for ${match.homeTeam}...`);

        try {
            const result = await this.executor.createOrder({
                marketId: match.conditionId,
                tokenId: match.tokenId!,
                outcome: 'YES',
                side: 'BUY',
                sizeUsd: 100, 
                orderType: 'FOK'
            });

            if (result.success && result.sharesFilled > 0) {
                this.activeScalps.set(matchKey, {
                    matchKey,
                    conditionId: match.conditionId,
                    tokenId: match.tokenId!,
                    entryPrice: result.priceFilled,
                    targetPrice: match.fairValue * 0.98,
                    startTime: Date.now(),
                    lastBid: result.priceFilled,
                    stallTicks: 0,
                    shares: result.sharesFilled
                });
                this.logger.info(`📈 [CAPTURE] Position active. Target: $${(match.fairValue * 0.98).toFixed(2)}`);
            }
        } catch (e: any) {
            this.logger.error(`Arb entry failed: ${e.message}`);
        }
    }

    private async evaluateScalpExits() {
        if (this.activeScalps.size === 0) return;

        for (const [key, scalp] of this.activeScalps.entries()) {
            try {
                const currentBid = await this.adapter.getMarketPrice(scalp.conditionId, scalp.tokenId, 'SELL');
                const elapsed = (Date.now() - scalp.startTime) / 1000;

                if (currentBid >= scalp.targetPrice) {
                    await this.liquidate(key, currentBid, "Target Reached");
                    continue;
                }

                if (currentBid <= scalp.lastBid) scalp.stallTicks++;
                else scalp.stallTicks = 0;
                scalp.lastBid = currentBid;

                if (scalp.stallTicks >= 3 && elapsed > 30) {
                    await this.liquidate(key, currentBid, "Momentum Stall");
                    continue;
                }

                if (elapsed >= 120) {
                    await this.liquidate(key, currentBid, "Time Stop");
                    continue;
                }
            } catch (e) {}
        }
    }

    private async liquidate(key: string, exitPrice: number, reason: string) {
        const scalp = this.activeScalps.get(key);
        if (!scalp) return;

        this.logger.info(`🔄 [EXIT] ${reason} for ${scalp.matchKey}. Liquidating via FAK...`);
        
        try {
            const result = await this.adapter.createOrder({
                marketId: scalp.conditionId,
                tokenId: scalp.tokenId,
                outcome: 'YES',
                side: 'SELL',
                sizeUsd: 0,
                sizeShares: scalp.shares,
                orderType: 'FAK'
            });

            if (result.success) {
                const pnl = (exitPrice - scalp.entryPrice) * scalp.shares;
                this.logger.success(`💰 [COMPLETE] PnL: $${pnl.toFixed(2)} | Reason: ${reason}`);
                this.activeScalps.delete(key);
            }
        } catch (e: any) {
            this.logger.error(`Liquidation failed: ${e.message}`);
        }
    }
}
