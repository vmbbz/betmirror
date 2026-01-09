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
  outcomes: string[];           // ["Team A", "Draw", "Team B"] or ["Yes", "No"]
  outcomePrices: number[];      // Maps 1:1 with outcomes
  tokenIds: string[];           // Maps 1:1 with outcomes
  image: string;
  slug: string;
  eventSlug: string;
  startTime?: string;
  volume?: string;
  liquidity?: string;
  status: 'LIVE' | 'HT' | 'VAR' | 'FT' | 'SCOUTING' | 'PREMATCH';
  correlation: 'ALIGNED' | 'DIVERGENT' | 'UNVERIFIED';
  priceEvidence?: string;
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

  public async start() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.logger.info("⚽ Pitch Intelligence System: ONLINE. Mapping All-Sport Triads.");

    await this.discoverSportsMarkets();
    this.connectWebSocket();
    
    this.discoveryInterval = setInterval(() => this.discoverSportsMarkets(), 30000);
  }

  public stop() {
    this.isPolling = false;
    if (this.ws) {
        // Fix: .terminate() is available on Node.js WebSocket
        this.ws.terminate();
    }
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    this.logger.warn("⚽ Sports Intel: Offline.");
  }

  public isActive(): boolean {
    return this.isPolling;
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
            await this.processEvent(event);
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
      for (const event of fallbackRes.data) {
        await this.processEvent(event);
      }
    }

    this.logger.info(`📊 Total: ${this.matches.size} sports markets tracked`);
  } catch (e: any) {
    this.logger.error(`Discovery error: ${e.message}`);
  }
}

private async processEvent(event: any) {
  const market = event.markets?.[0];
  if (!market?.clobTokenIds || !market?.conditionId) return;
  if (this.matches.has(market.conditionId)) return; // Skip duplicates

  try {
    const tokenIds: string[] = JSON.parse(market.clobTokenIds);
    const outcomes: string[] = JSON.parse(market.outcomes);
    const outcomePrices: number[] = JSON.parse(market.outcomePrices).map(Number);

    const matchData: SportsMatch = {
      id: event.id,
      conditionId: market.conditionId,
      question: market.question || event.title,
      outcomes,
      outcomePrices,
      tokenIds,
      image: event.image || market.image || '',
      slug: market.slug || '',
      eventSlug: event.slug || '',
      startTime: event.startTime,
      volume: market.volume,
      liquidity: market.liquidity,
      status: 'SCOUTING',
      correlation: 'UNVERIFIED'
    };

    this.matches.set(market.conditionId, matchData);

    tokenIds.forEach(tid => {
      if (!this.subscribedTokens.has(tid)) {
        this.subscribeToken(tid);
      }
    });
  } catch (e) {
    // Skip malformed events
  }
}

  private connectWebSocket() {
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.logger.info('🔌 Sports WebSocket connected');
      this.subscribedTokens.forEach(tid => this.subscribeToken(tid));
    });

    this.ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'PONG') return;

      try {
        const parsed = JSON.parse(msg);
        this.handlePriceUpdate(parsed);
      } catch {}
    });

    this.ws.on('close', () => {
      if (this.isPolling) {
        this.logger.warn('WebSocket closed, reconnecting...');
        setTimeout(() => this.connectWebSocket(), 5000);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket Error: ${err.message}`);
    });
  }

  private subscribeToken(tokenId: string) {
    // Fix: Use readyState 1 (OPEN) for browser WebSocket compatibility
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({
        type: 'market',
        assets_ids: [tokenId]
      }));
      this.subscribedTokens.add(tokenId);
    }
  }

  private handlePriceUpdate(msg: any) {
    if (msg.event_type !== 'last_trade_price' && msg.event_type !== 'price_change') return;

    const tokenId = msg.asset_id;
    const newPrice = parseFloat(msg.price);

    for (const match of this.matches.values()) {
      const idx = match.tokenIds.indexOf(tokenId);
      if (idx === -1) continue;

      const oldPrice = match.outcomePrices[idx];
      match.outcomePrices[idx] = newPrice;

      const velocity = oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0;

      if (Math.abs(velocity) > 0.08) {
        match.correlation = 'DIVERGENT';
        match.priceEvidence = `SPIKE DETECTED: ${(velocity * 100).toFixed(1)}% Velocity on ${match.outcomes[idx]}`;
        
        this.emit('inferredEvent', { 
            match, 
            tokenId, 
            outcomeIndex: idx, 
            newPrice, 
            velocity 
        });
      }

      this.emit('priceUpdate', {
        match,
        outcome: match.outcomes[idx],
        oldPrice,
        newPrice,
        change: velocity
      });
    }
  }

  public getLiveMatches(): SportsMatch[] {
    return Array.from(this.matches.values());
  }

  public forceLink(conditionId: string, matchId: string) {
      this.logger.info(`Force linking ${conditionId} to ${matchId}`);
  }
}