
import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import EventEmitter from 'events';

export interface Team {
    id: number;
    name: string;
    league: string;
    abbreviation: string;
    alias?: string;
    logo?: string;
}

export interface MarketTriad {
    homeToken?: string;
    drawToken?: string;
    awayToken?: string;
    homePrice: number;
    drawPrice: number;
    awayPrice: number;
    prevHome: number;
    prevDraw: number;
    prevAway: number;
}

export interface SportsMatch {
    id: string; // eventId
    conditionId: string;
    homeTeam: string;
    awayTeam: string;
    marketSlug: string;
    eventSlug: string;
    score: [number, number]; 
    inferredScore: [number, number]; 
    minute: number;
    status: 'LIVE' | 'HT' | 'VAR' | 'FT' | 'SCOUTING' | 'PREMATCH';
    correlation: 'ALIGNED' | 'DIVERGENT' | 'UNVERIFIED';
    triad: MarketTriad;
    fairValue: number;
    discoveryEpoch: number;
    priceEvidence?: string;
    image: string;
    tokenId?: string; // Legacy compat for executor
    marketPrice?: number; // Legacy compat for executor
    confidence: number;
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export class SportsIntelService extends EventEmitter {
    private isPolling = false;
    private pollInterval?: NodeJS.Timeout;
    private discoveryInterval?: NodeJS.Timeout;
    private matches: Map<string, SportsMatch> = new Map();
    private teamsCache: Team[] = [];

    constructor(private logger: Logger) {
        super();
    }

    public isActive(): boolean { return this.isPolling; }

    public async start() {
        if (this.isPolling) return;
        this.isPolling = true;
        this.logger.info("⚽ Sports Intel: Pitch Intelligence Triad Online.");
        this.teamsCache = await this.fetchTeams();
        await this.discoverPolymarketSports();
        this.pollInterval = setInterval(() => this.runInference(), 3500);
        this.discoveryInterval = setInterval(() => this.discoverPolymarketSports(), 60000);
    }

    public stop() {
        this.isPolling = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    }

    private async fetchTeams(): Promise<Team[]> {
        try {
            const res = await axios.get(`${GAMMA_BASE}/teams?limit=500`);
            return res.data;
        } catch (e) { return []; }
    }

    private matchTeam(name: string): Team | null {
        if (!name) return null;
        const lower = name.toLowerCase().trim();
        return this.teamsCache.find(t => 
            t.name.toLowerCase() === lower || 
            t.alias?.toLowerCase() === lower ||
            t.abbreviation.toLowerCase() === lower
        ) || null;
    }

    private async discoverPolymarketSports() {
        try {
            // Tag 100639 = Soccer
            const url = `${GAMMA_BASE}/events?active=true&closed=false&tag_id=100639&order=startTime&ascending=true&limit=15`;
            const response = await axios.get(url);
            if (!response.data || !Array.isArray(response.data)) return;

            for (const event of response.data) {
                const market = event.markets?.[0];
                if (!market || !market.clobTokenIds) continue;

                // Triad Identification Logic
                const triad: MarketTriad = { 
                    homePrice: 0, drawPrice: 0, awayPrice: 0,
                    prevHome: 0, prevDraw: 0, prevAway: 0
                };
                const tokenIds = JSON.parse(market.clobTokenIds);
                
                // Typical Polymarket structure: [Home, Draw, Away]
                triad.homeToken = tokenIds[0];
                if (tokenIds.length === 3) {
                    triad.drawToken = tokenIds[1];
                    triad.awayToken = tokenIds[2];
                } else {
                    triad.awayToken = tokenIds[1];
                }

                const teams = event.title.split(/ vs | v | @ /i);
                const home = this.matchTeam(teams[0]?.trim());
                const away = this.matchTeam(teams[1]?.trim());

                const existing = this.matches.get(event.id);
                this.matches.set(event.id, {
                    id: event.id,
                    conditionId: market.conditionId,
                    homeTeam: home?.name || teams[0] || "Home",
                    awayTeam: away?.name || teams[1] || "Away",
                    marketSlug: market.market_slug || "",
                    eventSlug: event.slug || "",
                    image: event.image || market.image || "",
                    score: existing?.score || [0, 0],
                    inferredScore: existing?.inferredScore || [0, 0],
                    minute: existing?.minute || 0,
                    status: existing?.status || 'SCOUTING',
                    correlation: existing?.correlation || 'UNVERIFIED',
                    triad: existing?.triad || triad,
                    fairValue: existing?.fairValue || 0.5,
                    discoveryEpoch: existing?.discoveryEpoch || Date.now(),
                    tokenId: triad.homeToken, // for executor compat
                    confidence: existing?.confidence || 0.5,
                    marketPrice: existing?.marketPrice || 0
                });
            }
        } catch (e) {
            this.logger.error(`Discovery Error: ${e instanceof Error ? e.message : 'Unknown'}`);
        }
    }

    private async runInference() {
        for (const match of this.matches.values()) {
            if (!match.triad.homeToken) continue;

            try {
                // Poll the triad prices simultaneously
                const [hPrice, dPrice, aPrice] = await Promise.all([
                    this.getPrice(match.triad.homeToken),
                    match.triad.drawToken ? this.getPrice(match.triad.drawToken) : Promise.resolve(0),
                    match.triad.awayToken ? this.getPrice(match.triad.awayToken) : Promise.resolve(0)
                ]);

                // Calculate Velocity across Triad
                const hMove = match.triad.homePrice > 0 ? (hPrice - match.triad.homePrice) / match.triad.homePrice : 0;
                const aMove = match.triad.awayPrice > 0 ? (aPrice - match.triad.awayPrice) / match.triad.awayPrice : 0;

                // SCORE INFERENCE: CORRELATED DIVERGENCE
                // If Home Win jumps while Away Win drops, confidence of a goal is high
                if (hMove > 0.08 && aMove < -0.03) {
                    match.inferredScore[0]++;
                    match.correlation = 'DIVERGENT';
                    match.confidence = 0.92;
                    match.priceEvidence = `HOME GOAL: +${(hMove * 100).toFixed(1)}% Velocity | AWAY: ${(aMove * 100).toFixed(1)}%`;
                    this.emit('inferredEvent', { match, type: 'HOME_GOAL', magnitude: hMove });
                } else if (aMove > 0.08 && hMove < -0.03) {
                    match.inferredScore[1]++;
                    match.correlation = 'DIVERGENT';
                    match.confidence = 0.92;
                    match.priceEvidence = `AWAY GOAL: +${(aMove * 100).toFixed(1)}% Velocity | HOME: ${(hMove * 100).toFixed(1)}%`;
                    this.emit('inferredEvent', { match, type: 'AWAY_GOAL', magnitude: aMove });
                }

                // Update state
                match.triad.prevHome = match.triad.homePrice;
                match.triad.homePrice = hPrice;
                match.triad.prevDraw = match.triad.drawPrice;
                match.triad.drawPrice = dPrice;
                match.triad.prevAway = match.triad.awayPrice;
                match.triad.awayPrice = aPrice;
                match.marketPrice = hPrice; // compat

                // Progress minute
                const elapsed = Math.floor((Date.now() - match.discoveryEpoch) / 60000);
                match.minute = Math.min(95, elapsed);
            } catch (e) {}
        }
    }

    private async getPrice(tokenId: string): Promise<number> {
        try {
            const res = await axios.get(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`);
            return parseFloat(res.data.price) || 0;
        } catch (e) { return 0; }
    }

    public getLiveMatches(): SportsMatch[] {
        return Array.from(this.matches.values());
    }

    public forceLink(conditionId: string, matchId: string) {
        this.logger.info(`Force linking ${conditionId} to ${matchId}`);
    }
}
