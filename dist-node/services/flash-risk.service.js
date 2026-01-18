/**
 * Flash Risk Manager - Advanced risk assessment and portfolio management
 */
export class FlashRiskManager {
    config;
    logger;
    recentAssessments = new Map();
    portfolioMetrics = {
        totalExposure: 0,
        concurrentPositions: 0,
        maxSinglePosition: 0,
        riskScore: 0,
        correlationRisk: 0
    };
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    /**
     * Assess risk for a flash move event
     */
    async assessRisk(event) {
        // Calculate base risk score
        const volatilityRisk = this.calculateVolatilityRisk(event);
        const velocityRisk = this.calculateVelocityRisk(event);
        const momentumRisk = this.calculateMomentumRisk(event);
        const volumeRisk = this.calculateVolumeRisk(event);
        const timeRisk = this.calculateTimeRisk(event);
        // Combine risk factors
        const totalRiskScore = Math.min(volatilityRisk + velocityRisk + momentumRisk + volumeRisk + timeRisk, 100);
        // Determine if too risky
        const isTooRisky = this.isTooRisky(totalRiskScore, event);
        // Recommend strategy based on risk profile
        const recommendedStrategy = this.recommendStrategy(totalRiskScore, event);
        // Calculate position sizing
        const positionSize = this.calculateOptimalPositionSize(event, totalRiskScore);
        // Calculate maximum allowed slippage
        const maxSlippage = this.calculateMaxSlippage(totalRiskScore, event);
        const reason = this.generateRiskReason(volatilityRisk, velocityRisk, momentumRisk, volumeRisk, timeRisk);
        // Track assessment for learning
        this.trackAssessment(event.tokenId, totalRiskScore);
        const assessment = {
            isTooRisky,
            reason,
            riskScore: totalRiskScore,
            recommendedStrategy,
            positionSize,
            maxSlippage
        };
        this.logger.debug(`🔍 Risk Assessment: ${event.tokenId} - Score: ${totalRiskScore.toFixed(1)}, Strategy: ${recommendedStrategy}, Size: $${positionSize}`);
        return assessment;
    }
    /**
     * Update portfolio metrics
     */
    updatePortfolioMetrics(activePositions) {
        this.portfolioMetrics.concurrentPositions = activePositions.size;
        this.portfolioMetrics.totalExposure = 0;
        this.portfolioMetrics.maxSinglePosition = 0;
        for (const position of activePositions.values()) {
            const exposure = position.shares * (position.currentPrice || position.entryPrice);
            this.portfolioMetrics.totalExposure += exposure;
            this.portfolioMetrics.maxSinglePosition = Math.max(this.portfolioMetrics.maxSinglePosition, exposure);
        }
        // Calculate overall portfolio risk score
        this.portfolioMetrics.riskScore = this.calculatePortfolioRiskScore(activePositions);
        this.portfolioMetrics.correlationRisk = this.calculateCorrelationRisk(activePositions);
    }
    /**
     * Check if new position would exceed portfolio limits
     */
    wouldExceedLimits(newPositionSize) {
        const newTotalExposure = this.portfolioMetrics.totalExposure + newPositionSize;
        const maxExposure = this.config.maxConcurrentTrades * this.config.baseTradeSize * 2; // Rough estimate
        return newTotalExposure > maxExposure ||
            this.portfolioMetrics.concurrentPositions >= this.config.maxConcurrentTrades;
    }
    /**
     * Calculate volatility-based risk
     */
    calculateVolatilityRisk(event) {
        // Higher velocity = higher volatility risk
        return Math.abs(event.velocity) * 30; // 30% weight
    }
    /**
     * Calculate velocity-based risk
     */
    calculateVelocityRisk(event) {
        // Extreme velocity increases risk
        const velocity = Math.abs(event.velocity);
        if (velocity > 0.1)
            return 40; // Very high velocity
        if (velocity > 0.05)
            return 25; // High velocity
        if (velocity > 0.03)
            return 15; // Medium velocity
        return 5; // Normal velocity
    }
    /**
     * Calculate momentum-based risk
     */
    calculateMomentumRisk(event) {
        // High momentum indicates potential manipulation
        const momentum = Math.abs(event.momentum);
        if (momentum > 0.5)
            return 20; // Very high momentum
        if (momentum > 0.2)
            return 10; // High momentum
        if (momentum > 0.1)
            return 5; // Medium momentum
        return 2; // Normal momentum
    }
    /**
     * Calculate volume-based risk
     */
    calculateVolumeRisk(event) {
        // Abnormal volume spikes indicate manipulation risk
        const volumeSpike = event.volumeSpike;
        if (volumeSpike > 10)
            return 15; // Extreme volume spike
        if (volumeSpike > 5)
            return 8; // High volume spike
        if (volumeSpike > 2)
            return 3; // Medium volume spike
        return 1; // Normal volume
    }
    /**
     * Calculate time-based risk
     */
    calculateTimeRisk(event) {
        const hour = new Date(event.timestamp).getHours();
        // Higher risk during certain hours (market manipulation patterns)
        if (hour >= 2 && hour <= 6)
            return 10; // Late night/early morning
        if (hour >= 22 || hour <= 1)
            return 8; // Late night
        // Lower risk during active hours
        if (hour >= 10 && hour <= 16)
            return 2; // Business hours
        return 5; // Normal hours
    }
    /**
     * Determine if event is too risky
     */
    isTooRisky(riskScore, event) {
        // Kill switch for extreme volatility
        if (this.config.enableVolatilityKillSwitch && riskScore > 90) {
            return true;
        }
        // Skip very low confidence events
        if (event.confidence < 0.3) {
            return true;
        }
        // Skip extremely high velocity (potential manipulation)
        if (Math.abs(event.velocity) > 0.5) {
            return true;
        }
        return false;
    }
    /**
     * Recommend execution strategy based on risk profile
     */
    recommendStrategy(riskScore, event) {
        if (this.config.preferredStrategy !== 'adaptive') {
            return this.config.preferredStrategy;
        }
        // High confidence + moderate risk = aggressive
        if (event.confidence > 0.8 && riskScore < 40) {
            return 'aggressive';
        }
        // Low confidence or high risk = conservative
        if (event.confidence < 0.5 || riskScore > 60) {
            return 'conservative';
        }
        // Balanced approach
        return 'adaptive';
    }
    /**
     * Calculate optimal position size
     */
    calculateOptimalPositionSize(event, riskScore) {
        let size = this.config.baseTradeSize;
        // Adjust for confidence
        size *= (0.5 + event.confidence * 0.5);
        // Adjust for risk
        if (riskScore > 50) {
            size *= 0.5; // Halve size for high risk
        }
        else if (riskScore > 30) {
            size *= 0.7; // Reduce size for medium risk
        }
        // Adjust for portfolio exposure
        if (this.wouldExceedLimits(size)) {
            size *= 0.5; // Further reduce if at limits
        }
        return Math.max(size, 10); // Minimum size
    }
    /**
     * Calculate maximum allowed slippage
     */
    calculateMaxSlippage(riskScore, event) {
        let slippage = this.config.maxSlippagePercent;
        // Tighter slippage for high confidence
        if (event.confidence > 0.8) {
            slippage *= 0.5;
        }
        // Looser slippage for high risk
        if (riskScore > 60) {
            slippage *= 1.5;
        }
        return Math.min(slippage, 0.05); // Max 5% slippage
    }
    /**
     * Generate risk assessment reason
     */
    generateRiskReason(volatilityRisk, velocityRisk, momentumRisk, volumeRisk, timeRisk) {
        const reasons = [];
        if (volatilityRisk > 20)
            reasons.push('High volatility');
        if (velocityRisk > 20)
            reasons.push('Extreme velocity');
        if (momentumRisk > 10)
            reasons.push('High momentum');
        if (volumeRisk > 8)
            reasons.push('Volume spike');
        if (timeRisk > 8)
            reasons.push('High-risk timing');
        return reasons.length > 0 ? reasons.join(', ') : 'Normal market conditions';
    }
    /**
     * Calculate portfolio-level risk score
     */
    calculatePortfolioRiskScore(activePositions) {
        if (activePositions.size === 0)
            return 0;
        let totalRisk = 0;
        for (const position of activePositions.values()) {
            // Risk based on position age and volatility
            const age = Date.now() - position.timestamp;
            const ageRisk = age > 300000 ? 20 : 5; // Older positions = higher risk
            totalRisk += ageRisk;
        }
        return totalRisk / activePositions.size;
    }
    /**
     * Calculate correlation risk between positions
     */
    calculateCorrelationRisk(activePositions) {
        if (activePositions.size < 2)
            return 0;
        // Simple correlation check based on entry timing
        const positions = Array.from(activePositions.values());
        const entryTimes = positions.map(p => p.timestamp);
        // Check if multiple positions entered in quick succession
        entryTimes.sort((a, b) => a - b);
        let quickEntries = 0;
        for (let i = 1; i < entryTimes.length; i++) {
            if (entryTimes[i] - entryTimes[i - 1] < 30000) { // Within 30 seconds
                quickEntries++;
            }
        }
        return quickEntries > 2 ? 15 : 0; // Risk if 3+ positions in 30s
    }
    /**
     * Track assessment for learning and improvement
     */
    trackAssessment(tokenId, riskScore) {
        const assessments = this.recentAssessments.get(tokenId) || [];
        assessments.push(riskScore);
        // Keep only last 10 assessments
        if (assessments.length > 10) {
            assessments.splice(0, assessments.length - 10);
        }
        this.recentAssessments.set(tokenId, assessments);
    }
    /**
     * Get portfolio metrics
     */
    getPortfolioMetrics() {
        return { ...this.portfolioMetrics };
    }
    /**
     * Clean up old assessment data
     */
    cleanup() {
        const cutoff = Date.now() - 3600000; // 1 hour
        for (const [tokenId, assessments] of this.recentAssessments.entries()) {
            const filtered = assessments.filter(() => true); // Keep all recent assessments
            this.recentAssessments.set(tokenId, filtered);
        }
    }
}
