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
        // Core frontrunning event: detect goal before Polymarket adjusts
        this.intel.on('goal', (match) => this.handleGoalArb(match));
        // Safety event: if goal is reviewed by VAR, dump position immediately
        this.intel.on('var', (match) => this.handleVAR(match));
    }
    /**
     * Autonomous Monitor: Evaluates exit conditions for "In-Flight" frontruns
     */
    startExitMonitor() {
        this.monitorInterval = setInterval(() => this.evaluateExits(), 5000);
    }
    async evaluateExits() {
        if (this.activeChases.size === 0)
            return;
        for (const [key, chase] of this.activeChases.entries()) {
            try {
                // Get real-time price we can sell at
                const currentBid = await this.adapter.getMarketPrice(chase.conditionId, chase.tokenId, 'SELL');
                const elapsed = (Date.now() - chase.startTime) / 1000;
                // Condition 1: Target Price Reached
                if (currentBid >= chase.targetPrice) {
                    this.logger.success(`🎯 [TARGET REACHED] Alpha captured for ${chase.matchKey} @ $${currentBid}`);
                    await this.liquidateScalp(key, currentBid, "Target Reached");
                    continue;
                }
                // Condition 2: Alpha Decay (Momentum Stall)
                // If price hasn't moved up in 3 consecutive checks (15s) and we're past initial burst
                if (currentBid <= chase.lastBid) {
                    chase.stallTicks++;
                }
                else {
                    chase.stallTicks = 0;
                }
                chase.lastBid = currentBid;
                if (chase.stallTicks >= 3 && elapsed > 30) {
                    this.logger.warn(`📉 [MOMENTUM STALL] Stale price window closed for ${chase.matchKey}. Exiting...`);
                    await this.liquidateScalp(key, currentBid, "Alpha Decay");
                    continue;
                }
                // Condition 3: Hard Time Stop (120s)
                if (elapsed >= 120) {
                    this.logger.info(`⏰ [TIME STOP] Exiting ${chase.matchKey} scalp - time limit reached.`);
                    await this.liquidateScalp(key, currentBid, "Time Limit");
                    continue;
                }
            }
            catch (e) {
                this.logger.debug(`Exit Monitor: ${chase.matchKey} price fetch failed.`);
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
                priceLimit: 0.01, // Sweep down the book to ensure exit
                orderType: 'FAK'
            });
            if (result.success) {
                const pnl = (exitPrice - chase.entryPrice) * chase.shares;
                this.logger.success(`💰 [SCALP COMPLETE] ${chase.matchKey} | PnL: $${pnl.toFixed(2)} | Reason: ${reason}`);
                this.activeChases.delete(key);
            }
        }
        catch (e) {
            this.logger.error(`Liquidation Error: ${chase.matchKey}`, e instanceof Error ? e : new Error(String(e)));
        }
    }
    /**
     * Core Logic: Frontruns goal notifications using stale market prices
     */
    async handleGoalArb(match) {
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        if (this.activeChases.has(matchKey))
            return;
        try {
            // 1. Map Sportmonks Fixture to Polymarket Condition
            const conditionId = await this.findPolymarketCondition(match);
            if (!conditionId) {
                this.logger.warn(`❌ No mapping found for ${matchKey}`);
                return;
            }
            // 2. Identify target token (The team that just scored)
            const market = await this.adapter.getRawClient().getMarket(conditionId);
            const targetToken = market.clobTokenIds[0]; // Assuming binary Winner Take All
            // 3. Calculate Edge
            const fairValue = this.calculateFairValue(match.score, match.minute);
            const marketPrice = await this.adapter.getMarketPrice(conditionId, targetToken, 'BUY');
            const edge = fairValue - marketPrice;
            if (edge >= 0.15) {
                this.logger.success(`🚀 [ALPHA WINDOW] Frontrunning Goal for ${matchKey}! Edge: ${edge.toFixed(2)}`);
                // Execute FOK: Only buy if the stale price still exists
                const execution = await this.executor.createOrder({
                    marketId: conditionId,
                    tokenId: targetToken,
                    outcome: 'YES',
                    side: 'BUY',
                    sizeUsd: 100, // Default institutional chase size
                    orderType: 'FOK'
                });
                if (execution.success && execution.sharesFilled > 0) {
                    this.activeChases.set(matchKey, {
                        matchId: match.id,
                        conditionId,
                        tokenId: targetToken,
                        entryPrice: execution.priceFilled,
                        targetPrice: fairValue * 0.98, // Take profit slightly before market equilibrium
                        startTime: Date.now(),
                        lastBid: marketPrice,
                        stallTicks: 0,
                        shares: execution.sharesFilled,
                        matchKey
                    });
                }
            }
        }
        catch (e) {
            this.logger.error(`Goal Arb Failure`, e instanceof Error ? e : new Error(String(e)));
        }
    }
    handleVAR(match) {
        const matchKey = `${match.homeTeam}-${match.awayTeam}`;
        if (this.activeChases.has(matchKey)) {
            this.logger.warn(`🚨 [VAR EMERGENCY] Review detected for ${matchKey}. Aborting scalp...`);
            this.liquidateScalp(matchKey, 0, "VAR Intervention").catch(() => { });
        }
    }
    /**
     * Institutional Match Mapping Logic
     */
    async findPolymarketCondition(match) {
        // 1. Check local DB cache first
        const cached = await DbSportsMatch.findOne({ matchId: match.id });
        if (cached)
            return cached.conditionId;
        // 2. Query Polymarket Gamma API for the match
        try {
            const query = encodeURIComponent(`${match.homeTeam} ${match.awayTeam}`);
            this.logger.info(`🔍 Searching Polymarket for: ${match.homeTeam} vs ${match.awayTeam}`);
            const res = await axios.get(`https://gamma-api.polymarket.com/markets?active=true&closed=false&q=${query}`);
            if (res.data && res.data.length > 0) {
                const bestMatch = res.data[0];
                this.logger.success(`🎯 Found mapping: ${bestMatch.question} (${bestMatch.conditionId})`);
                // Cache it
                await DbSportsMatch.create({
                    matchId: match.id,
                    conditionId: bestMatch.conditionId,
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam
                });
                return bestMatch.conditionId;
            }
        }
        catch (e) {
            this.logger.debug("Gamma search failed");
        }
        return null;
    }
    calculateFairValue(score, minute) {
        // High-speed soccer estimation model
        const [h, a] = score;
        if (Math.abs(h - a) >= 2)
            return 0.95; // Blowout
        if (h > a || a > h)
            return 0.78; // Lead
        return 0.45; // Draw
    }
}
