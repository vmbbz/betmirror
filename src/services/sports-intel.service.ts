
import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import EventEmitter from 'events';

export interface SportsMatch {
    id: string; // Primary Key: conditionId
    matchId?: string; // External: Sportmonks ID
    conditionId: string;
    tokenId?: string; 
    homeTeam: string;
    awayTeam: string;
    score: [number, number];
    minute: number;
    status: 'LIVE' | 'HT' | 'VAR' | 'FT' | 'GOAL' | 'SCOUTING' | 'PREMATCH';
    league: string;
    marketPrice?: number;
    fairValue?: number;
    startTime?: string;
}

export class SportsIntelService extends EventEmitter {
    private isPolling = false;
    private pollInterval?: NodeJS.Timeout;
    private discoveryInterval?: NodeJS.Timeout;
    private matches: Map<string, SportsMatch> = new Map(); // Keyed by conditionId
    private apiToken: string;
    private externalToInternal: Map<string, string> = new Map(); // matchId -> conditionId

    constructor(private logger: Logger, apiToken?: string) {
        super();
        this.apiToken = apiToken || '';
    }

    public isActive(): boolean {
        return this.isPolling;
    }

    public async start() {
        if (this.isPolling) return;
        this.isPolling = true;
        this.logger.info("⚽ Sports Intel: Monitoring Live Scores & Structural Discovery...");
        
        if (!this.apiToken) {
            this.logger.warn("⚠️ Sports Intel: No Sportmonks API Token provided. Mapped score polling is DISABLED.");
        }

        // 1. Initial Pitch Discovery
        await this.discoverPolymarketSports();
        
        // 2. High-Frequency Score Polling (3.5s)
        if (this.apiToken) {
            this.pollInterval = setInterval(() => this.pollLiveScores(), 3500);
        }
        
        // 3. Periodic Discovery Refresh (60s)
        this.discoveryInterval = setInterval(() => this.discoverPolymarketSports(), 60000);
    }

    public stop() {
        this.isPolling = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.discoveryInterval) clearInterval(this.discoveryInterval);
        this.logger.warn("⚽ Sports Intel: Engine standby.");
    }

    private async discoverPolymarketSports() {
        try {
            this.logger.info(`📡 [Sports Scout] Querying Sports Metadata...`);
            
            // Targeted search for "Game Winner" markets (Tag: 100639)
            const tagId = "100639"; 
            const url = `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tagId}&order=startTime&ascending=true&limit=50`;
            const response = await axios.get(url);
            
            if (!response.data || !Array.isArray(response.data)) return;

            this.logger.info(`✅ [Sports Scout] Found ${response.data.length} Structural Sports Events.`);

            for (const event of response.data) {
                const market = event.markets?.[0];
                if (!market || !market.conditionId) continue;
                
                const conditionId = market.conditionId;
                const tokenId = market.clobTokenIds ? JSON.parse(market.clobTokenIds)[0] : null;

                // 1. ALWAYS store/update the match in the map immediately
                const teams = event.title.split(/ vs | v /i);
                const existing = this.matches.get(conditionId);

                const matchData: SportsMatch = {
                    id: conditionId,
                    conditionId: conditionId,
                    tokenId: tokenId,
                    homeTeam: teams[0]?.trim() || "Home",
                    awayTeam: teams[1]?.trim() || "Away",
                    score: existing?.score || [0, 0],
                    minute: existing?.minute || 0,
                    status: existing?.status || 'SCOUTING',
                    league: event.category || "Pro League",
                    startTime: event.startTime,
                    marketPrice: existing?.marketPrice || 0
                };

                this.matches.set(conditionId, matchData);

                // 2. Trigger asynchronous mapping to Sportmonks
                this.attemptMapping(conditionId, event.title);
            }
        } catch (e: any) {
            this.logger.error(`[Sports Scout] Discovery Fail: ${e.message}`);
        }
    }

    private async attemptMapping(conditionId: string, eventTitle: string) {
        if (!this.apiToken) return;
        
        const matchId = await this.findSportmonksMatch(eventTitle);
        if (matchId) {
            const match = this.matches.get(conditionId);
            if (match) {
                match.matchId = matchId;
                this.externalToInternal.set(matchId, conditionId);
                this.logger.debug(`[Sports Intel] Mapped ${eventTitle} -> SM:${matchId}`);
            }
        }
    }

    private async findSportmonksMatch(eventTitle: string): Promise<string | null> {
        if (!this.apiToken) return null;
        try {
            const today = new Date().toISOString().split('T')[0];
            const url = `https://api.sportmonks.com/v3/football/fixtures/date/${today}?api_token=${this.apiToken}&include=participants`;
            const response = await axios.get(url);
            if (!response.data || !response.data.data) return null;

            const normalizedTitle = eventTitle.toLowerCase();
            for (const f of response.data.data) {
                const home = f.participants?.find((p: any) => p.meta.location === 'home')?.name?.toLowerCase() || "";
                const away = f.participants?.find((p: any) => p.meta.location === 'away')?.name?.toLowerCase() || "";
                if (normalizedTitle.includes(home) && normalizedTitle.includes(away)) {
                    return f.id.toString();
                }
            }
        } catch (e) {}
        return null;
    }

    private async pollLiveScores() {
        if (!this.apiToken) return;
        try {
            const url = `https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${this.apiToken}&include=participants;scores`;
            const response = await axios.get(url);
            if (!response.data || !response.data.data) return;

            for (const m of response.data.data) {
                const matchId = m.id.toString();
                const conditionId = this.externalToInternal.get(matchId);
                if (!conditionId) continue;

                const existing = this.matches.get(conditionId);
                if (!existing) continue;

                const home = m.participants?.find((p: any) => p.meta.location === 'home');
                const homeScore = m.scores?.find((s: any) => s.description === 'CURRENT' && s.participant_id === home?.id)?.score?.goals || 0;
                const away = m.participants?.find((p: any) => p.meta.location === 'away');
                const awayScore = m.scores?.find((s: any) => s.description === 'CURRENT' && s.participant_id === away?.id)?.score?.goals || 0;

                // Detection for real-time goal bursts
                if ((homeScore > existing.score[0] || awayScore > existing.score[1]) && existing.status !== 'SCOUTING') {
                    this.logger.success(`🥅 GOAL BURST: ${existing.homeTeam} ${homeScore}-${awayScore} ${existing.awayTeam}`);
                    this.emit('goal', { ...existing, score: [homeScore, awayScore], status: 'GOAL' });
                }
                
                this.matches.set(conditionId, {
                    ...existing,
                    score: [homeScore, awayScore],
                    minute: m.minute || existing.minute,
                    status: m.state?.state === 'INPLAY' ? 'LIVE' : (m.state?.state === 'VAR' ? 'VAR' : 'LIVE')
                });
            }
        } catch (e) {}
    }

    public getLiveMatches(): SportsMatch[] {
        return Array.from(this.matches.values());
    }
}
