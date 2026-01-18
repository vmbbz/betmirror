import { MoneyMarketOpportunity } from '../database/index.js';
import axios from 'axios';
/**
 * Flash Detection Engine - Unified detection logic with HFT support
 */
export class FlashDetectionEngine {
    config;
    logger;
    priceHistory = new Map();
    volumeHistory = new Map();
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    /**
     * Process new price data and detect flash moves
     */
    async detectFlashMove(tokenId, currentPrice, currentVolume, bestBid, bestAsk) {
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
        if (history.length < 2)
            return null;
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
        if (microTriggered)
            strategy = 'micro-tick';
        else if (momentumTriggered)
            strategy = 'momentum';
        else if (volumeTriggered)
            strategy = 'volume';
        // Calculate risk score
        const riskScore = this.calculateRiskScore(velocity, momentum, volumeSpike);
        // Enrich metadata
        const metadata = await this.enrichMetadata(tokenId);
        const event = {
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
    calculateMomentum(history) {
        if (history.length < 3)
            return 0;
        const recent = history.slice(-3);
        const first = recent[0];
        const last = recent[recent.length - 1];
        const timeSpan = last.timestamp - first.timestamp;
        if (timeSpan === 0)
            return 0;
        const priceChange = last.price - first.price;
        return priceChange / timeSpan * 1000; // Normalize per second
    }
    /**
     * Calculate volume spike factor
     */
    calculateVolumeSpike(tokenId, currentVolume) {
        if (!currentVolume)
            return 0;
        const volHistory = this.volumeHistory.get(tokenId) || [];
        if (volHistory.length < 5)
            return 0;
        const recentAvg = volHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
        return currentVolume / recentAvg;
    }
    /**
     * Calculate confidence score based on multiple signals
     */
    calculateConfidence(velocity, momentum, volumeSpike, microVelocity) {
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
    calculateRiskScore(velocity, momentum, volumeSpike) {
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
    async enrichMetadata(tokenId) {
        try {
            // Check local cache first (fastest)
            const existingOpp = await MoneyMarketOpportunity.findOne({ tokenId });
            if (existingOpp) {
                return {
                    conditionId: existingOpp.marketId,
                    question: existingOpp.question,
                    image: existingOpp.image || '',
                    marketSlug: existingOpp.marketSlug || ''
                };
            }
            // Fallback to Gamma API
            const res = await axios.get(`https://gamma-api.polymarket.com/markets?token_id=${tokenId}`);
            if (res.data?.[0]) {
                const m = res.data[0];
                return {
                    conditionId: m.conditionId,
                    question: m.question,
                    image: m.image,
                    marketSlug: m.slug
                };
            }
            return {
                conditionId: '',
                question: `Market ${tokenId}`,
                image: '',
                marketSlug: ''
            };
        }
        catch (error) {
            this.logger.warn(`Failed to enrich metadata for ${tokenId}: ${error}`);
            return {
                conditionId: '',
                question: `Market ${tokenId}`,
                image: '',
                marketSlug: ''
            };
        }
    }
    /**
     * Clean up old data
     */
    cleanup() {
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
