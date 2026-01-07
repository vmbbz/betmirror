
import { IExchangeAdapter } from '../adapters/interfaces.js';
import { Logger } from '../utils/logger.util.js';
import { SportsIntelService, SportsMatch } from './sports-intel.service.js';
import { TradeExecutorService } from './trade-executor.service.js';
import { SportsMatch as DbSportsMatch, Trade as DbTrade } from '../database/index.js';
import axios from 'axios';
import crypto from 'crypto';

interface ActiveChase {
    matchId: string;
    conditionId: string;
    tokenId: string;
    entryPrice: number;
    targetPrice: number;
    startTime: number;
    lastBid: number;
    stallTicks: number;
    shares: number;
    matchKey: string;
}

export class SportsRunnerService {
    private activeChases: Map<string, ActiveChase> = new Map();
    private monitorInterval?: NodeJS.Timeout;

    constructor(
        private adapter: IExchangeAdapter,
        private intel: SportsIntelService,
        private executor: TradeExecutorService,
        private logger: Logger
    ) {
        this.setupEvents();
        this.startExitMonitor();
    }

    private setupEvents() {
        this.intel.on('goal', (match: SportsMatch) => this.handleGoalArb(match));
        this.intel.on('var', (match: SportsMatch) => this.handleVAR(match));
    }

    /**
     * Monitor loop to evaluate exit conditions for "In-Flight" frontruns
     */
    private startExitMonitor() {
        this.monitorInterval = setInterval(() => this.evaluateExits(), 5000);
    }

    private async evaluateExits() {
        if (this.activeChases.size === 0) return;

        for (const [key, chase] of this.activeChases.entries()) {
            try {
                const currentBid = await this.adapter.getMarketPrice(chase.conditionId, chase.tokenId, 'SELL');
                const elapsed = (Date.now() - chase.startTime) / 1000;

                // 1. Check for Target Hit
                if (currentBid >= chase.targetPrice) {
                    this.logger.success(`🎯 [TARGET REACHED] Exit target hit for ${chase.matchKey} @ $${currentBid}`);
                    await this.liquidateScalp(key, currentBid, "Target Hit");
                    continue;
                }

                // 2. Check for Momentum Stall
                if (currentBid <= chase.lastBid) {
                    chase.stallTicks++;
                } else {
                    chase.stallTicks = 0;
                }
                chase.lastBid = currentBid;

                if (chase.stallTicks >= 3 && elapsed > 30) {
                    this.logger.warn(`📉 [MOMENTUM STALL] Alpha decay detected for ${chase.matchKey}. Exiting...`);
                    await this.liquidateScalp(key, currentBid, "Momentum Stall");
                    continue;
                }

                // 3. Hard Time Stop (120s)
                if (elapsed >= 120) {
                    this.logger.info(`⏰ [TIME STOP] 120s limit reached for ${chase.matchKey}. Closing scalp.`);
                    await this.liquidateScalp(key, currentBid, "Time Stop");
                    continue;
                }

            } catch (e) {
                this.logger.error(`Exit Monitor Error for ${chase.matchKey}`, e instanceof Error ? e : new Error(String(e)));
            }
        }
    }

    private async liquidateScalp(key: string, exitPrice: number, reason: string) {
        const chase = this.activeChases.get(key);
        if (!chase) return;

        try {
            this.logger.info(`🔄 [SCALP EXIT] Liquidating ${chase.shares} shares of ${chase.matchKey} via FAK...`);
            
            const result = await this.executor.getAdapter().createOrder({
                marketId: chase.conditionId,
                tokenId: chase.tokenId,
                outcome: 'YES',
                side: 'SELL',
                sizeUsd: 0,
                sizeShares: chase.shares,
                priceLimit: 0.01, // Sweep down to book floor to ensure exit
                orderType: 'FAK'
            });

            if (result.success) {
                const realizedPnl = (exitPrice - chase.entryPrice) * chase.shares;
                this.logger.success(`💰 [SCALP COMPLETE] ${chase.matchKey} | PnL: $${realizedPnl.toFixed(2)} | Reason: ${reason}`);
                this.activeChases.delete(key);
            }
        } catch (e) {
            this.logger.error(`Liquidation failed for ${chase.matchKey}`, e instanceof Error ? e : new Error(String(e)));
        }
    }

