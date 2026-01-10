import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import EventEmitter from 'events';
// Fix: Use a distinct name for Node.js WebSocket to avoid conflict with global browser WebSocket type
import WebSocket from 'ws';
import { WS_URLS } from '../config/env.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export interface SportsMatch {
  id: string;
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  tokenIds: string[];
  image: string;
  slug: string;
  eventSlug: string;
  startTime: string;
  minute: number;
  homeScore: number;
  awayScore: number;
  status: 'LIVE' | 'UPCOMING' | 'HALFTIME' | 'FINISHED';
  correlation: 'ALIGNED' | 'DIVERGENT' | 'UNVERIFIED';
  edgeWindow: number; // Seconds since event inferred
  priceEvidence?: string;
  confidence: number;
  marketPrice?: number;
}

export class SportsIntelService extends EventEmitter {
  private isPolling = false;
  private discoveryInterval?: NodeJS.Timeout;
  private matches: Map<string, SportsMatch> = new Map();
  private ws?: WebSocket;
  private subscribedTokens: Set<string> = new Set();

  constructor(private logger: Logger) {
    super();
  }

  public isActive(): boolean {
    return this.isPolling;
  }

  public async start() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.logger.info("🏃 Sports Intel: Monitoring Price Velocity for Alpha...");
    await this.discoverSportsMarkets();
    this.connectWebSocket();
    this.discoveryInterval = setInterval(() => this.discoverSportsMarkets(), 30000);
  }

  private async discoverSportsMarkets() {
  try {
    // Method 1: Get sports metadata first
    const sportsRes = await axios.get(`${GAMMA_BASE}/sports`);
    const sports = sportsRes.data || [];
    
    this.logger.info(`Found ${sports.length} sports categories`);

    for (const sport of sports) {
      // The series array contains leagues with seriesId
      const seriesList = sport.series || [];
      
      for (const league of seriesList) {
        if (!league.seriesId) continue;
        
        // tag_id=100639 = game bets (not futures)
        const url = `${GAMMA_BASE}/events?series_id=${league.seriesId}&tag_id=100639&active=true&closed=false&order=startTime&ascending=true&limit=20`;
        
        try {
          const response = await axios.get(url);
          if (!response.data?.length) continue;
          
          this.logger.info(`Found ${response.data.length} events for ${league.label || league.seriesId}`);
          
          for (const event of response.data) {
            await this.processEvent(event, now);
          }
        } catch (e) {
          // Some series may have no active events
        }
      }
    }

    // Method 2: FALLBACK - Also try direct events query without series_id
    // This catches sports not in /sports endpoint (UFC, Boxing, F1, etc.)
    const fallbackUrl = `${GAMMA_BASE}/events?tag_id=100639&active=true&closed=false&order=startTime&ascending=true&limit=50`;
    const fallbackRes = await axios.get(fallbackUrl);
    
    if (fallbackRes.data?.length) {
      this.logger.info(`Fallback found ${fallbackRes.data.length} additional events`);
      const now = new Date();
      for (const event of fallbackRes.data) {
        await this.processEvent(event, now);
      }
    }

    this.logger.info(`📊 Total: ${this.matches.size} sports markets tracked`);
  } catch (e: any) {
    this.logger.error(`Discovery error: ${e.message}`);
  }
}

  private processEvent(event: any, now: Date) {
    const market = event.markets?.[0];
    if (!market?.clobTokenIds) return;

    const startTime = new Date(event.startTime);
    const isLive = startTime <= now;
    if (!isLive) return;

    const tokenIds: string[] = JSON.parse(market.clobTokenIds);
    const outcomes: string[] = JSON.parse(market.outcomes);
    const prices: number[] = JSON.parse(market.outcomePrices || '[]').map(Number);

    const existing = this.matches.get(market.conditionId);
    
    const matchData: SportsMatch = {
      id: event.id,
      conditionId: market.conditionId,
      question: market.question || event.title,
      outcomes,
      outcomePrices: prices.length ? prices : (existing?.outcomePrices || new Array(outcomes.length).fill(0.5)),
      tokenIds,
      image: event.image || market.image || '',
      slug: market.slug || '',
      eventSlug: event.slug || '',
      startTime: event.startTime,
      minute: Math.floor((now.getTime() - startTime.getTime()) / 60000),
      homeScore: existing?.homeScore || 0,
      awayScore: existing?.awayScore || 0,
      status: 'LIVE',
      correlation: existing?.correlation || 'ALIGNED',
      edgeWindow: existing?.edgeWindow || 0,
      confidence: 0.95
    };

    this.matches.set(market.conditionId, matchData);
    tokenIds.forEach(tid => this.subscribeToken(tid));
  }

  private connectWebSocket() {
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.logger.info('🔌 Sports WebSocket connected');
      this.subscribedTokens.forEach(tid => this.subscribeToken(tid));
    });
    (this.ws as any).on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handlePriceSpike(msg);
      } catch {}
    });
  }

  private subscribeToken(tokenId: string) {
    if (this.ws?.readyState === 1 && !this.subscribedTokens.has(tokenId)) {
      this.ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId] }));
      this.subscribedTokens.add(tokenId);
    }
  }

  /**
   * INFERENCE ENGINE: Front-run based on price velocity spikes
   */
  private handlePriceSpike(msg: any) {
    if (msg.event_type !== 'last_trade_price' && msg.event_type !== 'price_change') return;
    const tokenId = msg.asset_id;
    const newPrice = parseFloat(msg.price);

    for (const match of this.matches.values()) {
      const idx = match.tokenIds.indexOf(tokenId);
      if (idx === -1) continue;

      const oldPrice = match.outcomePrices[idx];
      match.outcomePrices[idx] = newPrice;

      // Calculate velocity spike
      const velocity = (newPrice - oldPrice) / oldPrice;
      
      // If price jumps > 8% instantly while score is same, infer a goal
      if (velocity > 0.08 && match.correlation === 'ALIGNED') {
        match.correlation = 'DIVERGENT';
        match.edgeWindow = 12; // Inferred latency lead
        match.priceEvidence = `VELOCITY ALERT: ${match.outcomes[idx]} Spiked ${(velocity * 100).toFixed(1)}%`;
        
        this.emit('alphaEvent', { 
            match, 
            tokenId, 
            outcomeIndex: idx, 
            newPrice, 
            velocity 
        });
      }

      if (match.correlation === 'DIVERGENT' && Math.abs(velocity) < 0.01) {
          // Stability reached, awaiting sync
      }
    }
  }

  public getLiveMatches(): SportsMatch[] {
    return Array.from(this.matches.values());
  }

  public forceLink(conditionId: string, matchId: string): void {
      const match = this.matches.get(conditionId);
      if (match) {
          match.id = matchId;
          this.logger.info(`Sports Intel: Manually linked ${conditionId} to ${matchId}`);
      }
  }

  public stop() {
    this.isPolling = false;
    (this.ws as any)?.terminate();
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
  }
}