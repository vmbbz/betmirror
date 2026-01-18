import { RuntimeEnv } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import { TradeSignal } from '../domain/trade.types.js';
import { EventEmitter } from 'events';
import axios from 'axios';

interface WhaleTrade {
    user: {
        address: string;
    };
    token: {
        tokenId: string;
        outcome: string;
    };
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    timestamp: number;
    transactionHash: string;
}

/**
 * GLOBAL Whale Data Poller - Single Instance for All Bots
 * 
 * This service maintains ONE polling instance that serves ALL bot instances.
 * Prevents API waste and rate limit issues.
 */
export class GlobalWhalePollerService extends EventEmitter {
    private static instance: GlobalWhalePollerService;
    private logger: Logger;
    private running = false;
    private targetWallets: Set<string> = new Set();
    private pollInterval?: NodeJS.Timeout;
    private processedTrades: Map<string, number> = new Map(); // tradeHash -> timestamp
    private readonly POLL_INTERVAL_MS = 2000; // 2 seconds
    readonly TRADES_PER_REQUEST = 50;
    readonly API_BASE_URL = 'https://data-api.polymarket.com/trades';
    readonly DEDUPE_TTL_MS = 30000; // 30 seconds

    private constructor(logger: Logger) {
        super();
        this.logger = logger;
    }

    /**
     * Get singleton instance
     */
    static getInstance(logger?: Logger): GlobalWhalePollerService {
        if (!GlobalWhalePollerService.instance) {
            if (!logger) {
                throw new Error('Logger required for first initialization');
            }
            GlobalWhalePollerService.instance = new GlobalWhalePollerService(logger);
        }
        return GlobalWhalePollerService.instance;
    }

    /**
     * Update whale watchlist for ALL bots
     */
    updateTargets(wallets: string[]): void {
        this.targetWallets.clear();
        wallets.forEach(addr => this.targetWallets.add(addr.toLowerCase()));
        this.logger.info(`🐋 [GLOBAL] Whale poller tracking ${this.targetWallets.size} wallets`);
    }

    /**
     * Start the global polling service
     */
    async start(): Promise<void> {
        if (this.running) {
            this.logger.warn('🐋 [GLOBAL] Whale poller already running');
            return;
        }

        if (this.targetWallets.size === 0) {
            this.logger.warn('🐋 [GLOBAL] No whale targets configured, skipping start');
            return;
        }

        this.running = true;
        this.logger.success(`🐋 [GLOBAL] Starting whale poller for ${this.targetWallets.size} wallets`);

        // Start polling
        this.pollInterval = setInterval(() => {
            this.pollAllWallets();
        }, this.POLL_INTERVAL_MS);

        // Initial poll
        await this.pollAllWallets();
    }

    /**
     * Stop the global polling service
     */
    stop(): void {
        if (!this.running) return;

        this.running = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
        this.logger.warn('🐋 [GLOBAL] Whale poller stopped');
    }

    /**
     * Check if service is active
     */
    isActive(): boolean {
        return this.running;
    }

    /**
     * Poll trades for all target wallets
     */
    private async pollAllWallets(): Promise<void> {
        if (!this.running || this.targetWallets.size === 0) return;

        const now = Date.now();
        const walletArray = Array.from(this.targetWallets);

        // Process wallets in batches to respect rate limits
        const batchSize = 3; // Process 3 wallets per interval
        const startIndex = Math.floor((now / this.POLL_INTERVAL_MS) % Math.ceil(walletArray.length / batchSize)) * batchSize;
        const batch = walletArray.slice(startIndex, startIndex + batchSize);

        this.logger.debug(`🐋 [GLOBAL] Polling batch: ${batch.join(', ')}`);

        const promises = batch.map(wallet => this.pollWalletTrades(wallet));
        await Promise.allSettled(promises);

        // Cleanup old processed trades
        this.cleanupProcessedTrades();
    }

    /**
     * Poll trades for a specific wallet
     */
    private async pollWalletTrades(wallet: string): Promise<number> {
        try {
            const url = `${this.API_BASE_URL}?user=${wallet}&limit=${this.TRADES_PER_REQUEST}`;
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'PolymarketTradingBot/1.0'
                }
            });
            
            if (!response.data || !Array.isArray(response.data)) {
                return 0;
            }
            
            let processedCount = 0;
            for (const trade of response.data) {
                if (await this.processTrade(trade, wallet)) {
                    processedCount++;
                }
            }
            
            if (processedCount > 0) {
                this.logger.info(`🐋 [GLOBAL] ${wallet}: ${processedCount} new trades`);
            }
            
            return processedCount;
        } catch (error) {
            this.logger.error(`🐋 [GLOBAL] Failed to poll ${wallet}: ${error}`);
            return 0;
        }
    }

    /**
     * Process a single whale trade
     */
    private async processTrade(trade: WhaleTrade, wallet: string): Promise<boolean> {
        const tradeKey = `${trade.transactionHash}_${trade.token.tokenId}`;
        const now = Date.now();

        // Deduplication check
        if (this.processedTrades.has(tradeKey)) {
            const processedTime = this.processedTrades.get(tradeKey)!;
            if (now - processedTime < this.DEDUPE_TTL_MS) {
                return false; // Skip duplicate
            }
        }

        // Mark as processed
        this.processedTrades.set(tradeKey, now);

        // Create trade signal
        const signal: TradeSignal = {
            trader: trade.user.address,
            marketId: '', // Will be filled by bot engine
            tokenId: trade.token.tokenId,
            outcome: trade.token.outcome as 'YES' | 'NO',
            side: trade.side,
            price: trade.price,
            sizeUsd: trade.size * trade.price,
            timestamp: new Date(trade.timestamp).getTime()
        };

        // Emit to ALL listening bot engines
        this.emit('whale_trade_detected', signal);
        this.logger.info(`🐋 [GLOBAL] Whale detected: ${trade.user.address.slice(0, 8)}... ${trade.side} ${trade.size} @ ${trade.price}`);

        return true;
    }

    /**
     * Clean up old processed trades
     */
    private cleanupProcessedTrades(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];

        for (const [key, timestamp] of this.processedTrades.entries()) {
            if (now - timestamp > this.DEDUPE_TTL_MS) {
                expiredKeys.push(key);
            }
        }

        expiredKeys.forEach(key => this.processedTrades.delete(key));
        
        if (expiredKeys.length > 0) {
            this.logger.debug(`🐋 [GLOBAL] Cleaned up ${expiredKeys.length} expired trade records`);
        }
    }
}