    /**
     * Core Arbitrage Logic for Goals
     */
    private async handleGoalArb(match: SportsMatch) {
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        if (this.activeChases.has(matchKey)) return;

        this.logger.info(`🎯 Evaluating Frontrunning Edge for ${matchKey}...`);

        try {
            const conditionId = await this.findConditionId(match);
            if (!conditionId) {
                this.logger.warn(`❌ No Polymarket mapping found for ${matchKey}`);
                return;
            }

            const market = await (this.adapter as any).getRawClient().getMarket(conditionId);
            const targetToken = market.clobTokenIds[0]; 
            const scoringTeamSide = match.score[0] > match.score[1] ? 'HOME' : 'AWAY';
            const fairValue = this.calculateFairValue(match.score, match.minute, scoringTeamSide);
            const marketPrice = await this.adapter.getMarketPrice(conditionId, targetToken, 'BUY');

            const edge = fairValue - marketPrice;
            
            if (edge >= 0.15) {
                this.logger.success(`🚀 [ALPHA WINDOW] Frontrunning Goal for ${matchKey}!`);
                
                const execution = await this.executor.createOrder({
                    marketId: conditionId,
                    tokenId: targetToken,
                    outcome: 'YES',
                    side: 'BUY',
                    sizeUsd: 100, 
                    orderType: 'FOK' 
                });

                if (execution.success && execution.sharesFilled > 0) {
                    // Register for Scalp Monitor
                    this.activeChases.set(matchKey, {
                        matchId: match.id,
                        conditionId,
                        tokenId: targetToken,
                        entryPrice: execution.priceFilled,
                        targetPrice: fairValue * 0.98, // Exit slightly before theoretical fair
                        startTime: Date.now(),
                        lastBid: marketPrice,
                        stallTicks: 0,
                        shares: execution.sharesFilled,
                        matchKey
                    });
                    
                    this.logger.info(`📈 [TRACKING] Scalp monitor active for ${matchKey}. Target: $${(fairValue * 0.98).toFixed(2)}`);
                }
            }

        } catch (e) {
            this.logger.error(`Sports Arb Failure`, e instanceof Error ? e : new Error(String(e)));
        }
    }

    private handleVAR(match: SportsMatch) {
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        if (this.activeChases.has(matchKey)) {
            this.logger.warn(`🚨 [VAR PANIC] ${matchKey} Goal under review. Triggering Emergency Exit...`);
            this.liquidateScalp(matchKey, 0, "VAR Panic").catch(() => {});
        }
    }

    private async findConditionId(match: SportsMatch): Promise<string | null> {
        const dbMapping = await DbSportsMatch.findOne({ matchId: match.id });
        if (dbMapping) return dbMapping.conditionId;

        try {
            const query = encodeURIComponent(`${match.homeTeam} ${match.awayTeam}`);
            const res = await axios.get(`https://gamma-api.polymarket.com/markets?active=true&closed=false&q=${query}`);
            if (res.data && res.data.length > 0) {
                const bestMatch = res.data[0];
                await DbSportsMatch.create({
                    matchId: match.id,
                    conditionId: bestMatch.conditionId,
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    league: match.league
                });
                return bestMatch.conditionId;
            }
        } catch (e) {}
        return null;
    }

    private calculateFairValue(score: [number, number], minute: number, side: string): number {
        const [h, a] = score;
        if (h > a) return 0.78; 
        if (h === a) return 0.45; 
        return 0.15;
    }
}
