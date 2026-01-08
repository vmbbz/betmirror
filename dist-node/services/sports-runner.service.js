import { SportsMatch as DbSportsMatch } from '../database/index.js';
import axios from 'axios';
export class SportsRunnerService {
    adapter;
    intel;
    executor;
    logger;
    activeChases = new Map();
    monitorInterval;
    constructor(adapter, intel, executor, logger) {
        this.adapter = adapter;
        this.intel = intel;
        this.executor = executor;
        this.logger = logger;
        this.setupEvents();
        this.startExitMonitor();
    }
    setupEvents() {
        this.intel.on('goal', (match) => this.handleGoalArb(match));
        this.intel.on('var', (match) => this.handleVAR(match));
    }
    /**
     * Monitor loop to evaluate exit conditions for "In-Flight" frontruns
     */
    startExitMonitor() {
        this.monitorInterval = setInterval(() => this.evaluateExits(), 5000);
    }
    async evaluateExits() {
        if (this.activeChases.size === 0)
            return;
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
                }
                else {
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
            }
            catch (e) {
                this.logger.debug(`Exit Monitor Error for ${chase.matchKey}`);
            }
        }
    }
    async liquidateScalp(key, exitPrice, reason) {
        const chase = this.activeChases.get(key);
        if (!chase)
            return;
        try {
            this.logger.info(`🔄 [SCALP EXIT] Liquidating ${chase.shares} shares of ${chase.matchKey} via FAK...`);
            const result = await this.executor.getAdapter().createOrder({
                marketId: chase.conditionId,
                tokenId: chase.tokenId,
                outcome: 'YES',
                side: 'SELL',
                sizeUsd: 0,
                sizeShares: chase.shares,
                priceLimit: 0.01,
                orderType: 'FAK'
            });
            if (result.success) {
                const realizedPnl = (exitPrice - chase.entryPrice) * chase.shares;
                this.logger.success(`💰 [SCALP COMPLETE] ${chase.matchKey} | PnL: $${realizedPnl.toFixed(2)} | Reason: ${reason}`);
                this.activeChases.delete(key);
            }
        }
        catch (e) {
            this.logger.error(`Liquidation failed for ${chase.matchKey}`, e instanceof Error ? e : new Error(String(e)));
        }
    }
    /**
     * Core Arbitrage Logic for Goals
     */
    async handleGoalArb(match) {
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        if (this.activeChases.has(matchKey))
            return;
        this.logger.info(`🎯 Evaluating Frontrunning Edge for ${matchKey}...`);
        try {
            const conditionId = await this.findPolymarketCondition(match);
            if (!conditionId)
                return;
            const market = await this.adapter.getRawClient().getMarket(conditionId);
            const targetToken = market.clobTokenIds[0];
            const fairValue = this.calculateFairValue(match.score, match.minute);
            const marketPrice = await this.adapter.getMarketPrice(conditionId, targetToken, 'BUY');
            const edge = fairValue - marketPrice;
            // World-Class Alpha Check: Minimum 12 cent edge required for taker fees & slippage
            if (edge >= 0.12) {
                this.logger.success(`🚀 [ALPHA WINDOW] Frontrunning Goal for ${matchKey}! Edge: ${edge.toFixed(2)} | Fair: ${fairValue.toFixed(2)}`);
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
                        targetPrice: fairValue * 0.98,
                        startTime: Date.now(),
                        lastBid: marketPrice,
                        stallTicks: 0,
                        shares: execution.sharesFilled,
                        matchKey
                    });
                    this.logger.info(`📈 [TRACKING] Scalp monitor active for ${matchKey}. Target: $${(fairValue * 0.98).toFixed(2)}`);
                }
            }
        }
        catch (e) {
            this.logger.error(`Sports Arb Failure`, e instanceof Error ? e : new Error(String(e)));
        }
    }
    handleVAR(match) {
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        if (this.activeChases.has(matchKey)) {
            this.logger.warn(`🚨 [VAR EMERGENCY] Review in progress for ${matchKey}. DUMPING POSITION.`);
            this.liquidateScalp(matchKey, 0, "VAR Panic").catch(() => { });
        }
    }
    async findPolymarketCondition(match) {
        const cached = await DbSportsMatch.findOne({ matchId: match.id });
        if (cached)
            return cached.conditionId;
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
        }
        catch (e) { }
        return null;
    }
    /**
     * WORLD-CLASS FAIR VALUE ENGINE
     * Implements a Dynamic Power-Curve Decay model for Soccer.
     * P(win) = Base + (1 - Base) * (t^Decay)
     */
    calculateFairValue(score, minute) {
        const [h, a] = score;
        const absoluteDiff = Math.abs(h - a);
        // Normalize time to a 0.0 -> 1.0 scale (Cap at 95m for injury time)
        const timeFactor = Math.min(minute / 95, 0.99);
        // Case 1: One side is leading
        if (absoluteDiff > 0) {
            // A 1-goal lead starts at 65% win probability (industry standard)
            // A 2-goal lead starts at 88% win probability
            const baseProb = absoluteDiff === 1 ? 0.65 : 0.88;
            // Power Factor (2.5) ensures the probability accelerates 
            // exponentially as the match enters the 'Kill Zone' (70m+)
            const decaySensitivity = 2.5;
            const fairValue = baseProb + (1 - baseProb) * Math.pow(timeFactor, decaySensitivity);
            return Math.min(fairValue, 0.99);
        }
        // Case 2: Match is a Draw
        if (absoluteDiff === 0) {
            // Draws start at 33% (1/3rd) and climb to 100% at the whistle
            const baseDraw = 0.33;
            const drawFairValue = baseDraw + (1 - baseDraw) * Math.pow(timeFactor, 3.0);
            return Math.min(drawFairValue, 0.99);
        }
        return 0.5;
    }
}
