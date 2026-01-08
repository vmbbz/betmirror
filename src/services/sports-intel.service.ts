
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

    private cleanName(name: string): string {
        return name.toLowerCase()
            .replace(/\bfc\b|\butd\b|\bunited\b|\bcity\b|\breal\b|\batletico\b|\bcf\b/g, '')
            .replace(/[^a-z0-9]/g, '')
            .trim();
    }

    private fuzzyMatch(pmTitle: string, smHome: string, smAway: string): boolean {
        const cleanPm = pmTitle.toLowerCase().replace(/ vs | v /i, ' ');
        const cHome = this.cleanName(smHome);
        const cAway = this.cleanName(smAway);
        
        if (cHome.length < 3 || cAway.length < 3) return false;

        // Regex check: Does the cleaned Polymarket title contain significant parts of cleaned SM names
        const homeRegex = new RegExp(cHome.substring(0, 5));
        const awayRegex = new RegExp(cAway.substring(0, 5));

        return homeRegex.test(cleanPm) && awayRegex.test(cleanPm);
    }

    public async start() {
        if (this.isPolling) return;
        this.isPolling = true;
        this.logger.info("⚽ Sports Intel: Monitoring Live Scores & Structural Discovery...");
        
        await this.discoverPolymarketSports();
        
        if (this.apiToken) {
            this.pollInterval = setInterval(() => this.pollLiveScores(), 3500);
        }
        
        this.discoveryInterval = setInterval(() => this.discoverPolymarketSports(), 60000);
    }

    public stop() {
        this.isPolling = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    }

    private async discoverPolymarketSports() {
        try {
            this.logger.info(`📡 [Sports Scout] Querying Sports Metadata...`);
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
                this.attemptMapping(conditionId, event.title);
            }
        } catch (e: any) {
            this.logger.error(`[Sports Scout] Discovery Fail: ${e.message}`);
        }
    }

    private async attemptMapping(conditionId: string, eventTitle: string) {
        if (!this.apiToken) return;
        
        try {
            const today = new Date().toISOString().split('T')[0];
            const url = `https://api.sportmonks.com/v3/football/fixtures/date/${today}?api_token=${this.apiToken}&include=participants`;
            const response = await axios.get(url);
            if (!response.data || !response.data.data) return;

            for (const f of response.data.data) {
                const home = f.participants?.find((p: any) => p.meta.location === 'home')?.name || "";
                const away = f.participants?.find((p: any) => p.meta.location === 'away')?.name || "";

                if (this.fuzzyMatch(eventTitle, home, away)) {
                    const match = this.matches.get(conditionId);
                    if (match) {
                        match.matchId = f.id.toString();
                        this.externalToInternal.set(f.id.toString(), conditionId);
                        this.logger.success(`🔗 AUTO-LINK: ${eventTitle} matched to SM:${f.id}`);
                        return;
                    }
                }
            }
        } catch (e) {}
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

                // Handle VAR
                if (m.state?.state === 'VAR') {
                    if (existing.status !== 'VAR') this.emit('var', existing);
                    existing.status = 'VAR';
                }

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

    public forceLink(conditionId: string, matchId: string) {
        const match = this.matches.get(conditionId);
        if (match) {
            match.matchId = matchId;
            this.externalToInternal.set(matchId, conditionId);
            this.logger.success(`🎯 MANUAL-LINK: ${conditionId} -> SM:${matchId}`);
        }
    }
}
