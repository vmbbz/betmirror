import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.util.js';
import { WebSocketManager } from './websocket-manager.service.js';
import { FlashMove, MoneyMarketOpportunity } from '../database/index.js';
import { MarketMetadataService } from './market-metadata.service.js';
import axios from 'axios';

/**
 * Flash move detection strategies and configuration
 */
export interface FlashMoveConfig {
  // Detection thresholds
  velocityThreshold: number;        // 0.03 = 3%
  momentumThreshold: number;        // Price acceleration threshold
  volumeSpikeMultiplier: number;   // Volume spike factor
  
  // HFT thresholds
  microTickThreshold: number;       // Velocity threshold for 500ms window
  imbalanceThreshold: number;       // Bid/Ask imbalance multiplier (e.g. 5.0)
  
  // Execution parameters
  baseTradeSize: number;          // $50 default
  maxSlippagePercent: number;     // 2% default
  stopLossPercent: number;          // 10% default
  takeProfitPercent: number;       // 20% default
  
  // Risk management
  maxVolatilityPercent: number;     // 100% kill switch
  liquidityFloor: number;           // $1000 minimum
  maxConcurrentTrades: number;      // 3 concurrent max
  
  // Strategy selection
  preferredStrategy: 'aggressive' | 'conservative' | 'adaptive';
  enableLiquidityCheck: boolean;
  enableVolatilityKillSwitch: boolean;
}

/**
 * Flash move event with enhanced metadata
 */
export interface EnhancedFlashMoveEvent {
  tokenId: string;
  conditionId: string;
  oldPrice: number;
  newPrice: number;
  velocity: number;
  momentum: number;
  volumeSpike: number;
  confidence: number;
  timestamp: number;
  question?: string;
  image?: string;
  marketSlug?: string;
  riskScore: number;
  strategy: string;
  imbalance?: number; // Orderbook imbalance (Bid Vol / Ask Vol)
}

/**
 * Price history data point for analysis
 */
interface PriceDataPoint {
  price: number;
  timestamp: number;
  volume?: number;
  bestBid?: number;
  bestAsk?: number;
}

/**
 * Flash Detection Engine - Unified detection logic with HFT support
 */
export class FlashDetectionEngine {
  private priceHistory: Map<string, PriceDataPoint[]> = new Map();
  private volumeHistory: Map<string, number[]> = new Map();
  
  constructor(
    private config: FlashMoveConfig, 
    private logger: Logger,
    private marketMetadataService: MarketMetadataService
  ) {}
  
  /**
   * Process new price data and detect flash moves
   */
  public async detectFlashMove(
    tokenId: string, 
    currentPrice: number, 
    currentVolume?: number,
    bestBid?: number,
    bestAsk?: number
  ): Promise<EnhancedFlashMoveEvent | null> {
    const now = Date.now();
    
    // Update price history
    const history = this.priceHistory.get(tokenId) || [];
    history.push({ price: currentPrice, timestamp: now, bestBid, bestAsk });
    
    // Keep only last 100 data points for HFT analysis
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
    this.priceHistory.set(tokenId, history);
    
    // Update volume history
    if (currentVolume) {
      const volHistory = this.volumeHistory.get(tokenId) || [];
      volHistory.push(currentVolume);
      if (volHistory.length > 20) {
        volHistory.splice(0, volHistory.length - 20);
      }
      this.volumeHistory.set(tokenId, volHistory);
    }
    
    // Need at least 2 points for velocity calculation
    if (history.length < 2) return null;
    
    // --- HFT ANALYTICS: Micro-Tick Window (500ms) ---
    const microWindowSize = 500;
    const microOldest = history.find(p => now - p.timestamp < microWindowSize);
    let microVelocity = 0;
    if (microOldest && microOldest.price !== currentPrice) {
        microVelocity = (currentPrice - microOldest.price) / microOldest.price;
    }

    // --- ORDERBOOK IMBALANCE ---
    let imbalance = 1.0;
    if (bestBid && bestAsk) {
        // Since we only get best prices in the stream, we use bid/ask spread as proxy for pressure
        // In a true world-class system, we'd use L2 depth here
        imbalance = bestBid / bestAsk;
    }

    const oldest = history[0];
    const timeWindow = now - oldest.timestamp;
    
    // Calculate velocity (primary detection method)
    const velocity = (currentPrice - oldest.price) / oldest.price;
    
    // Calculate momentum (price acceleration)
    const momentum = this.calculateMomentum(history);
    
    // Calculate volume spike
    const volumeSpike = this.calculateVolumeSpike(tokenId, currentVolume);
    
    // Determine if any threshold is met (including HFT triggers)
    const velocityTriggered = Math.abs(velocity) >= this.config.velocityThreshold;
    const microTriggered = Math.abs(microVelocity) >= (this.config.microTickThreshold || 0.01);
    const momentumTriggered = Math.abs(momentum) >= this.config.momentumThreshold;
    const volumeTriggered = volumeSpike >= this.config.volumeSpikeMultiplier;
    
    if (!velocityTriggered && !momentumTriggered && !volumeTriggered && !microTriggered) {
      return null;
    }
    
    // Calculate confidence scoring
    const confidence = this.calculateConfidence(velocity, momentum, volumeSpike, microVelocity);
    
    // Determine strategy used
    let strategy = 'velocity';
    if (microTriggered) strategy = 'micro-tick';
    else if (momentumTriggered) strategy = 'momentum';
    else if (volumeTriggered) strategy = 'volume';
    
    // Calculate risk score
    const riskScore = this.calculateRiskScore(velocity, momentum, volumeSpike);
    
    // Enrich metadata
    const metadata = await this.enrichMetadata(tokenId);
    
    const event: EnhancedFlashMoveEvent = {
      tokenId,
      conditionId: metadata.conditionId,
      oldPrice: oldest.price,
      newPrice: currentPrice,
      velocity,
      momentum,
      volumeSpike,
      confidence,
      timestamp: now,
      question: metadata.question,
      image: metadata.image,
      marketSlug: metadata.marketSlug,
      riskScore,
      strategy,
      imbalance
    };
    
    this.logger.info(`🔴 FLASH MOVE DETECTED [${strategy}]: ${metadata.question || tokenId} (Velocity: ${(velocity * 100).toFixed(2)}%, Confidence: ${(confidence * 100).toFixed(1)}%)`);
    
    return event;
  }
  
