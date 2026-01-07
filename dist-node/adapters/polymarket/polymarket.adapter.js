import { LiquidityHealth } from '../interfaces.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { JsonRpcProvider, Contract, formatUnits, Interface, ethers } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { User, Trade } from '../../database/index.js';
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
    config;
    logger;
    exchangeName = 'Polymarket';
    client;
    invalidTokenIds = new Set();
    lastTokenIdCheck = new Map();
    TOKEN_ID_CHECK_COOLDOWN = 5 * 60 * 1000; // 5 minutes
    wallet;
    walletV5;
    walletService;
    safeManager;
    usdcContract;
    provider;
    safeAddress;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async initialize() {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter for user ${this.config.userId}...`);
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        if (this.config.walletConfig.encryptedPrivateKey) {
            this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
            this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        }
        else {
            throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }
        const sdkAlignedAddress = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        this.safeAddress = sdkAlignedAddress;
        this.safeManager = new SafeManagerService(this.wallet, this.config.builderApiKey, this.config.builderApiSecret, this.config.builderApiPassphrase, this.logger, this.safeAddress);
        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        const USDC_ABI_INTERNAL = [
            'function balanceOf(address owner) view returns (uint256)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function transfer(address to, uint256 amount) returns (bool)'
        ];
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI_INTERNAL, this.provider);
    }
    async validatePermissions() {
        return true;
    }
    async authenticate() {
        if (!this.wallet || !this.safeManager || !this.safeAddress)
            throw new Error("Adapter not initialized");
        await this.safeManager.deploySafe();
        await this.safeManager.enableApprovals();
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('Handshake: Deriving L2 API Keys...');
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
    async deriveAndSaveKeys() {
        try {
            const tempClient = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, undefined, SignatureType.EOA, undefined);
            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key)
                throw new Error("Empty keys returned");
            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };
            await User.findOneAndUpdate({ address: this.config.userId }, {
                "tradingWallet.l2ApiCredentials": apiCreds,
                "tradingWallet.safeAddress": this.safeAddress
            });
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('API Keys Derived and Saved');
        }
        catch (e) {
            this.logger.error(`Handshake Failed: ${e.message}`);
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
        if (!this.client) {
            this.logger.warn('Client not initialized when getting market price');
            return 0;
        }
        const isTradeable = await this.isMarketTradeable(marketId);
        if (!isTradeable) {
            this.logger.debug(`Market ${marketId} is not tradeable, returning 0 as price`);
            return 0;
        }
        try {
            const priceRes = await this.client.getPrice(tokenId, side);
            return parseFloat(priceRes.price) || 0;
        }
        catch (e) {
            try {
                const mid = await this.client.getMidpoint(tokenId);
                return parseFloat(mid.mid) || 0;
            }
            catch (midErr) {
                const errorMessage = midErr instanceof Error ? midErr.message : 'Unknown error';
                if (midErr.response?.status === 404 || errorMessage.includes('404') ||
                    errorMessage.includes('No orderbook') || errorMessage.includes('not found')) {
                    this.logger.warn(`No orderbook exists for token ${tokenId} - returning 0 as price`);
                    this.invalidTokenIds.add(tokenId);
                    this.lastTokenIdCheck.set(tokenId, Date.now());
                    return 0;
                }
                this.logger.error(`Error getting midpoint for token ${tokenId}: ${errorMessage}`);
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
    async getMarket(marketId) {
        if (!this.client)
            return null;
        try {
            return await this.client.getMarket(marketId);
        }
        catch (error) {
            this.logger.warn(`Failed to fetch market ${marketId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
        }
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
            if (!this.isTokenIdValid(conditionId)) {
                this.logger.debug(`Token ID ${conditionId} is in cooldown or marked as invalid`);
                return false;
            }
            const market = await this.getMarket(conditionId);
            if (!market) {
                this.logger.debug(`Market not found for condition ID: ${conditionId}`);
                this.invalidTokenIds.add(conditionId);
                this.lastTokenIdCheck.set(conditionId, Date.now());
                return false;
            }
            // INSTUCTIONAL: Corrected tradeability check per HFT discussion
            const isTradeable = !!(market &&
                market.active &&
                !market.closed &&
                market.accepting_orders &&
                market.enable_order_book);
            if (!isTradeable) {
                this.logger.debug(`Market ${conditionId} is not tradeable. ` +
                    `active: ${market.active}, closed: ${market.closed}, ` +
                    `accepting_orders: ${market.accepting_orders}, ` +
                    `enable_order_book: ${market.enable_order_book}`);
                this.invalidTokenIds.add(conditionId);
                this.lastTokenIdCheck.set(conditionId, Date.now());
            }
            return isTradeable;
        }
        catch (error) {
            this.logger.warn(`Error checking if market ${conditionId} is tradeable: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }
    async getOrderBook(tokenId) {
        if (!this.client) {
            this.logger.warn('Client not initialized when getting order book');
            return this.getEmptyOrderBook();
        }
        const isTradeable = await this.isMarketTradeable(tokenId);
        if (!isTradeable) {
            this.logger.debug(`Market ${tokenId} is not tradeable, returning empty order book`);
            return this.getEmptyOrderBook();
        }
        try {
            const book = await this.client.getOrderBook(tokenId);
            if (!book) {
                this.logger.warn(`Empty order book response for token ${tokenId}`);
                return this.getEmptyOrderBook();
            }
            return {
                bids: this.normalizeOrders(book.bids, 'desc'),
                asks: this.normalizeOrders(book.asks, 'asc'),
                min_order_size: book.min_order_size ? Number(book.min_order_size) : 5,
                tick_size: book.tick_size ? Number(book.tick_size) : 0.01,
                neg_risk: Boolean(book.neg_risk)
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (error.response?.status === 404 || errorMessage.includes('404') || errorMessage.includes('No orderbook')) {
                this.logger.warn(`No orderbook exists for token ${tokenId} - market may be closed/resolved`);
                this.invalidTokenIds.add(tokenId);
                this.lastTokenIdCheck.set(tokenId, Date.now());
                return this.getEmptyOrderBook();
            }
            this.logger.error(`Error fetching order book for token ${tokenId}: ${errorMessage}`, error instanceof Error ? error : undefined);
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
    /**
     * Fetches markets that are currently eligible for rewards in the sampling period
     * @returns Array of markets that are eligible for rewards with their token and market IDs
     */
    async getSamplingMarkets() {
        if (!this.client)
            throw new Error("Not authenticated");
        try {
            const response = await this.client.getSamplingMarkets();
            // Extract the data array from the pagination response
            const markets = response?.data || [];
            return markets.map((market) => ({
                token_id: market.token_id || market.tokenId,
                market_id: market.market_id || market.conditionId,
                rewards_max_spread: market.rewards_max_spread || market.maxSpread
            }));
        }
        catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            this.logger.error(`[Scout] Failed to fetch sampling markets: ${errorMessage}`);
            return [];
        }
    }
    // ============================================
    // POSITION & MARKET DATA METHODS (POLISHED)
    // ============================================
    /**
     * Fetches market slugs and metadata from CLOB + Gamma APIs
     * Uses conditionId as the primary identifier
     */
    async fetchMarketSlugs(conditionId) {
        const result = {
            marketSlug: '',
            eventSlug: '',
            question: '',
            image: '',
            conditionId: conditionId,
            acceptingOrders: true,
            closed: false
        };
        if (!this.client || !conditionId)
            return result;
        // Step 1: Get market data from CLOB API using conditionId
        try {
            const marketData = await this.client.getMarket(conditionId);
            if (marketData) {
                result.marketSlug = marketData.market_slug || '';
                result.question = marketData.question || '';
                result.image = marketData.image || '';
                result.acceptingOrders = marketData.accepting_orders ?? true;
                result.closed = marketData.closed || false;
            }
        }
        catch (e) {
            this.logger.debug(`Error fetching CLOB market data for ${conditionId}: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        // Step 2: Get event slug from Gamma API using market_slug
        if (result.marketSlug) {
            try {
                const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${result.marketSlug}`;
                const gammaResponse = await fetch(gammaUrl);
                if (gammaResponse.ok) {
                    const gammaData = await gammaResponse.json();
                    if (gammaData.events?.length > 0) {
                        result.eventSlug = gammaData.events[0]?.slug || '';
                    }
                }
            }
            catch (e) {
                this.logger.debug(`Error fetching Gamma event slug for ${result.marketSlug}: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
        }
        return result;
    }
    /**
     * Gets all positions from the database, including closed ones
     * Returns enriched position data with proper slugs for URL construction
     */
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
            this.logger.error(`Error fetching database positions: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return [];
        }
    }
    /**
     * Gets market data for a specific market using conditionId
     * Returns enriched metadata including slugs for proper URL construction
     */
    async getMarketData(conditionId) {
        try {
            if (!this.client) {
                throw new Error('CLOB client not initialized');
            }
            // Fetch full market metadata including slugs
            const marketSlugs = await this.fetchMarketSlugs(conditionId);
            if (marketSlugs.question || marketSlugs.marketSlug) {
                return {
                    question: marketSlugs.question || `Market ${conditionId.slice(0, 10)}...`,
                    image: marketSlugs.image || '',
                    isResolved: marketSlugs.closed,
                    acceptingOrders: marketSlugs.acceptingOrders,
                    marketSlug: marketSlugs.marketSlug,
                    eventSlug: marketSlugs.eventSlug,
                    conditionId: conditionId
                };
            }
            // Fallback to direct CLOB endpoint if fetchMarketSlugs returned empty
            try {
                const response = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
                if (response.data) {
                    return {
                        question: response.data.question || `Market ${conditionId.slice(0, 10)}...`,
                        image: response.data.image || '',
                        isResolved: response.data.closed || response.data.state === 'RESOLVED',
                        acceptingOrders: response.data.accepting_orders ?? true,
                        marketSlug: response.data.market_slug || '',
                        eventSlug: '',
                        conditionId: conditionId
                    };
                }
            }
            catch (e) {
                this.logger.warn(`Failed to get market data from fallback API for ${conditionId}`);
            }
            return null;
        }
        catch (error) {
            this.logger.error(`Error getting market data for ${conditionId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
        }
    }
    /**
     * Updates position metadata in the database
     * Uses conditionId as the primary identifier for consistency
     */
    async updatePositionMetadata(conditionId, metadata) {
        try {
            await Trade.updateMany({
                userId: this.config.userId,
                $or: [
                    { conditionId: conditionId },
                    { marketId: conditionId }
                ]
            }, {
                $set: {
                    'metadata.question': metadata.question,
                    'metadata.image': metadata.image,
                    'metadata.isResolved': metadata.isResolved,
                    'metadata.acceptingOrders': metadata.acceptingOrders,
                    'metadata.updatedAt': metadata.updatedAt || new Date(),
                    marketSlug: metadata.marketSlug,
                    eventSlug: metadata.eventSlug,
                    conditionId: conditionId,
                    updatedAt: new Date()
                }
            }, { upsert: false });
            this.logger.debug(`Updated metadata for market ${conditionId}`);
        }
        catch (error) {
            this.logger.error(`Error updating position metadata for ${conditionId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }
    /**
     * Gets positions from Data API with enriched metadata
     * Fetches live prices and proper slugs for URL construction
     */
    async getPositions(address) {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if (!Array.isArray(res.data))
                return [];
            const positions = [];
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0.01)
                    continue;
                // Data API returns: conditionId, asset (tokenId), outcome, size, price, avgPrice
                const conditionId = p.conditionId || '';
                const tokenId = p.asset || '';
                const outcome = p.outcome || 'YES';
                // Get current price - prefer live midpoint
                let currentPrice = parseFloat(p.price) || 0;
                if (currentPrice === 0 && this.client && tokenId) {
                    try {
                        const isTradeable = await this.isMarketTradeable(conditionId);
                        if (isTradeable) {
                            const mid = await this.client.getMidpoint(tokenId);
                            currentPrice = parseFloat(mid.mid) || 0;
                        }
                    }
                    catch (e) {
                        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
                        if (e.response?.status === 404 || errorMessage.includes('404') ||
                            errorMessage.includes('No orderbook') || errorMessage.includes('not found')) {
                            this.logger.debug(`No orderbook for token ${tokenId}, using avgPrice`);
                            this.invalidTokenIds.add(tokenId);
                            this.lastTokenIdCheck.set(tokenId, Date.now());
                        }
                    }
                }
                // Fallback to avgPrice if still no price
                const entryPrice = parseFloat(p.avgPrice) || 0.5;
                if (currentPrice === 0)
                    currentPrice = entryPrice;
                // Calculate values
                const currentValueUsd = size * currentPrice;
                const investedValueUsd = size * entryPrice;
                const unrealizedPnL = currentValueUsd - investedValueUsd;
                // Fetch rich metadata (slugs, question, image)
                const metadata = await this.fetchMarketSlugs(conditionId);
                positions.push({
                    marketId: conditionId,
                    conditionId: conditionId,
                    tokenId: tokenId,
                    clobOrderId: tokenId,
                    outcome: outcome,
                    balance: size,
                    valueUsd: currentValueUsd,
                    investedValue: investedValueUsd,
                    entryPrice: entryPrice,
                    currentPrice: currentPrice,
                    unrealizedPnL: unrealizedPnL,
                    question: metadata.question || `Market ${conditionId.slice(0, 10)}...`,
                    image: metadata.image,
                    marketSlug: metadata.marketSlug,
                    eventSlug: metadata.eventSlug,
                    isResolved: metadata.closed,
                    acceptingOrders: metadata.acceptingOrders
                });
            }
            return positions;
        }
        catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            this.logger.error(`Error fetching positions: ${errorMessage}`, e instanceof Error ? e : undefined);
            return [];
        }
    }
    async fetchPublicTrades(address, limit = 20) {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            const res = await axios.get(url);
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
            const book = await this.getOrderBook(params.tokenId);
            let rawPrice;
            if (side === Side.SELL) {
                if (!book.bids.length)
                    return { success: false, error: "skipped_no_bids", sharesFilled: 0, priceFilled: 0 };
                rawPrice = book.bids[0].price;
                if (params.priceLimit !== undefined && params.priceLimit > rawPrice)
                    rawPrice = params.priceLimit;
            }
            else {
                if (!book.asks.length)
                    return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                rawPrice = book.asks[0].price;
                if (params.priceLimit !== undefined && params.priceLimit < rawPrice)
                    rawPrice = params.priceLimit;
            }
            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = side === Side.BUY
                ? Math.ceil(rawPrice * inverseTick) / inverseTick
                : Math.floor(rawPrice * inverseTick) / inverseTick;
            const finalPrice = Math.max(0.001, Math.min(0.999, roundedPrice));
            let shares = params.sizeShares || (params.side === 'BUY'
                ? Math.ceil(params.sizeUsd / finalPrice)
                : Math.floor(params.sizeUsd / finalPrice));
            if (params.side === 'BUY' && (shares * finalPrice) < 1.00) {
                shares = Math.ceil(1.00 / finalPrice);
            }
            if (shares < minOrderSize) {
                return { success: false, error: "BELOW_MIN_SIZE", sharesFilled: 0, priceFilled: 0 };
            }
            const signedOrder = await this.client.createOrder({
                tokenID: params.tokenId,
                price: finalPrice,
                side: side,
                size: Math.floor(shares),
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            });
            // CRITICAL: Respect orderType parameter for GTC (Maker) support
            let orderType = OrderType.FOK; // Default to FOK for Safety (Taker)
            if (params.orderType === 'GTC') {
                orderType = OrderType.GTC;
                this.logger.info(`🚀 [MAKER] Posting GTC Order for ${params.tokenId} @ ${finalPrice}`);
            }
            else if (params.orderType === 'FAK') {
                orderType = OrderType.FAK;
            }
            else if (side === Side.SELL) {
                orderType = OrderType.FAK; // Use FAK for sells to allow partial fills
            }
            const res = await this.client.postOrder(signedOrder, orderType);
            if (res && res.success) {
                let actualFilledShares = 0;
                let actualUsdMoved = 0;
                if (params.side === 'BUY') {
                    actualFilledShares = parseFloat(res.takingAmount || '0');
                    actualUsdMoved = parseFloat(res.makingAmount || '0') / 1e6;
                }
                else {
                    actualUsdMoved = parseFloat(res.takingAmount || '0') / 1e6;
                    actualFilledShares = parseFloat(res.makingAmount || '0');
                }
                const avgPrice = actualFilledShares > 0 ? actualUsdMoved / actualFilledShares : finalPrice;
                return {
                    success: true,
                    orderId: res.orderID,
                    txHash: res.transactionHash,
                    sharesFilled: actualFilledShares,
                    priceFilled: avgPrice,
                    usdFilled: actualUsdMoved
                };
            }
            throw new Error(res.errorMsg || "Order execution rejected by relayer");
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
            const orders = await this.client.getOpenOrders();
            return orders || [];
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
        const data = ctfInterface.encodeFunctionData("mergePositions", [
            TOKENS.USDC_BRIDGED,
            ethers.ZeroHash,
            conditionId,
            [1, 2],
            amountWei
        ]);
        return await this.safeManager.executeTransaction({
            to: CTF_ADDRESS,
            data,
            value: "0"
        });
    }
    async cashout(amount, destination) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    async ensureUsdcAllowance(isNegRisk, tradeAmountUsd = 0) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        const allowance = await this.usdcContract.allowance(this.safeAddress, EXCHANGE);
        const requiredAmountRaw = BigInt(Math.ceil((tradeAmountUsd + 1) * 1000000));
        if (allowance < requiredAmountRaw) {
            await this.safeManager.enableApprovals();
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    async ensureOutcomeTokenApproval(isNegRisk) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error("Safe Manager not initialized");
        const EXCHANGE = isNegRisk ? "0xC5d563A36AE78145C45a50134d48A1215220f80a" : "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
        const isApproved = await this.safeManager.checkOutcomeTokenApproval(this.safeAddress, EXCHANGE);
        if (!isApproved) {
            await this.safeManager.approveOutcomeTokens(EXCHANGE, isNegRisk);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    async getCurrentPrice(tokenId) {
        if (!this.client) {
            this.logger.warn('Client not initialized when getting current price');
            return 0;
        }
        // Check if market is tradeable before attempting to get price
        const isTradeable = await this.isMarketTradeable(tokenId);
        if (!isTradeable) {
            this.logger.debug(`Market ${tokenId} is not tradeable, returning 0 as price`);
            return 0;
        }
        try {
            // Try to get the best bid first
            const book = await this.getOrderBook(tokenId);
            if (book.bids.length > 0) {
                return book.bids[0].price || 0;
            }
            // Fall back to midpoint if no bids
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid) || 0;
        }
        catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            // Handle 404 specifically
            if (e.response?.status === 404 || errorMessage.includes('404') ||
                errorMessage.includes('No orderbook') || errorMessage.includes('not found')) {
                this.logger.warn(`No orderbook exists for token ${tokenId} - returning 0 as price`);
                this.invalidTokenIds.add(tokenId);
                this.lastTokenIdCheck.set(tokenId, Date.now());
                return 0;
            }
            this.logger.error(`Error getting current price for token ${tokenId}: ${errorMessage}`);
            return 0;
        }
    }
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }
    getRawClient() {
        return this.client;
    }
    getSigner() {
        return this.wallet;
    }
    async redeemPosition(conditionId, tokenId) {
        if (!this.safeManager || !this.safeAddress)
            throw new Error('Safe manager not initialized');
        const USDC_ADDRESS = TOKENS.USDC_BRIDGED;
        try {
            const balanceBefore = await this.fetchBalance(this.safeAddress);
            const indexSets = [1n, 2n];
            const redeemTx = {
                to: CTF_ADDRESS,
                data: this.encodeRedeemPositions(USDC_ADDRESS, ethers.ZeroHash, conditionId, indexSets),
                value: "0"
            };
            const txHash = await this.safeManager.executeTransaction(redeemTx);
            await new Promise(r => setTimeout(r, 5000));
            const balanceAfter = await this.fetchBalance(this.safeAddress);
            return {
                success: true,
                amountUsd: balanceAfter - balanceBefore,
                txHash
            };
        }
        catch (e) {
            return { success: false, error: e.message || 'Redemption failed' };
        }
    }
    encodeRedeemPositions(collateralToken, parentCollectionId, conditionId, indexSets) {
        const iface = new Interface(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)"]);
        return iface.encodeFunctionData("redeemPositions", [collateralToken, parentCollectionId, conditionId, indexSets]);
    }
}
