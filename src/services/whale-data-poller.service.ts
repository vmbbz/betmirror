import { RuntimeEnv } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import { TradeSignal } from '../domain/trade.types.js';
import axios from 'axios';

interface WhaleDataPollerDeps {
    logger: Logger;
    env: RuntimeEnv;
    onDetectedTrade: (signal: TradeSignal) => Promise<void>;
}

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

export class WhaleDataPollerService {
    private readonly deps: WhaleDataPollerDeps;
    private running = false;
    private targetWallets: Set<string> = new Set();
    private pollInterval?: NodeJS.Timeout;
    private processedTrades: Map<string, number> = new Map();
    
    // Rate limiting: 200 requests / 10s = 20 req/s, we'll use 5 req/s to be safe
    private readonly POLL_INTERVAL_MS = 5000; // 5 seconds
    private readonly TRADES_PER_REQUEST = 100; // Max per request
    private readonly TRADE_TTL = 30 * 1000; // 30 seconds deduplication window
    
    constructor(deps: WhaleDataPollerDeps) {
        this.deps = deps;
    }

    /**
     * Update the list of whale wallets to monitor
     */
    public updateTargets(newTargets: string[]): void {
        this.targetWallets = new Set(newTargets.map(t => t.toLowerCase()));
        this.deps.logger.info(`🐋 Whale Data Poller: Now tracking ${this.targetWallets.size} wallets`);
    }

    /**
     * Start polling for whale trades
     */
    public async start(): Promise<void> {
        if (this.running) return;
        
        this.running = true;
        this.deps.logger.info('🐋 Starting Whale Data Poller (Data API)...');
        
        // Start polling loop
        this.pollInterval = setInterval(() => {
            if (this.running) {
                this.pollWhaleTrades();
            }
        }, this.POLL_INTERVAL_MS);
        
        // Do initial poll
        await this.pollWhaleTrades();
    }

    /**
     * Stop polling
     */
    public stop(): void {
        this.running = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
        this.processedTrades.clear();
        this.deps.logger.info('🐋 Whale Data Poller stopped');
    }

    /**
     * Check if service is running
     */
    public isActive(): boolean {
        return this.running;
    }

    /**
     * Poll trades for all target wallets
     */
    private async pollWhaleTrades(): Promise<void> {
        if (this.targetWallets.size === 0) return;

        const now = Date.now();
        const batchSize = Math.min(5, this.targetWallets.size); // Process 5 wallets at a time
        const wallets = Array.from(this.targetWallets).slice(0, batchSize);
        
        try {
            // Poll each wallet for recent trades
            const promises = wallets.map(wallet => this.pollWalletTrades(wallet));
            const results = await Promise.allSettled(promises);
            
            let totalTrades = 0;
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    totalTrades += result.value;
                }
            }
            
            if (totalTrades > 0) {
                this.deps.logger.debug(`🐋 Polled ${totalTrades} trades from ${wallets.length} wallets`);
            }
            
        } catch (error) {
            this.deps.logger.error(`🐋 Error polling whale trades: ${error}`);
        }
    }

    /**
     * Poll trades for a specific wallet
     */
    private async pollWalletTrades(wallet: string): Promise<number> {
        try {
            const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=${this.TRADES_PER_REQUEST}`;
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
            
            return processedCount;
            
        } catch (error) {
            // Rate limit or other errors - log but don't crash
            if (axios.isAxiosError(error) && error.response?.status === 429) {
                this.deps.logger.warn(`🐋 Rate limited for wallet ${wallet}`);
            } else {
                this.deps.logger.debug(`🐋 Error polling wallet ${wallet}: ${error}`);
            }
            return 0;
        }
    }

    /**
     * Process a single trade and emit signal if new
     */
    private async processTrade(trade: WhaleTrade, wallet: string): Promise<boolean> {
        // Normalize wallet address for comparison
        const traderAddress = trade.user?.address?.toLowerCase();
        if (!traderAddress || !this.targetWallets.has(traderAddress)) {
            return false;
        }

        // Create unique trade key for deduplication
        const tradeKey = `${trade.transactionHash}-${trade.token.tokenId}-${trade.side}`;
        const now = Date.now();
        
        // Skip if already processed
        if (this.processedTrades.has(tradeKey)) {
            const processedTime = this.processedTrades.get(tradeKey)!;
            if (now - processedTime < this.TRADE_TTL) {
                return false; // Skip duplicate within TTL
            }
        }
        
        // Mark as processed
        this.processedTrades.set(tradeKey, now);
        
        // Clean up old entries
        this.cleanupProcessedTrades();
        
        // Convert to TradeSignal format
        const signal: TradeSignal = {
            trader: traderAddress,
            marketId: "resolved_by_adapter",
            tokenId: trade.token.tokenId,
            outcome: (trade.token.outcome || "YES") as 'YES' | 'NO', 
            side: trade.side,
            sizeUsd: trade.size * trade.price,
            price: trade.price,
            timestamp: trade.timestamp * 1000 // Convert to milliseconds
        };

        this.deps.logger.success(`🚨 [WHALE DETECTED] ${traderAddress.slice(0, 10)}... ${trade.side} @ ${trade.price} (${trade.size} shares)`);
        
        // Emit signal
        try {
            await this.deps.onDetectedTrade(signal);
        } catch (error) {
            this.deps.logger.error(`🐋 Error processing whale signal: ${error}`);
        }
        
        return true;
    }

    /**
     * Clean up old processed trades to prevent memory leak
     */
    private cleanupProcessedTrades(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];
        
        for (const [key, timestamp] of this.processedTrades.entries()) {
            if (now - timestamp > this.TRADE_TTL * 2) { // Keep for 2x TTL
                expiredKeys.push(key);
            }
        }
        
        for (const key of expiredKeys) {
            this.processedTrades.delete(key);
        }
        
        if (expiredKeys.length > 0) {
            this.deps.logger.debug(`🐋 Cleaned up ${expiredKeys.length} expired trade entries`);
        }
    }
}