  /**
   * Calculate price momentum (acceleration)
   */
  private calculateMomentum(history: PriceDataPoint[]): number {
    if (history.length < 3) return 0;
    
    const recent = history.slice(-3);
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    const timeSpan = last.timestamp - first.timestamp;
    if (timeSpan === 0) return 0;
    
    const priceChange = last.price - first.price;
    return priceChange / timeSpan * 1000; // Normalize per second
  }
  
  /**
   * Calculate volume spike factor
   */
  private calculateVolumeSpike(tokenId: string, currentVolume?: number): number {
    if (!currentVolume) return 0;
    
    const volHistory = this.volumeHistory.get(tokenId) || [];
    if (volHistory.length < 5) return 0;
    
    const recentAvg = volHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
    return currentVolume / recentAvg;
  }
  
  /**
   * Calculate confidence score based on multiple signals
   */
  private calculateConfidence(velocity: number, momentum: number, volumeSpike: number, microVelocity: number): number {
    let confidence = 0;
    
    // Micro-velocity (High weight for HFT)
    if (Math.abs(microVelocity) >= 0.01) {
        confidence += 0.5;
    }

    // Velocity confidence (30% weight)
    if (Math.abs(velocity) >= this.config.velocityThreshold) {
      confidence += 0.3;
    }
    
    // Momentum confidence (10% weight)
    if (Math.abs(momentum) >= this.config.momentumThreshold) {
      confidence += 0.1;
    }
    
    // Volume confidence (10% weight)
    if (volumeSpike >= this.config.volumeSpikeMultiplier) {
      confidence += 0.1;
    }
    
    return Math.min(confidence, 1.0);
  }
  
  /**
   * Calculate risk score for the flash move
   */
  private calculateRiskScore(velocity: number, momentum: number, volumeSpike: number): number {
    let risk = 0;
    
    // High velocity increases risk
    risk += Math.abs(velocity) * 2;
    
    // High momentum increases risk
    risk += Math.abs(momentum) * 1.5;
    
    // Volume spikes can indicate manipulation (higher risk)
    if (volumeSpike > 5) {
      risk += volumeSpike * 0.5;
    }
    
    return Math.min(risk, 100);
  }
  
  /**
   * Enrich flash move with market metadata
   */
  private async enrichMetadata(tokenId: string): Promise<{
    conditionId: string;
    question: string;
    image: string;
    marketSlug: string;
  }> {
    try {
      // Use unified MarketMetadataService for cache-first enrichment
      const metadata = await this.marketMetadataService.getMetadata(tokenId, true);
      if (metadata) {
        return {
          conditionId: metadata.conditionId,
          question: metadata.question,
          image: metadata.image || '',
          marketSlug: metadata.marketSlug || ''
        };
      }
      
      // Fallback to empty metadata if not found
      return {
        conditionId: '',
        question: 'Unknown Market',
        image: '',
        marketSlug: ''
      };
    } catch (error) {
      this.logger.error(`[FlashDetection] Failed to enrich metadata for ${tokenId}: ${error}`);
      return {
        conditionId: '',
        question: 'Unknown Market',
        image: '',
        marketSlug: ''
      };
    }
  }
  
  /**
   * Clean up old data
   */
  public cleanup(): void {
    const now = Date.now();
    const cutoff = now - 300000; // 5 minutes
    
    for (const [tokenId, history] of this.priceHistory.entries()) {
      const filtered = history.filter(point => point.timestamp > cutoff);
      this.priceHistory.set(tokenId, filtered);
    }
    
    for (const [tokenId, volHistory] of this.volumeHistory.entries()) {
      const filtered = volHistory.filter((_, index) => {
        const point = this.priceHistory.get(tokenId)?.[index];
        return point && point.timestamp > cutoff;
      });
      this.volumeHistory.set(tokenId, filtered);
    }
  }
}
