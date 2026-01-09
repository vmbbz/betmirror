
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

export interface SportsMatch {
    id: string; // eventId
    matchId?: string; // External: Sportmonks ID
    conditionId: string;
    tokenId?: string; 
    homeTeam: string;
    awayTeam: string;
    homeTeamData: Team | null;
    awayTeamData: Team | null;
    score: [number, number]; // Official/Verified Score
    inferredScore: [number, number]; // Inferred from Price Action
    confidence: number;
    minute: number;
    status: 'LIVE' | 'HT' | 'VAR' | 'FT' | 'GOAL' | 'SCOUTING' | 'PREMATCH';
    correlation: 'ALIGNED' | 'DIVERGENT' | 'UNVERIFIED';
    league: string;
    marketPrice?: number;
    previousPrice?: number;
    fairValue: number;
    startTime?: string;
    discoveryEpoch: number;
    priceEvidence?: string;
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

export class SportsIntelService extends EventEmitter {
    private isPolling = false;
    private pollInterval?: NodeJS.Timeout;
    private discoveryInterval?: NodeJS.Timeout;
    private matches: Map<string, SportsMatch> = new Map();
    private teamsCache: Team[] = [];
    private apiToken: string;

    private readonly SURGE_THRESHOLD = 0.08; 

    constructor(private logger: Logger, apiToken?: string) {
        super();
        this.apiToken = apiToken || '';
    }

    public isActive(): boolean {
        return this.isPolling;
    }

    /**
     * WORLD-CLASS FAIR VALUE ENGINE
     */
    public calculateFairValue(score: [number, number], minute: number): number {
        const [h, a] = score;
        const absoluteDiff = Math.abs(h - a);
        const timeFactor = Math.min(minute / 95, 0.99);

        if (absoluteDiff > 0) {
            const baseProb = absoluteDiff === 1 ? 0.65 : 0.88;
            const decaySensitivity = 2.5;
            const fv = baseProb + (1 - baseProb) * Math.pow(timeFactor, decaySensitivity);
            return Math.min(fv, 0.99);
        }
        if (absoluteDiff === 0) {
            const baseDraw = 0.33;
            const drawFairValue = baseDraw + (1 - baseDraw) * Math.pow(timeFactor, 3.0);
            return Math.min(drawFairValue, 0.99);
        }
        return 0.5;
    }

    // ============================================
    // DYNAMIC DATA FETCHING & MATCHING
    // ============================================

    private async fetchTeams(league?: string): Promise<Team[]> {
        const params: Record<string, any> = { limit: 500 };
        if (league) params.league = league;
        try {
            const response = await axios.get(`${GAMMA_BASE}/teams`, { params });
            return response.data;
        } catch (e) {
            this.logger.error("Failed to fetch Gamma Teams");
            return [];
        }
    }

    private matchTeam(name: string): Team | null {
        const lower = name.toLowerCase().trim();
        
        // 1. Exact name
        let match = this.teamsCache.find(t => t.name.toLowerCase() === lower);
        if (match) return match;
        
        // 2. Alias
        match = this.teamsCache.find(t => t.alias?.toLowerCase() === lower);
        if (match) return match;
        
        // 3. Abbreviation
        match = this.teamsCache.find(t => t.abbreviation.toLowerCase() === lower);
        if (match) return match;
        
        // 4. Partial
        match = this.teamsCache.find(t => 
          t.name.toLowerCase().includes(lower) || lower.includes(t.name.toLowerCase())
        );
        if (match) return match;
        
        return null;
    }

    private extractTeamsFromTitle(title: string): { home: string; away: string } | null {
        const patterns = [
          /(.+?)\s+vs\.?\s+(.+)/i,
          /(.+?)\s+v\s+(.+)/i,
          /(.+?)\s+@\s+(.+)/i,
        ];
        
        for (const pattern of patterns) {
          const match = title.match(pattern);
          if (match) {
            return { home: match[1].trim(), away: match[2].trim() };
          }
        }
        return null;
    }

    public async start() {
        if (this.isPolling) return;
        this.isPolling = true;

        // Load teams database for matching
        this.logger.info("⚡ Sports Intel: Loading Institutional Teams Database...");
        this.teamsCache = await this.fetchTeams();
        this.logger.success(`✓ Cached ${this.teamsCache.length} Global Teams`);

        this.logger.info("⚽ Sports Intel: Dynamic Inference Engine Active.");
        
        await this.discoverPolymarketSports();
        this.pollInterval = setInterval(() => this.runInference(), 3500);
        this.discoveryInterval = setInterval(() => this.discoverPolymarketSports(), 60000);
    }

