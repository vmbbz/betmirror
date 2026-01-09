import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import EventEmitter from 'events';
import WebSocket from 'ws';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_RECONNECT_DELAY = 5000; // Start with 5s delay
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 30000; // 30 seconds
const PONG_TIMEOUT = 10000; // 10 seconds

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
  marketPrice?: number;  // Added to track derived market price
}

export class SportsIntelService extends EventEmitter {
  private isPolling = false;
  
  public get isActive(): boolean {
    return this.isPolling;
  }
  
  private discoveryInterval?: NodeJS.Timeout;
  private pingInterval?: NodeJS.Timeout;
  private matches: Map<string, SportsMatch> = new Map();
  private ws?: WebSocket;
  private subscribedTokens: Set<string> = new Set();
  private reconnectAttempts = 0;
  private lastPong = Date.now();
  private pongTimeout?: NodeJS.Timeout;
  private isManuallyClosed = false;

  constructor(private logger: Logger) {
    super();
  }

  public async start() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.logger.info("⚽ Sports Intel: Starting...");

    await this.discoverSportsMarkets();
    
    // Only start WebSocket in non-build environments
    if (process.env.NODE_ENV !== 'production' || process.env.IS_BUILD !== 'true') {
      this.connectWebSocket();
    } else {
      this.logger.info('Skipping WebSocket connection in build environment');
    }
    
    // Re-discover every 30s for new markets
    this.discoveryInterval = setInterval(() => this.discoverSportsMarkets(), 30000);
  }

  public stop() {
    this.isPolling = false;
    this.isManuallyClosed = true;
    this.cleanupWebSocket();
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
  }

  private cleanupWebSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = undefined;
    }
  }

  private async discoverSportsMarkets() {
    try {
      // tag_id=100639 = Soccer game bets
      const url = `${GAMMA_BASE}/events?active=true&closed=false&tag_id=100639&order=startTime&ascending=true&limit=50`;
      const response = await axios.get(url);

      if (!response.data?.length) return;

      for (const event of response.data) {
        const market = event.markets?.[0];
        if (!market?.clobTokenIds || !market?.conditionId) continue;

        const tokenIds: string[] = JSON.parse(market.clobTokenIds);
        const outcomes: string[] = JSON.parse(market.outcomes);
        const outcomePrices: number[] = JSON.parse(market.outcomePrices).map(Number);

        // Skip if already tracked
        if (this.matches.has(market.conditionId)) {
          // Update prices only
          const existing = this.matches.get(market.conditionId)!;
          existing.outcomePrices = outcomePrices;
          continue;
        }

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
        };

        this.matches.set(market.conditionId, matchData);

        // Subscribe all tokens to WebSocket
        tokenIds.forEach(tid => {
          if (!this.subscribedTokens.has(tid)) {
            this.subscribeToken(tid);
          }
        });
      }

      this.logger.info(`📊 Tracking ${this.matches.size} soccer markets`);
    } catch (e: any) {
      this.logger.error(`Discovery error: ${e.message}`);
    }
  }

  private connectWebSocket(attempt = 0) {
    // Prevent WebSocket connection in build environment
    if (process.env.IS_BUILD === 'true') {
      this.logger.info('Skipping WebSocket connection in build environment');
      return;
    }

    if (this.isManuallyClosed || attempt >= MAX_RECONNECT_ATTEMPTS) {
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        this.logger.error('Max reconnection attempts reached. Please check your network connection.');
      }
      return;
    }

    this.cleanupWebSocket();
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.lastPong = Date.now();
      this.logger.info('🔌 WebSocket connected');
      
      // Re-subscribe existing tokens
      this.subscribedTokens.forEach(tid => this.subscribeToken(tid));
      
      // Start keepalive
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => this.sendPing(), PING_INTERVAL);
      
      // Set up pong timeout
      this.setupPongTimeout();
    });

    this.ws.on('pong', () => {
      this.lastPong = Date.now();
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      this.setupPongTimeout();
    });

    this.ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'PONG') {
        this.lastPong = Date.now();
        return;
      }

      try {
        const parsed = JSON.parse(msg);
        this.handlePriceUpdate(parsed);
      } catch (error: unknown) {
        this.logger.error('Error parsing WebSocket message:', error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.ws.on('close', () => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.pongTimeout) clearTimeout(this.pongTimeout);
      
      if (!this.isManuallyClosed) {
        const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(2, attempt), 30000);
        const jitter = Math.random() * 2000; // Add up to 2s jitter
        this.logger.warn(`WebSocket closed. Reconnecting in ${Math.round((delay + jitter) / 1000)}s... (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);
        
        setTimeout(() => this.connectWebSocket(attempt + 1), delay + jitter);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });
  }

  private sendPing() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.ping();
      } catch (error: unknown) {
        this.logger.error('Error sending ping:', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private setupPongTimeout() {
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
    
    this.pongTimeout = setTimeout(() => {
      const timeSinceLastPong = Date.now() - this.lastPong;
      if (timeSinceLastPong > PONG_TIMEOUT * 2) {
        this.logger.warn('No pong received, forcing reconnect...');
        this.cleanupWebSocket();
        this.connectWebSocket(this.reconnectAttempts);
      }
    }, PONG_TIMEOUT);
  }

  private subscribeToken(tokenId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
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

      // Emit price change event
      this.emit('priceUpdate', {
        match,
        outcome: match.outcomes[idx],
        oldPrice,
        newPrice,
        change: oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0
      });
    }
  }

  public getLiveMatches(): SportsMatch[] {
    return Array.from(this.matches.values());
  }
}