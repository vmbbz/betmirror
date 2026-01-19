import { EventEmitter } from 'events';
import { User } from '../database/index.js';
/**
 * Whale Filter Service - Centralized filtering hub for whale signals
 *
 * Purpose: Filter global whale signals based on user-specific preferences
 * Architecture: Single global poller + per-user filtering
 */
export class WhaleFilterService extends EventEmitter {
    userFilters = new Map();
    logger;
    constructor(logger) {
        super();
        this.logger = logger;
    }
    /**
     * Load user whale preferences from database
     */
    async loadUserPreferences(userId) {
        try {
            const user = await User.findOne({ address: userId }).select('whalePreferences').lean();
            return user?.whalePreferences || null;
        }
        catch (error) {
            this.logger.error(`Failed to load whale preferences for ${userId}: ${error}`);
            return null;
        }
    }
    /**
     * Save user whale preferences to database
     */
    async saveUserPreferences(userId, whaleWallets) {
        try {
            await User.updateOne({ address: userId }, {
                whalePreferences: whaleWallets.map(w => w.toLowerCase())
            }, { upsert: true });
            this.logger.info(`Saved whale preferences for ${userId}: ${whaleWallets.length} wallets`);
        }
        catch (error) {
            this.logger.error(`Failed to save whale preferences for ${userId}: ${error}`);
            throw error;
        }
    }
    /**
     * Update user's whale filter (called from UI)
     */
    async updateUserFilters(userId, whaleWallets) {
        const normalizedWallets = whaleWallets.map(w => w.toLowerCase());
        this.userFilters.set(userId, new Set(normalizedWallets));
        // Save to database
        await this.saveUserPreferences(userId, normalizedWallets);
        // Emit filter update event
        this.emit('filter_updated', { userId, whaleWallets: normalizedWallets, action: 'updated' });
        this.logger.info(`Updated whale filter for ${userId}: ${normalizedWallets.length} wallets`);
    }
    /**
     * Get user's current whale filters
     */
    getUserFilters(userId) {
        const filters = this.userFilters.get(userId);
        return filters ? Array.from(filters) : [];
    }
    /**
     * Filter and route whale signal to matching users
     */
    async filterAndRoute(signal) {
        const trader = signal.trader?.toLowerCase();
        if (!trader) {
            return [];
        }
        const matchedUsers = [];
        const results = [];
        // Check each user's filters
        for (const [userId, whaleWallets] of this.userFilters) {
            const isMatch = whaleWallets.has(trader);
            if (isMatch) {
                matchedUsers.push(userId);
                results.push({
                    originalSignal: signal,
                    userId,
                    isMatch: true
                });
                // Emit filtered signal to specific user
                this.emit(`user_${userId}_whale_detected`, signal);
            }
        }
        // Log routing results
        if (matchedUsers.length > 0) {
            this.logger.info(`🐋 Whale signal routed to ${matchedUsers.length} users: ${trader.slice(0, 8)}...`);
        }
        return results;
    }
    /**
     * Initialize user filters from database on startup
     */
    async initializeUserFilters(userId) {
        const prefs = await this.loadUserPreferences(userId);
        if (prefs && prefs.length > 0) {
            this.userFilters.set(userId, new Set(prefs));
            this.logger.info(`Loaded whale filters for ${userId}: ${prefs.length} wallets`);
        }
    }
    /**
     * Remove user filters (cleanup)
     */
    removeUserFilters(userId) {
        this.userFilters.delete(userId);
        this.emit('filter_removed', { userId, action: 'removed' });
    }
    /**
     * Get all active user filters
     */
    getAllUserFilters() {
        const result = new Map();
        for (const [userId, wallets] of this.userFilters) {
            result.set(userId, Array.from(wallets));
        }
        return result;
    }
    /**
     * Check if user has whale filters configured
     */
    hasUserFilters(userId) {
        return this.userFilters.has(userId) && this.userFilters.get(userId).size > 0;
    }
}
