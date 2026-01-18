import { LiquidityHealth } from '../interfaces.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { JsonRpcProvider, Contract, formatUnits, Interface, ethers } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { User, Trade, MarketMetadata as DBMarketMetadata } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';
const HOST_URL = 'https://clob.polymarket.com';
const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
var SignatureType;
(function (SignatureType) {
    SignatureType[SignatureType["EOA"] = 0] = "EOA";
    SignatureType[SignatureType["POLY_PROXY"] = 1] = "POLY_PROXY";
    SignatureType[SignatureType["POLY_GNOSIS_SAFE"] = 2] = "POLY_GNOSIS_SAFE";
})(SignatureType || (SignatureType = {}));
export class PolymarketAdapter {
    static publicClient = null;
    static PUBLIC_CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    static publicClientCreatedAt = 0;
    // SHARED PROVIDER: Prevent detectNetwork overhead for every bot instance
    static sharedProvider = null;
    config;
    client = null;
    logger;
    walletV5;
    walletV6;
    provider;
    safeAddress;
    usdcContract = null;
    lastTokenIdCheck = new Map();
    TOKEN_ID_CHECK_COOLDOWN = 60000; // 1 minute
    invalidTokenIds = new Set();
    // Additional properties needed for initialization
    walletService;
    safeManager;
    // Static caches for shared state across all instances
    static metadataCache = new Map();
    static METADATA_TTL = 24 * 60 * 60 * 1000; // 24 hours
    static isThrottled = false;
    static throttleExpiry = 0;
    static positionCache = new Map();
    static POSITION_CACHE_TTL = 30000; // 30 seconds
    // Required by IExchangeAdapter
    exchangeName = 'Polymarket';
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    /**
     * Get or create cached public client for non-authenticated API calls
     */
    getPublicClient() {
        const now = Date.now();
        // Create new client if cache expired or doesn't exist
        if (!PolymarketAdapter.publicClient ||
            (now - PolymarketAdapter.publicClientCreatedAt) > PolymarketAdapter.PUBLIC_CLIENT_CACHE_TTL) {
            PolymarketAdapter.publicClient = new ClobClient(HOST_URL, Chain.POLYGON);
            PolymarketAdapter.publicClientCreatedAt = now;
            this.logger.debug('Created new public client instance');
        }
        return PolymarketAdapter.publicClient;
    }
    async initialize() {
        const walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        if (this.config.walletConfig.encryptedPrivateKey) {
            this.walletV6 = await walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
            this.walletV5 = await walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        }
        else {
            throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }
        const sdkAlignedAddress = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        this.safeAddress = sdkAlignedAddress;
        const safeManager = new SafeManagerService(this.walletV6, this.config.builderApiKey, this.config.builderApiSecret, this.config.builderApiPassphrase, this.logger, this.safeAddress);
        this.safeManager = safeManager; // CRITICAL: Set the safeManager instance
        // IMPLEMENT SHARED PROVIDER TO PREVENT RPC RATE LIMITING
        if (!PolymarketAdapter.sharedProvider) {
            try {
                // Use static network to avoid detectNetwork calls on every instance
                const network = { chainId: 137, name: 'polygon' };
                PolymarketAdapter.sharedProvider = new JsonRpcProvider(this.config.rpcUrl, network, { staticNetwork: true });
                // Verify once
                const networkCheck = await PolymarketAdapter.sharedProvider.getNetwork();
                this.logger.info(`✅ Shared RPC Provider initialized for network: ${networkCheck.name}`);
            }
            catch (e) {
                this.logger.warn(`⚠️ Primary RPC (${this.config.rpcUrl}) failed shared init. Using fallback: https://polygon-rpc.com`);
                const network = { chainId: 137, name: 'polygon' };
                PolymarketAdapter.sharedProvider = new JsonRpcProvider('https://polygon-rpc.com', network, { staticNetwork: true });
            }
        }
        this.provider = PolymarketAdapter.sharedProvider;
        const USDC_ABI_INTERNAL = [
            'function balanceOf(address owner) view returns (uint256)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function transfer(address to, uint256 amount) returns (bool)'
        ];
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI_INTERNAL, this.provider);
    }
    async validatePermissions() { return true; }
    async authenticate() {
        if (!this.walletV6 || !this.safeManager || !this.safeAddress)
            throw new Error("Adapter not initialized");
        await this.safeManager.deploySafe();
        await this.safeManager.enableApprovals();
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key || !apiCreds.secret) {
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials;
        }
        this.initClobClient(apiCreds);
    }
    initClobClient(apiCreds) {
        let builderConfig;
        if (this.config.builderApiKey && this.config.builderApiSecret && this.config.builderApiPassphrase) {
            builderConfig = new BuilderConfig({
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret,
                    passphrase: this.config.builderApiPassphrase
                }
            });
        }
        this.client = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, apiCreds, SignatureType.POLY_GNOSIS_SAFE, this.safeAddress, undefined, undefined, builderConfig);
    }
    getAuthHeaders() {
        if (!this.config.l2ApiCredentials)
            return {};
        return {
            'apiKey': this.config.l2ApiCredentials.key,
            'secret': this.config.l2ApiCredentials.secret,
            'passphrase': this.config.l2ApiCredentials.passphrase
        };
    }
    async deriveAndSaveKeys() {
        try {
            // Use POLY_GNOSIS_SAFE signature type to match trading signature
            const tempClient = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, undefined, SignatureType.POLY_GNOSIS_SAFE, this.safeAddress);
            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key)
                throw new Error("Empty keys returned");
            const apiCreds = { key: rawCreds.key, secret: rawCreds.secret, passphrase: rawCreds.passphrase };
            await User.findOneAndUpdate({ address: this.config.userId }, { "tradingWallet.l2ApiCredentials": apiCreds, "tradingWallet.safeAddress": this.safeAddress });
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('API Keys Derived');
        }
        catch (e) {
            throw e;
        }
    }
    async fetchBalance(address) {
        if (!this.usdcContract)
            return 0;
        try {
            const bal = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(bal, 6));
        }
        catch (e) {
            return 0;
        }
    }
    async getPortfolioValue(address) {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/value?user=${address}`);
            return parseFloat(res.data) || 0;
        }
        catch (e) {
            return 0;
        }
    }
    async getMarketPrice(marketId, tokenId, side = 'BUY') {
        // Use cached public client for better performance
        const client = this.client ?? this.getPublicClient();
        const isTradeable = await this.isMarketTradeable(marketId);
        if (!isTradeable) {
            return 0;
        }
        try {
            const priceRes = await client.getPrice(tokenId, side);
            return parseFloat(priceRes.price) || 0;
        }
        catch (e) {
            try {
                const mid = await client.getMidpoint(tokenId);
                return parseFloat(mid.mid) || 0;
            }
            catch (midErr) {
                return 0;
            }
        }
    }
    getEmptyOrderBook() {
        return {
            bids: [],
            asks: [],
            min_order_size: 5,
            tick_size: 0.01,
            neg_risk: false
        };
    }
    normalizeOrders(orders, sortOrder) {
        if (!Array.isArray(orders))
            return [];
        return orders
            .filter(order => order?.price !== undefined && order?.size !== undefined)
            .map(order => ({
            price: parseFloat(String(order.price)) || 0,
            size: parseFloat(String(order.size)) || 0
        }))
            .sort((a, b) => sortOrder === 'asc'
            ? a.price - b.price
            : b.price - a.price);
    }
    /**
     * PASSIVE METADATA RETRIEVAL:
     * We no longer hit the CLOB API for individual market metadata during live loops.
     * We check the DB (populated by the scanner) or memory cache.
     */
    async getMarket(marketId) {
        // Check memory cache first
        const cached = PolymarketAdapter.metadataCache.get(marketId);
        if (cached && (Date.now() - cached.ts < PolymarketAdapter.PUBLIC_CLIENT_CACHE_TTL)) {
            return cached.data;
        }
        try {
            // Check Database first
            const dbMeta = await DBMarketMetadata.findOne({ conditionId: marketId }).lean();
            if (dbMeta) {
                return dbMeta;
            }
            // Fallback only if absolutely necessary and not throttled
            if (PolymarketAdapter.isThrottled && Date.now() < PolymarketAdapter.throttleExpiry) {
                return null;
            }
            const client = this.client || this.getPublicClient();
            const market = await client.getMarket(marketId);
            if (market) {
                // Seed DB cache if missing
                await DBMarketMetadata.findOneAndUpdate({ conditionId: marketId }, {
                    conditionId: marketId,
                    question: market.question,
                    image: market.image,
                    marketSlug: market.market_slug,
                    closed: market.closed,
                    active: market.active,
                    acceptingOrders: market.accepting_orders
                }, { upsert: true });
                return market;
            }
        }
        catch (error) {
            if (error.response?.status === 429) {
                PolymarketAdapter.isThrottled = true;
                PolymarketAdapter.throttleExpiry = Date.now() + 60000;
            }
            return null;
        }
        return null;
    }
    isTokenIdValid(tokenId) {
        const now = Date.now();
        const lastCheck = this.lastTokenIdCheck.get(tokenId) || 0;
        if (this.invalidTokenIds.has(tokenId) && (now - lastCheck < this.TOKEN_ID_CHECK_COOLDOWN)) {
            return false;
        }
        if (this.invalidTokenIds.has(tokenId)) {
            this.invalidTokenIds.delete(tokenId);
        }
        return true;
    }
    async isMarketTradeable(conditionId) {
        try {
            if (!this.isTokenIdValid(conditionId))
                return false;
            const market = await this.getMarket(conditionId);
            if (!market)
                return false;
            const isTradeable = !!(market &&
                market.active &&
                !market.closed &&
                (market.accepting_orders || market.acceptingOrders) &&
                (market.enable_order_book || market.enable_order_book === undefined));
            return isTradeable;
        }
        catch (error) {
            return false;
        }
    }
    async getOrderBook(tokenId) {
        // Use cached public client for better performance
        const client = this.client ?? this.getPublicClient();
        const isTradeable = await this.isMarketTradeable(tokenId);
        if (!isTradeable)
            return this.getEmptyOrderBook();
        try {
            const book = await client.getOrderBook(tokenId);
            if (!book)
                return this.getEmptyOrderBook();
            return {
                bids: this.normalizeOrders(book.bids, 'desc'),
                asks: this.normalizeOrders(book.asks, 'asc'),
                min_order_size: book.min_order_size ? Number(book.min_order_size) : 5,
                tick_size: book.tick_size ? Number(book.tick_size) : 0.01,
                neg_risk: Boolean(book.neg_risk)
            };
        }
        catch (error) {
            return this.getEmptyOrderBook();
        }
    }
    async getLiquidityMetrics(tokenId, side) {
        if (!this.client)
            throw new Error("Not auth");
        const book = await this.getOrderBook(tokenId);
        const bestBid = book.bids.length > 0 ? book.bids[0].price : 0;
        const bestAsk = book.asks.length > 0 ? book.asks[0].price : 1;
        const spreadAbs = bestAsk - bestBid;
        const midpoint = (bestBid + bestAsk) / 2;
        const spreadPercent = midpoint > 0 ? (spreadAbs / midpoint) * 100 : 100;
        let depthUsd = 0;
        if (side === 'SELL') {
            depthUsd = book.bids.slice(0, 3).reduce((sum, b) => sum + (b.size * b.price), 0);
        }
        else {
            depthUsd = book.asks.slice(0, 3).reduce((sum, a) => sum + (a.size * a.price), 0);
        }
        let health = LiquidityHealth.CRITICAL;
        if (spreadAbs <= 0.02 && depthUsd >= 500) {
            health = LiquidityHealth.HIGH;
        }
        else if (spreadAbs <= 0.05 && depthUsd >= 100) {
            health = LiquidityHealth.MEDIUM;
        }
        else if (depthUsd >= 20) {
            health = LiquidityHealth.LOW;
        }
        return {
            health,
            spread: spreadAbs,
            spreadPercent,
            availableDepthUsd: depthUsd,
            bestPrice: side === 'SELL' ? bestBid : bestAsk
        };
    }
    async getNegRiskMarkets() {
        try {
            const res = await axios.get(`${HOST_URL}/markets?active=true&closed=false`);
            const markets = res.data?.data || [];
            return markets.filter((m) => m.neg_risk === true && m.tokens?.length > 1);
        }
        catch (e) {
            return [];
        }
    }
    async getSamplingMarkets() {
        // For public methods like getSamplingMarkets, create a public-only client if no authenticated client exists
        const client = this.getPublicClient();
        try {
            this.logger.info(`[DEBUG] Attempting getSamplingMarkets with public client...`);
            const response = await client.getSamplingMarkets();
            this.logger.info(`[DEBUG] getSamplingMarkets response: ${JSON.stringify(response?.data?.length || 0)} markets`);
            const markets = response?.data || [];
            const transformedMarkets = markets.map((market) => ({
                accepting_orders: market.accepting_orders !== false,
                active: market.active !== false,
                archived: market.archived === true,
                closed: market.closed === true,
                condition_id: market.condition_id,
                description: market.description || '',
                icon: market.icon || '',
                image: market.image || '',
                market_slug: market.market_slug || '',
                minimum_order_size: market.minimum_order_size || 5,
                minimum_tick_size: market.minimum_tick_size || 0.01,
                question: market.question || '',
                rewards: {
                    max_spread: market.rewards?.max_spread || 15,
                    min_size: market.rewards?.min_size || 10,
                    rates: market.rewards?.rates || null
                },
                tags: market.tags || [],
                tokens: market.tokens || []
            }));
            this.logger.info(`[DEBUG] Transformed ${transformedMarkets.length} markets successfully`);
            return { limit: response?.limit || transformedMarkets.length, count: response?.count || transformedMarkets.length, data: transformedMarkets };
        }
        catch (e) {
            this.logger.warn(`getSamplingMarkets failed: ${e.message}`);
            this.logger.warn(`[DEBUG] Error details: ${JSON.stringify(e?.response?.data || e)}`);
            return { limit: 0, count: 0, data: [] };
        }
    }
    getEmptySamplingPayload() {
        return { limit: 0, count: 0, data: [] };
    }
    // ============================================
    // POSITION & MARKET DATA METHODS (CACHED)
    // ============================================
    /**
     * 429 MITIGATION: Shared static cache to prevent hammering Polymarket.
     * Checks database first.
     */
    async fetchMarketSlugs(conditionId) {
        const cached = PolymarketAdapter.metadataCache.get(conditionId);
        if (cached && (Date.now() - cached.ts < PolymarketAdapter.METADATA_TTL))
            return cached.data;
        const result = { marketSlug: '', eventSlug: '', question: '', image: '', conditionId, acceptingOrders: true, closed: false };
        if (!conditionId)
            return result;
        try {
            // Passive DB-first check
            const dbMeta = await DBMarketMetadata.findOne({ conditionId }).lean();
            if (dbMeta) {
                result.marketSlug = dbMeta.marketSlug || '';
                result.question = dbMeta.question || '';
                result.image = dbMeta.image || '';
                result.acceptingOrders = dbMeta.acceptingOrders ?? true;
                result.closed = dbMeta.closed || false;
            }
            else if (!PolymarketAdapter.isThrottled) {
                // Active fetch only if not throttled
                const client = this.client || this.getPublicClient();
                const marketData = await client.getMarket(conditionId);
                if (marketData) {
                    result.marketSlug = marketData.market_slug || '';
                    result.question = marketData.question || '';
                    result.image = marketData.image || '';
                    result.acceptingOrders = marketData.accepting_orders ?? true;
                    result.closed = marketData.closed || false;
                    // Seed DB
                    await DBMarketMetadata.findOneAndUpdate({ conditionId }, {
                        conditionId,
                        question: marketData.question,
                        image: marketData.image,
                        marketSlug: marketData.market_slug,
                        closed: marketData.closed,
                        active: marketData.active,
                        acceptingOrders: marketData.accepting_orders
                    }, { upsert: true });
                }
            }
        }
        catch (e) { }
        if (result.question || result.marketSlug) {
            PolymarketAdapter.metadataCache.set(conditionId, { data: result, ts: Date.now() });
        }
        return result;
    }
    async getDbPositions() {
        try {
            const trades = await Trade.find({
                userId: this.config.userId,
                status: { $in: ['OPEN', 'CLOSED'] }
            }).lean();
            return trades.map((trade) => ({
                marketId: trade.conditionId || trade.marketId || '',
                conditionId: trade.conditionId || trade.marketId || '',
                tokenId: trade.tokenId || '',
                clobOrderId: trade.clobOrderId || trade.tokenId || '',
                outcome: trade.outcome || 'YES',
                balance: parseFloat(trade.size) || 0,
                valueUsd: parseFloat(trade.currentValueUsd) || 0,
                investedValue: parseFloat(trade.investedValue) || 0,
                entryPrice: parseFloat(trade.entryPrice) || 0,
                currentPrice: parseFloat(trade.currentPrice) || 0,
                unrealizedPnL: parseFloat(trade.unrealizedPnl) || 0,
                question: trade.metadata?.question || '',
                image: trade.metadata?.image || '',
                isResolved: trade.metadata?.isResolved || false,
                acceptingOrders: trade.metadata?.acceptingOrders ?? true,
                marketSlug: trade.marketSlug || '',
                eventSlug: trade.eventSlug || '',
                updatedAt: trade.updatedAt || new Date()
            }));
        }
        catch (error) {
            return [];
        }
    }
    async getMarketData(conditionId) {
        try {
            const marketSlugs = await this.fetchMarketSlugs(conditionId);
            if (marketSlugs.question || marketSlugs.marketSlug) {
                return {
                    accepting_orders: marketSlugs.acceptingOrders,
                    active: !marketSlugs.closed,
                    archived: false,
                    closed: marketSlugs.closed,
                    condition_id: conditionId,
                    description: marketSlugs.question || '',
                    icon: marketSlugs.image || '',
                    image: marketSlugs.image || '',
                    market_slug: marketSlugs.marketSlug || '',
                    minimum_order_size: 5,
                    minimum_tick_size: 0.01,
                    question: marketSlugs.question || `Market ${conditionId.slice(0, 10)}...`,
                    rewards: {
                        max_spread: 15,
                        min_size: 10,
                        rates: null
                    },
                    tags: [],
                    tokens: []
                };
            }
            return null;
        }
        catch (error) {
            return null;
        }
    }
    async updatePositionMetadata(marketId, metadata) {
        try {
            await Trade.updateMany({
                userId: this.config.userId,
                $or: [{ conditionId: marketId }, { marketId: marketId }]
            }, {
                $set: {
                    'metadata.question': metadata.question,
                    'metadata.image': metadata.image,
                    'metadata.isResolved': metadata.closed,
                    'metadata.acceptingOrders': metadata.accepting_orders,
                    'metadata.marketSlug': metadata.market_slug,
                    'metadata.eventSlug': metadata.market_slug,
                    updatedAt: new Date()
                }
            });
        }
        catch (error) {
            throw new Error(`Failed to update position metadata: ${error}`);
        }
    }
    async getPositions(address) {
        // --- GLOBAL THROTTLE CHECK ---
        if (PolymarketAdapter.isThrottled) {
            if (Date.now() < PolymarketAdapter.throttleExpiry) {
                return PolymarketAdapter.positionCache.get(address)?.data || [];
            }
            PolymarketAdapter.isThrottled = false;
        }
        try {
            const res = await axios.get(`https://data-api.polymarket.com/positions?user=${address}`);
            if (!Array.isArray(res.data))
                return [];
            const positions = [];
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0.01)
                    continue;
                const metadata = await this.fetchMarketSlugs(p.conditionId || '');
                const entry = parseFloat(p.avgPrice) || 0.5;
                const current = parseFloat(p.price) || 0.5;
                positions.push({
                    marketId: p.conditionId, conditionId: p.conditionId, tokenId: p.asset || '', clobOrderId: p.asset || '',
                    outcome: p.outcome || 'YES', balance: size, valueUsd: size * current,
                    investedValue: size * entry, entryPrice: entry, currentPrice: current,
                    unrealizedPnL: (size * current) - (size * entry),
                    question: metadata.question || `Market ${p.conditionId.slice(0, 10)}...`, image: metadata.image,
                    marketSlug: metadata.marketSlug, eventSlug: metadata.eventSlug, isResolved: metadata.closed, acceptingOrders: metadata.acceptingOrders
                });
            }
            PolymarketAdapter.positionCache.set(address, { data: positions, ts: Date.now() });
            return positions;
        }
        catch (e) {
            if (e.response?.status === 429) {
                this.logger.error(`🚨 429 Throttled. Activating Global Cool-Down (60s).`);
                PolymarketAdapter.isThrottled = true;
                PolymarketAdapter.throttleExpiry = Date.now() + 60000;
            }
            return PolymarketAdapter.positionCache.get(address)?.data || [];
        }
    }
    async fetchPublicTrades(address, limit = 20) {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`);
            if (!res.data || !Array.isArray(res.data))
                return [];
            return res.data
                .filter(act => act.type === 'TRADE' || act.type === 'ORDER_FILLED')
                .map(act => ({
                trader: address,
                marketId: act.conditionId,
                tokenId: act.asset,
                outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                side: act.side.toUpperCase(),
                sizeUsd: act.usdcSize || (act.size * act.price),
                price: act.price,
                timestamp: (act.timestamp > 1e11 ? act.timestamp : act.timestamp * 1000)
            }));
        }
        catch (e) {
            return [];
        }
    }
    async getTradeHistory(address, limit = 50) {
        return [];
    }
    async createOrder(params, retryCount = 0) {
        if (!this.client)
            throw new Error("Client not authenticated");
        try {
            const market = await this.client.getMarket(params.marketId);
            const tickSize = Number(market.minimum_tick_size) || 0.01;
            const minOrderSize = Number(market.minimum_order_size) || 5;
            if (params.side === 'BUY') {
                await this.ensureUsdcAllowance(market.neg_risk, params.sizeUsd);
            }
            else {
                await this.ensureOutcomeTokenApproval(market.neg_risk);
            }
            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            const price = params.priceLimit || 0.5;
            const size = Math.floor(params.sizeShares || (params.sizeUsd / price));
            if (size < minOrderSize) {
                return { success: false, error: "BELOW_MIN_SIZE", sharesFilled: 0, priceFilled: 0 };
            }
            const signedOrder = await this.client.createOrder({
                tokenID: params.tokenId,
                price: price,
                side: side,
                size: size,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            }, {
                tickSize: tickSize, // Type assertion for TickSize
                negRisk: market.neg_risk || false
            });
            let orderType = params.orderType === 'GTC' ? OrderType.GTC :
                params.orderType === 'FAK' ? OrderType.FAK :
                    OrderType.FOK;
            const res = await this.client.postOrder(signedOrder, orderType);
            if (res && res.success && !res.errorMsg) {
                return {
                    success: true,
                    orderId: res.orderID,
                    txHash: res.transactionHash,
                    sharesFilled: parseFloat(res.takingAmount || '0'),
                    priceFilled: price
                };
            }
            // Handle specific errors as per docs
            if (res.errorMsg?.includes('MIN_TICK_SIZE')) {
                throw new Error(`Price doesn't match tick size: ${tickSize}`);
            }
            else if (res.errorMsg?.includes('MIN_SIZE')) {
                throw new Error(`Order too small. Minimum: ${minOrderSize} USDC`);
            }
            else if (res.errorMsg?.includes('NOT_ENOUGH_BALANCE')) {
                throw new Error('Insufficient funds for this order');
            }
            else {
                throw new Error(res.errorMsg || "Order rejected");
            }
        }
        catch (error) {
            if (retryCount < 1 && (String(error).includes("401") || String(error).includes("signature"))) {
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            return { success: false, error: error.message, sharesFilled: 0, priceFilled: 0 };
        }
    }
    async cancelOrder(orderId) {
        if (!this.client)
            return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        }
        catch (e) {
            return false;
        }
    }
    async cancelAllOrders() {
        await this.client?.cancelAll();
        return true;
    }
    async getOpenOrders() {
        if (!this.client)
            return [];
        try {
            return await this.client.getOpenOrders() || [];
        }
        catch (e) {
            return [];
        }
    }
    async mergePositions(conditionId, amount) {
        if (!this.safeManager)
            throw new Error("No Safe");
        const amountWei = ethers.parseUnits(amount.toString(), 6);
        const ctfInterface = new Interface(["function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount)"]);
        const data = ctfInterface.encodeFunctionData("mergePositions", [TOKENS.USDC_BRIDGED, ethers.ZeroHash, conditionId, [1, 2], amountWei]);
        return await this.safeManager.executeTransaction({ to: CTF_ADDRESS, data, value: "0" });
    }
    async cashout(amount, destination) {
        return await this.safeManager.withdrawUSDC(destination, Math.floor(amount * 1000000).toString());
    }
    async ensureUsdcAllowance(isNegRisk, tradeAmountUsd = 0) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        const allowance = await this.usdcContract.allowance(this.safeAddress, EXCHANGE);
        if (allowance < BigInt(Math.ceil((tradeAmountUsd + 1) * 1000000))) {
            await this.safeManager.enableApprovals();
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    async ensureOutcomeTokenApproval(isNegRisk) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        if (!(await this.safeManager.checkOutcomeTokenApproval(this.safeAddress, EXCHANGE))) {
            await this.safeManager.approveOutcomeTokens(EXCHANGE, isNegRisk);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    async getCurrentPrice(tokenId) {
        if (!this.client)
            return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid) || 0;
        }
        catch (e) {
            return 0;
        }
    }
    getFunderAddress() { return this.safeAddress || this.config.walletConfig.address; }
    getRawClient() { return this.client; }
    getSigner() { return this.walletV6; }
    async redeemPosition(conditionId, tokenId) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error('Safe manager not initialized');
        try {
            const balanceBefore = await this.fetchBalance(this.safeAddress);
            const indexSets = [1n, 2n];
            const redeemTx = { to: CTF_ADDRESS, data: this.encodeRedeemPositions(TOKENS.USDC_BRIDGED, ethers.ZeroHash, conditionId, indexSets), value: "0" };
            const txHash = await this.safeManager.executeTransaction(redeemTx);
            await new Promise(r => setTimeout(r, 5000));
            const balanceAfter = await this.fetchBalance(this.safeAddress);
            return { success: true, amountUsd: balanceAfter - balanceBefore, txHash };
        }
        catch (e) {
            return { success: false, error: e.message || 'Redemption failed' };
        }
    }
    encodeRedeemPositions(collateralToken, parentCollectionId, conditionId, indexSets) {
        const iface = new Interface(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)"]);
        return iface.encodeFunctionData("redeemPositions", [collateralToken, parentCollectionId, conditionId, indexSets]);
    }
    // ============================================================
    // NEW INTERFACE METHODS
    // ============================================================
    async placeOrder(params) {
        try {
            if (!this.client)
                throw new Error("Not authenticated");
            const result = await this.createOrder(params);
            return {
                success: result.success,
                orderId: result.orderId,
                txHash: result.txHash,
                sharesFilled: result.sharesFilled,
                priceFilled: result.priceFilled,
                error: result.error
            };
        }
        catch (error) {
            return {
                success: false,
                sharesFilled: 0,
                priceFilled: 0,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
    getApiCredentials() {
        if (!this.config.builderApiKey || !this.config.builderApiSecret || !this.config.builderApiPassphrase) {
            return undefined;
        }
        return {
            key: this.config.builderApiKey,
            secret: this.config.builderApiSecret,
            passphrase: this.config.builderApiPassphrase
        };
    }
    async getServerTime() {
        try {
            const response = await axios.get('https://clob.polymarket.com/time');
            if (response.data) {
                return response.data.timestamp || Date.now();
            }
        }
        catch (error) {
            // Silent fail
        }
        return Date.now();
    }
    async getOk() {
        try {
            const response = await axios.get('https://clob.polymarket.com/health');
            return response.status === 200;
        }
        catch (error) {
            // Silent fail
        }
        return false;
    }
}
