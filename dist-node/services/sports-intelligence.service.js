import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import axios from 'axios';
/**
 * SPORTS INTELLIGENCE SERVICE - V3 (Predator Nexus)
 *
 * Purpose: Provides real-time sports telemetry to front-run price discovery.
 * Uses the broadcast-only Sports WebSocket and Gamma Match Mappings.
 */
export class SportsIntelligenceService extends EventEmitter {
    logger;
    ws;
    isRunning = false;
    sportsWsUrl = 'wss://sports-api.polymarket.com/ws';
    nexusMapping = new Map(); // gameId -> Token Metadata
    constructor(logger) {
        super();
        this.logger = logger;
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        // Build the mapping first
        await this.refreshMatchMappings();
        this.connect();
        // Refresh mapping every 10 minutes to capture newly created game markets
        setInterval(() => this.refreshMatchMappings(), 600000);
    }
    connect() {
        this.logger.info(`🔌 Connecting to Sports Broadcast: ${this.sportsWsUrl}`);
        this.ws = new WebSocket(this.sportsWsUrl);
        this.ws.on('open', () => {
            this.logger.success('✅ Sports Intelligence Feed Connected');
        });
        this.ws.on('message', (data) => {
            const msg = data.toString();
            // CRITICAL: Handle Heartbeat as per Polymarket spec
            if (msg === 'ping') {
                this.ws?.send('pong');
                return;
            }
            try {
                const update = JSON.parse(msg);
                this.handleScoreUpdate(update);
            }
            catch (e) {
                // Ignore non-JSON or malformed broadcast messages
            }
        });
        this.ws.on('close', () => {
            if (this.isRunning) {
                this.logger.warn("⚠️ Sports feed disconnected. Reconnecting in 5s...");
                setTimeout(() => this.connect(), 5000);
            }
        });
    }
    handleScoreUpdate(msg) {
        // Broadcast format: { gameId, score, homeTeam, awayTeam, live, ended, ... }
        const { gameId, score, homeTeam } = msg;
        const relevantMarkets = this.nexusMapping.get(Number(gameId));
        if (!relevantMarkets)
            return;
        for (const market of relevantMarkets) {
            this.emit('sports_score_update', {
                tokenId: market.tokenId,
                conditionId: market.conditionId,
                team: homeTeam,
                score: score,
                direction: 'UP',
                marketQuestion: market.question,
                currentPrice: market.lastPrice || 0.5,
                gameId
            });
        }
    }
    /**
     * Maps real-world game IDs (from Sports API) to CLOB Token IDs (from Gamma API).
     */
    async refreshMatchMappings() {
        try {
            this.logger.info("🔄 Re-building Match Nexus via Series ID...");
            // 1. Get active sports categories/leagues
            const sportsRes = await axios.get('https://gamma-api.polymarket.com/sports');
            const sports = sportsRes.data;
            if (!Array.isArray(sports))
                return;
            const newMapping = new Map();
            for (const sport of sports) {
                // 2. Fetch events for this league's specific seriesId
                const eventsRes = await axios.get('https://gamma-api.polymarket.com/events', {
                    params: { series_id: sport.seriesId, active: true, closed: false }
                });
                if (!Array.isArray(eventsRes.data))
                    continue;
                for (const event of eventsRes.data) {
                    const gameId = event.gameId; // Unique Number linking news to markets
                    if (!gameId || !event.markets || event.markets.length === 0)
                        continue;
                    const primaryMarket = event.markets[0];
                    const marketInfo = {
                        conditionId: primaryMarket.conditionId,
                        tokenId: primaryMarket.clobTokenIds?.[0],
                        question: primaryMarket.question,
                        lastPrice: parseFloat(primaryMarket.outcomePrices?.[1] || '0.5')
                    };
                    const existing = newMapping.get(Number(gameId)) || [];
                    existing.push(marketInfo);
                    newMapping.set(Number(gameId), existing);
                }
            }
            this.nexusMapping = newMapping;
            this.logger.info(`🎯 Nexus Sync Complete: ${this.nexusMapping.size} games mapped.`);
        }
        catch (e) {
            this.logger.warn("❌ Sports Nexus refresh bottlenecked. Verify Gamma API availability.");
        }
    }
    stop() {
        this.isRunning = false;
        if (this.ws?.readyState === 1)
            this.ws.close();
    }
}
