import axios from 'axios';
import EventEmitter from 'events';
export class SportsIntelService extends EventEmitter {
    logger;
    isPolling = false;
    pollInterval;
    matches = new Map();
    apiToken;
    constructor(logger, apiToken) {
        super();
        this.logger = logger;
        // Use the provided production key
        this.apiToken = apiToken || '4FyNA9F8T1jwnqzgIbyeGnV39bPNV3GAXj8SyPszBQo45pWZzBaSBpKhyZLK';
    }
    isActive() {
        return this.isPolling;
    }
    async start() {
        if (this.isPolling)
            return;
        this.isPolling = true;
        this.logger.info("⚽ Sports Intel: Connecting to Sportmonks V3 Live Feed...");
        // Poll every 3.5 seconds to stay safe within rate limits while maintaining latency edge
        this.pollInterval = setInterval(() => this.pollLiveScores(), 3500);
    }
    stop() {
        this.isPolling = false;
        if (this.pollInterval)
            clearInterval(this.pollInterval);
    }
    async pollLiveScores() {
        try {
            // TARGET ENDPOINT: v3/football/livescores/inplay
            // INCLUDES: participants (for team names), scores (for current goals)
            const url = `https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${this.apiToken}&include=participants;scores;periods`;
            const response = await axios.get(url);
            if (!response.data || !response.data.data) {
                return;
            }
            const liveMatches = response.data.data.map((m) => {
                const home = m.participants?.find((p) => p.meta.location === 'home');
                const away = m.participants?.find((p) => p.meta.location === 'away');
                // Extract current score from the scores array or base data
                const homeScore = m.scores?.find((s) => s.description === 'CURRENT' && s.participant_id === home?.id)?.score?.goals || 0;
                const awayScore = m.scores?.find((s) => s.description === 'CURRENT' && s.participant_id === away?.id)?.score?.goals || 0;
                return {
                    id: m.id.toString(),
                    homeTeam: home?.name || 'Home',
                    awayTeam: away?.name || 'Away',
                    score: [homeScore, awayScore],
                    minute: m.minute || 0,
                    status: m.state?.state === 'INPLAY' ? 'LIVE' : 'VAR',
                    league: m.league_id?.toString() || 'Unknown'
                };
            });
            for (const match of liveMatches) {
                const existing = this.matches.get(match.id);
                if (existing) {
                    // GOAL DETECTION LOGIC
                    if (match.score[0] > existing.score[0] || match.score[1] > existing.score[1]) {
                        const scoringTeam = match.score[0] > existing.score[0] ? match.homeTeam : match.awayTeam;
                        this.logger.success(`🥅 GOAL! ${scoringTeam} scored. New Score: ${match.homeTeam} ${match.score[0]}-${match.score[1]} ${match.awayTeam}`);
                        this.emit('goal', { ...match, status: 'GOAL' });
                    }
                    if (match.status === 'VAR' && existing.status !== 'VAR') {
                        this.logger.warn(`🖥️ VAR ALERT: Potential goal review in ${match.homeTeam} vs ${match.awayTeam}`);
                        this.emit('var', match);
                    }
                }
                else {
                    // Log new matches found in the feed
                    this.logger.info(`📡 New Live Match Tracked: ${match.homeTeam} vs ${match.awayTeam}`);
                }
                this.matches.set(match.id, match);
            }
        }
        catch (e) {
            this.logger.error(`Sports Feed Error: ${e.message}`);
        }
    }
    getLiveMatches() {
        return Array.from(this.matches.values());
    }
}
