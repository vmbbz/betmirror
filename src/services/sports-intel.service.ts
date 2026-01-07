import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import EventEmitter from 'events';

export interface SportsMatch {
    id: string;
    homeTeam: string;
    awayTeam: string;
    score: [number, number];
    minute: number;
    status: 'LIVE' | 'HT' | 'VAR' | 'FT' | 'GOAL';
    league: string;
}

export class SportsIntelService extends EventEmitter {
    private isPolling = false;
    private pollInterval?: NodeJS.Timeout;
    private matches: Map<string, SportsMatch> = new Map();
    private apiToken: string;

    constructor(private logger: Logger, apiToken?: string) {
        super();
        this.apiToken = apiToken || process.env.SPORTSMONKS_API_TOKEN || '';
    }

    public isActive(): boolean {
        return this.isPolling;
    }

    public async start() {
        if (this.isPolling) return;
        if (!this.apiToken) {
            this.logger.warn("⚠️ Sportsmonks API Token missing. Sports frontrunning will remain in MOCK mode.");
        }
        this.isPolling = true;
        this.logger.info("⚽ Sports Intel: Monitoring High-Latency Feeds...");
        
        // Poll every 3 seconds (Sportsmonks rate limit friendly)
        this.pollInterval = setInterval(() => this.pollLiveScores(), 3000);
    }

    public stop() {
        this.isPolling = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
    }

    private async pollLiveScores() {
        try {
            let liveMatches: SportsMatch[] = [];
            
            if (this.apiToken) {
                // Production: Fetch from Sportmonks V3
                const response = await axios.get(`https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${this.apiToken}&include=participants;periods`);
                if (response.data && response.data.data) {
                    liveMatches = response.data.data.map((m: any) => {
                        const home = m.participants.find((p: any) => p.meta.location === 'home');
                        const away = m.participants.find((p: any) => p.meta.location === 'away');
                        
                        return {
                            id: m.id.toString(),
                            homeTeam: home?.name || 'Home',
                            awayTeam: away?.name || 'Away',
                            score: [m.scores?.home_score || 0, m.scores?.away_score || 0],
                            minute: m.minute || 0,
                            status: m.state?.state === 'INPLAY' ? 'LIVE' : 'VAR',
                            league: m.league_id?.toString() || 'Unknown'
                        };
                    });
                }
            } else {
                return; 
            }
            
            for (const match of liveMatches) {
                const existing = this.matches.get(match.id);
                
                if (existing) {
                    if (match.score[0] !== existing.score[0] || match.score[1] !== existing.score[1]) {
                        this.logger.success(`🥅 GOAL DETECTED: ${match.homeTeam} ${match.score[0]}-${match.score[1]} ${match.awayTeam}`);
                        this.emit('goal', { ...match, status: 'GOAL' });
                    }
                    
                    if (match.status === 'VAR' && existing.status !== 'VAR') {
                        this.logger.warn(`🖥️ VAR RECOGNIZED: Matching ${match.homeTeam} vs ${match.awayTeam}`);
                        this.emit('var', match);
                    }
                }
                
                this.matches.set(match.id, match);
            }
        } catch (e: any) {
            this.logger.error(`Sports Intel Poll Failed: ${e.message}`);
        }
    }

    public getLiveMatches(): SportsMatch[] {
        return Array.from(this.matches.values());
    }
}