    public stop() {
        this.isPolling = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    }

    private async discoverPolymarketSports() {
        try {
            const tagId = "100639"; // Soccer
            const url = `${GAMMA_BASE}/events?active=true&closed=false&tag_id=${tagId}&order=startTime&ascending=true&limit=20`;
            const response = await axios.get(url);
            
            if (!response.data || !Array.isArray(response.data)) return;

            for (const event of response.data) {
                const market = event.markets?.[0];
                if (!market || !market.conditionId) continue;
                
                const conditionId = market.conditionId;
                const tokenId = market.clobTokenIds ? JSON.parse(market.clobTokenIds)[0] : null;
                
                const extracted = this.extractTeamsFromTitle(event.title);
                const homeTeam = extracted ? this.matchTeam(extracted.home) : null;
                const awayTeam = extracted ? this.matchTeam(extracted.away) : null;

                const existing = this.matches.get(event.id);

                const matchData: SportsMatch = {
                    id: event.id,
                    conditionId: conditionId,
                    tokenId: tokenId,
                    homeTeam: homeTeam?.name || extracted?.home || "Home",
                    awayTeam: awayTeam?.name || extracted?.away || "Away",
                    homeTeamData: homeTeam,
                    awayTeamData: awayTeam,
                    score: existing?.score || [0, 0],
                    inferredScore: existing?.inferredScore || [0, 0],
                    confidence: existing?.confidence || 0,
                    minute: existing?.minute || 0,
                    status: existing?.status || 'SCOUTING',
                    correlation: existing?.correlation || 'UNVERIFIED',
                    league: event.category || "Pro League",
                    startTime: event.startTime,
                    discoveryEpoch: existing?.discoveryEpoch || Date.now(),
                    marketPrice: existing?.marketPrice || 0,
                    previousPrice: existing?.marketPrice || 0,
                    fairValue: existing?.fairValue || 0.5
                };

                this.matches.set(event.id, matchData);
            }
        } catch (e: any) {
            this.logger.error(`[Sports Scout] Discovery Fail: ${e.message}`);
        }
    }

    private async runInference() {
        for (const [id, match] of this.matches.entries()) {
            if (match.status === 'FT' || !match.tokenId) continue;

            const currentPrice = match.marketPrice || 0;
            const prevPrice = match.previousPrice || currentPrice;

            if (currentPrice === 0 || currentPrice === prevPrice) continue;

            const change = currentPrice - prevPrice;
            const pct = prevPrice > 0 ? change / prevPrice : 0;

            if (Math.abs(pct) > this.SURGE_THRESHOLD) {
                this.handleInferredEvent(match, pct > 0 ? 'HOME_GOAL' : 'AWAY_GOAL', pct);
            }

            if (match.minute === 0 && match.discoveryEpoch > 0) {
                const elapsedMins = Math.floor((Date.now() - match.discoveryEpoch) / 60000);
                match.minute = Math.min(90, elapsedMins);
            }

            match.previousPrice = currentPrice;
            match.fairValue = this.calculateFairValue(match.inferredScore, match.minute);

            if (match.matchId && this.apiToken) {
                this.verifyWithAPI(match);
            }
        }
    }

    private handleInferredEvent(match: SportsMatch, type: string, magnitude: number) {
        if (type === 'HOME_GOAL') match.inferredScore[0]++;
        if (type === 'AWAY_GOAL') match.inferredScore[1]++;

        match.confidence = Math.min(0.9, Math.abs(magnitude) * 6);
        match.correlation = 'DIVERGENT';
        match.priceEvidence = `${type}: ${magnitude > 0 ? '+' : ''}${(magnitude * 100).toFixed(1)}% Surge`;

        this.logger.success(`🚀 [INFERENCE] ${type} on ${match.homeTeam} | Confidence: ${match.confidence.toFixed(2)}`);
        this.emit('inferredEvent', { match, type, magnitude });
    }

    private async verifyWithAPI(match: SportsMatch) {
        // Verification logic using match.matchId and this.apiToken
    }

    public getLiveMatches(): SportsMatch[] {
        return Array.from(this.matches.values());
    }
}
