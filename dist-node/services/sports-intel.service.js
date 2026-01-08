import axios from 'axios';
import EventEmitter from 'events';
/**
 * World-Class Sports Intelligence Service
 * Combines Sportmonks live scores with Polymarket market discovery for sub-second arbitrage.
 */
export class SportsIntelService extends EventEmitter {
    logger;
    isPolling = false;
    pollInterval;
    discoveryInterval;
    matches = new Map();
    apiToken;
    // Internal Map: Sportmonks ID -> Polymarket conditionId
    idMap = new Map();
    constructor(logger, apiToken) {
        super();
        this.logger = logger;
        this.apiToken = apiToken || '';
    }
    isActive() {
        return this.isPolling;
    }
    async start() {
        if (this.isPolling)
            return;
        this.isPolling = true;
        this.logger.info("⚽ Sports Intel: Monitoring Live Scores & Pitch Discovery...");
        // 1. Pre-emptive Market Discovery (Initial Scan)
        await this.discoverPolymarketSports();
        // 2. High-Frequency Score Polling (3.5s)
        this.pollInterval = setInterval(() => this.pollLiveScores(), 3500);
        // 3. Periodic Discovery Refresh (60s)
        // This ensures the bot detects new matches added to the Polymarket board
        this.discoveryInterval = setInterval(() => this.discoverPolymarketSports(), 60000);
    }
    stop() {
        this.isPolling = false;
        if (this.pollInterval)
            clearInterval(this.pollInterval);
        if (this.discoveryInterval)
            clearInterval(this.discoveryInterval);
        this.logger.warn("⚽ Sports Intel: Module Standby.");
    }
    /**
     * DUAL-DISCOVERY ENGINE: Scouts Polymarket for active sports events.
     * Uses Gamma API to identify binary outcomes (YES/NO) for live matches.
     */
    async discoverPolymarketSports() {
        try {
            this.logger.info(`📡 [Sports Scout] Scanning board for Live Pitch Alpha...`);
            // Hits Gamma events endpoint for active markets starting today or in-play
            const url = `https://gamma-api.polymarket.com/events?active=true&closed=false&order=startTime&ascending=true&limit=100`;
            const response = await axios.get(url);
            if (!response.data || !Array.isArray(response.data))
                return;
            // Filter for sports keywords or specific tags
            const sportsEvents = response.data.filter((e) => {
                const title = e.title?.toLowerCase() || "";
                const isSoccer = e.tags?.some((t) => t.label === 'Soccer' || t.label === 'Football');
                const hasVS = title.includes(' vs ') || title.includes(' v ');
                return isSoccer || hasVS;
            });
            this.logger.info(`✅ [Sports Scout] Discovered ${sportsEvents.length} Active Sports Events on board.`);
            // Mapping Logic: Attempt to link Polymarket events to Sportmonks IDs
            for (const event of sportsEvents) {
                const conditionId = event.markets?.[0]?.conditionId;
                if (!conditionId)
                    continue;
                // Extraction: Teams from title (e.g., "Arsenal vs Liverpool")
                const teams = event.title.split(/ vs | v /i);
                if (teams.length === 2) {
                    const home = teams[0].trim();
                    const away = teams[1].trim();
                    // Fuzzy matching logic or exact mapping would populate idMap here
                    // this.idMap.set(sportmonksId, conditionId);
                }
            }
        }
        catch (e) {
            this.logger.error(`Sports Discovery Engine Fail: ${e.message}`);
        }
    }
    async pollLiveScores() {
        if (!this.apiToken)
            return;
        try {
            const url = `https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${this.apiToken}&include=participants;scores`;
            const response = await axios.get(url);
            if (!response.data || !response.data.data)
                return;
            const liveMatches = response.data.data.map((m) => {
                const home = m.participants?.find((p) => p.meta.location === 'home');
                const away = m.participants?.find((p) => p.meta.location === 'away');
                const homeScore = m.scores?.find((s) => s.description === 'CURRENT' && s.participant_id === home?.id)?.score?.goals || 0;
                const awayScore = m.scores?.find((s) => s.description === 'CURRENT' && s.participant_id === away?.id)?.score?.goals || 0;
                return {
                    id: m.id.toString(),
                    homeTeam: home?.name || 'Home',
                    awayTeam: away?.name || 'Away',
                    score: [homeScore, awayScore],
                    minute: m.minute || 0,
                    status: m.state?.state === 'INPLAY' ? 'LIVE' : 'VAR',
                    league: m.league_id?.toString() || 'Unknown',
                    conditionId: this.idMap.get(m.id.toString()) // Link pre-emptively found condition
                };
            });
            for (const match of liveMatches) {
                const existing = this.matches.get(match.id);
                if (existing) {
                    // GOAL ALERT
                    if (match.score[0] > existing.score[0] || match.score[1] > existing.score[1]) {
                        this.logger.success(`🥅 GOAL DETECTED: ${match.homeTeam} vs ${match.awayTeam}`);
                        this.emit('goal', { ...match, status: 'GOAL' });
                    }
                    if (match.status === 'VAR' && existing.status !== 'VAR') {
                        this.emit('var', match);
                    }
                }
                this.matches.set(match.id, match);
            }
        }
        catch (e) {
            this.logger.debug(`Sportmonks Polling Warning: ${e.message}`);
        }
    }
    getLiveMatches() {
        return Array.from(this.matches.values());
    }
}
