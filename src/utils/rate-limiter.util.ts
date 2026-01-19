/**
 * Rate Limiter Utility
 * 
 * Implements token bucket rate limiting for API calls to respect Polymarket limits:
 * - /markets/0x: 50 req/10s
 * - /trades: 200 req/10s  
 * - POST /order: 3500 req/10s burst, 36000/10min sustained
 */

export class RateLimiter {
    private queue: Array<() => Promise<any>> = [];
    private processing = false;
    private lastRequestTime = 0;
    
    constructor(
        private requestsPerWindow: number = 40, // Stay under limits
        private windowMs: number = 10000
    ) {}

    async add<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try { 
                    resolve(await fn()); 
                } catch (e) { 
                    reject(e); 
                }
            });
            this.process();
        });
    }

    private async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const timeSinceLastWindow = now - this.lastRequestTime;
            
            // Wait for next window if we've hit the limit
            if (timeSinceLastWindow < this.windowMs) {
                const batch = this.queue.splice(0, this.requestsPerWindow);
                
                // Process batch in parallel but respect the window
                await Promise.all(batch.map(fn => fn()));
                
                // Wait for the next window
                if (this.queue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.windowMs - timeSinceLastWindow));
                }
            } else {
                // Start new window
                this.lastRequestTime = now;
            }
        }
        
        this.processing = false;
    }
}

// Pre-configured limiters for different endpoints
export const MARKET_RATE_LIMITER = new RateLimiter(40, 10000); // 40 req/10s (under 50 limit)
export const TRADES_RATE_LIMITER = new RateLimiter(180, 10000); // 180 req/10s (under 200 limit)
export const ORDER_RATE_LIMITER = new RateLimiter(3000, 10000); // 3000 req/10s (under 3500 burst)
