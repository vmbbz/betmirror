import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import EventEmitter from 'events';

export interface SportsMatch {
    id: string;
    conditionId?: string;
    tokenId?: string; // Target token ID for price feed
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
    private matches: Map<string, SportsMatch> = new Map();
    private apiToken: string;
    private idMap: Map<string, string> = new Map(); // matchId -> conditionId
    private tokenMap: Map<string, string> = new Map(); // matchId -> tokenId

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
            this.logger.warn("⚠️ Sports Intel: No API Token provided. Match discovery active but score polling is DISABLED.");
        }

        // 1. Initial Pitch Discovery & Metadata Mapping
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

    /**
     * structural discovery via /sports and /events?tag_id=100639
     */
    private async discoverPolymarketSports() {
        try {
            this.logger.info(`📡 [Sports Scout] Querying Sports Metadata...`);
            
            // 1. Get Series IDs for Soccer (ID: 1 in many systems, but we fetch to be safe)
            const sportsRes = await axios.get("https://gamma-api.polymarket.com/sports");
            const soccerData = sportsRes.data.find((s: any) => s.name?.toLowerCase() === 'soccer' || s.id === "1");
            
            // 2. Targeted search for "Game Winner" markets (Tag: 100639)
            // This ensures we avoid futures and long-term props
            const tagId = "100639"; 
            const url = `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tagId}&order=startTime&ascending=true&limit=50`;
            const response = await axios.get(url);
            
            if (!response.data || !Array.isArray(response.data)) return;

            this.logger.info(`✅ [Sports Scout] Found ${response.data.length} Structural Sports Events.`);

            for (const event of response.data) {
                const market = event.markets?.[0];
                if (!market || !market.conditionId) continue;
                
                // Polymarket best practice: Use 'closed' field
                if (market.closed === true) continue;

                const conditionId = market.conditionId;
                const tokenId = market.clobTokenIds ? JSON.parse(market.clobTokenIds)[0] : null;

                // Resolution of match via Team Mapping
                const matchId = await this.findSportmonksMatch(event.title);
                if (matchId) {
                    this.idMap.set(matchId, conditionId);
                    if (tokenId) this.tokenMap.set(matchId, tokenId);
                    
                    if (!this.matches.has(matchId)) {
                        const teams = event.title.split(/ vs | v /i);
                        this.matches.set(matchId, {
                            id: matchId,
                            conditionId: conditionId,
                            tokenId: tokenId,
                            homeTeam: teams[0]?.trim() || "Home",
                            awayTeam: teams[1]?.trim() || "Away",
                            score: [0, 0],
                            minute: 0,
                            status: 'PREMATCH',
                            league: event.category || "Pro League",
                            startTime: event.startTime
                        });
                    }
                }
            }
        } catch (e: any) {
            this.logger.error(`[Sports Scout] Discovery Fail: ${e.message}`);
        }
    }

    /**
     * Matches Polymarket event title to Sportmonks fixtures
     */
    private async findSportmonksMatch(eventTitle: string): Promise<string | null> {
        if (!this.apiToken) return null;
        
        try {
            const today = new Date().toISOString().split('T')[0];
            const url = `https://api.sportmonks.com/v3/football/fixtures/date/${today}?api_token=${this.apiToken}&include=participants`;
            const response = await axios.get(url);
            
            if (!response.data || !response.data.data) return null;

            const fixtures = response.data.data;
            const normalizedTitle = eventTitle.toLowerCase();

            for (const f of fixtures) {
                const home = f.participants?.find((p: any) => p.meta.location === 'home')?.name?.toLowerCase() || "";
                const away = f.participants?.find((p: any) => p.meta.location === 'away')?.name?.toLowerCase() || "";

                // Fuzzy check: If team names are contained in the market title
                if (normalizedTitle.includes(home) && normalizedTitle.includes(away)) {
                    return f.id.toString();
                }
            }
        } catch (e) {
            this.logger.debug(`[Sports Intel] Fixture lookup failed for: ${eventTitle}`);
        }
        return null;
    }

    private async pollLiveScores() {
        if (!this.apiToken) return;
        try {
            const url = `https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${this.apiToken}&include=participants;scores`;
            const response = await axios.get(url);
            if (!response.data || !response.data.data) return;

            const liveMatches = response.data.data.map((m: any) => {
                const home = m.participants?.find((p: any) => p.meta.location === 'home');
                const away = m.participants?.find((p: any) => p.meta.location === 'away');
                const homeScore = m.scores?.find((s: any) => s.description === 'CURRENT' && s.participant_id === home?.id)?.score?.goals || 0;
                const awayScore = m.scores?.find((s: any) => s.description === 'CURRENT' && s.participant_id === away?.id)?.score?.goals || 0;

                const matchId = m.id.toString();

                return {
                    id: matchId,
                    homeTeam: home?.name || 'Home',
                    awayTeam: away?.name || 'Away',
                    score: [homeScore, awayScore],
                    minute: m.minute || 0,
                    status: m.state?.state === 'INPLAY' ? 'LIVE' : 'VAR',
                    league: m.league_id?.toString() || 'Live',
                    conditionId: this.idMap.get(matchId),
                    tokenId: this.tokenMap.get(matchId)
                } as SportsMatch;
            });

            for (const match of liveMatches) {
                const existing = this.matches.get(match.id);
                
                // Detection for real-time goal bursts
                if (existing && existing.status !== 'PREMATCH' && existing.status !== 'SCOUTING') {
                    if (match.score[0] > existing.score[0] || match.score[1] > existing.score[1]) {
                        this.logger.success(`🥅 GOAL BURST: ${match.homeTeam} ${match.score[0]}-${match.score[1]} ${match.awayTeam}`);
                        this.emit('goal', { ...match, status: 'GOAL' });
                    }
                }
                
                this.matches.set(match.id, { ...existing, ...match });
            }
        } catch (e) {
            this.logger.debug(`[Sports Intel] Poll Error`);
        }
    }

    public getLiveMatches(): SportsMatch[] {
        return Array.from(this.matches.values());
    }
}
