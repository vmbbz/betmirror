import { JsonRpcProvider } from 'ethers';
/**
 * SHARED PROVIDER FACTORY - Enterprise-grade connection management
 *
 * Purpose: Eliminate duplicate JsonRpcProvider instances and provide
 * centralized connection pooling with health monitoring and auto-cleanup.
 */
export class ProviderFactory {
    static sharedProvider = null;
    static initializationPromise = null;
    static connectionCount = 0;
    static lastHealthCheck = 0;
    static HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
    /**
     * Get shared provider with lazy initialization
     */
    static async getSharedProvider(rpcUrl) {
        // If already initializing, wait for it
        if (this.initializationPromise) {
            return this.initializationPromise;
        }
        // Return existing if healthy and has connections
        if (this.sharedProvider && this.connectionCount > 0 && this.isHealthy()) {
            this.connectionCount++;
            return this.sharedProvider;
        }
        // Initialize once with proper config
        this.initializationPromise = this.initializeProvider(rpcUrl);
        return this.initializationPromise;
    }
    /**
     * Initialize shared provider with robust configuration
     */
    static async initializeProvider(rpcUrl) {
        const network = { chainId: 137, name: 'polygon' };
        const url = rpcUrl || process.env.RPC_URL || 'https://polygon-rpc.com';
        this.sharedProvider = new JsonRpcProvider(url, network, {
            staticNetwork: true,
            batchMaxCount: 10, // Reduce RPC calls
            polling: false, // Use WebSocket for real-time data
            cacheTimeout: 10000 // Cache responses for 10s
        });
        // Health check with timeout
        const networkPromise = this.sharedProvider.getNetwork();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("RPC Timeout")), 5000));
        await Promise.race([networkPromise, timeoutPromise]);
        this.connectionCount = 1;
        this.lastHealthCheck = Date.now();
        console.log(`✅ Shared Provider initialized: ${url}`);
        return this.sharedProvider;
    }
    /**
     * Release connection reference
     */
    static releaseConnection() {
        this.connectionCount = Math.max(0, this.connectionCount - 1);
        // Schedule cleanup after delay (for connection reuse)
        setTimeout(() => {
            if (this.connectionCount === 0) {
                this.cleanup();
            }
        }, 5000);
    }
    /**
     * Force cleanup of shared provider
     */
    static forceCleanup() {
        this.connectionCount = 0;
        this.cleanup();
    }
    /**
     * Internal cleanup method
     */
    static cleanup() {
        if (this.sharedProvider) {
            console.log('🧹 Shared Provider cleaned up');
            this.sharedProvider = null;
        }
        this.initializationPromise = null;
    }
    /**
     * Check if provider is healthy
     */
    static isHealthy() {
        return Date.now() - this.lastHealthCheck < this.HEALTH_CHECK_INTERVAL;
    }
    /**
     * Get connection status
     */
    static getStatus() {
        return {
            isConnected: this.sharedProvider !== null && this.isHealthy(),
            connectionCount: this.connectionCount,
            lastHealthCheck: this.lastHealthCheck
        };
    }
    /**
     * Manual health check
     */
    static async healthCheck() {
        if (!this.sharedProvider)
            return false;
        try {
            await this.sharedProvider.getNetwork();
            this.lastHealthCheck = Date.now();
            return true;
        }
        catch (error) {
            console.warn('Provider health check failed:', error);
            this.cleanup();
            return false;
        }
    }
}
