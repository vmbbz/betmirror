import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';
const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
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
    wallet;
    walletV5; // Dedicated V5 wallet for SDK
    walletService;
    safeManager;
    usdcContract;
    provider;
    safeAddress;
    // Internal cache for market metadata to prevent rate limiting getMarket(id) calls
    marketMetadataCache = new Map();
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async initialize() {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (Ethers v6/v5 Hybrid)...`);
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        if (this.config.walletConfig.encryptedPrivateKey) {
            // V6 for general operations
            this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
            // V5 for SDK stability
            this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        }
        else {
            throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }
        // Initialize Safe Manager
        let safeAddressToUse = this.config.walletConfig.safeAddress;
        if (!safeAddressToUse) {
            this.logger.warn(`   Warning: Safe address missing in config. Computing...`);
            safeAddressToUse = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        }
        if (!safeAddressToUse) {
            throw new Error("Failed to resolve Safe Address.");
        }
        this.safeManager = new SafeManagerService(this.wallet, this.config.builderApiKey, this.config.builderApiSecret, this.config.builderApiPassphrase, this.logger, safeAddressToUse);
        this.safeAddress = this.safeManager.getSafeAddress();
        this.logger.info(`   Smart Bot Address: ${this.safeAddress}`);
        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }
    async validatePermissions() {
        return true;
    }
    async authenticate() {
        if (!this.wallet || !this.safeManager || !this.safeAddress)
            throw new Error("Adapter not initialized");
        // 1. Ensure Safe is Deployed
        await this.safeManager.deploySafe();
        // 2. Ensure Approvals
        await this.safeManager.enableApprovals();
        // 3. L2 Auth (API Keys)
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('Handshake: Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials;
        }
        else {
            this.logger.info('Using existing CLOB Credentials');
        }
        // 4. Initialize Clob Client
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
            // Keys must be derived using SignatureType.EOA because the EOA is the signer.
            const tempClient = new ClobClient(HOST_URL, Chain.POLYGON, this.walletV5, undefined, SignatureType.EOA, undefined);
            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key)
                throw new Error("Empty keys returned");
            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };
            await User.findOneAndUpdate({ address: this.config.userId }, { "tradingWallet.l2ApiCredentials": apiCreds });
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
    async getMarketPrice(marketId, tokenId) {
        if (!this.client)
            return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        }
        catch (e) {
            return 0;
        }
    }
    async getOrderBook(tokenId) {
        if (!this.client)
            throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
            min_order_size: book.min_order_size ? Number(book.min_order_size) : 5,
            tick_size: book.tick_size ? Number(book.tick_size) : 0.01,
            neg_risk: book.neg_risk
        };
    }
    async getPositions(address) {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if (!Array.isArray(res.data))
                return [];
            const positions = [];
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0)
                    continue;
                let currentPrice = parseFloat(p.price) || 0;
                if (currentPrice === 0 && this.client && p.asset) {
                    try {
                        const mid = await this.client.getMidpoint(p.asset);
                        currentPrice = parseFloat(mid.mid) || 0;
                    }
                    catch (e) {
                        currentPrice = parseFloat(p.avgPrice) || 0.5;
                    }
                }
                const entryPrice = parseFloat(p.avgPrice) || currentPrice || 0.5;
                const currentValueUsd = size * currentPrice;
                const investedValueUsd = size * entryPrice;
                const unrealizedPnL = currentValueUsd - investedValueUsd;
                const unrealizedPnLPercent = investedValueUsd > 0 ? (unrealizedPnL / investedValueUsd) * 100 : 0;
                let marketSlug = "";
                let eventSlug = "";
                let question = p.title || p.conditionId || p.market;
                let image = p.icon || "";
                if (p.conditionId) {
                    // Step 1: Get market_slug from CLOB API
                    if (this.client) {
                        try {
                            let marketData = this.marketMetadataCache.get(p.conditionId);
                            if (!marketData) {
                                marketData = await this.client.getMarket(p.conditionId);
                                this.marketMetadataCache.set(p.conditionId, marketData || {});
                            }
                            if (marketData) {
                                marketSlug = marketData.market_slug || "";
                                question = marketData.question || question;
                                image = marketData.image || image;
                            }
                        }
                        catch (clobError) {
                            console.log(`[WARN] CLOB API failed for ${p.conditionId}`);
                        }
                    }
                    // Step 2: Get event_slug from Gamma API using market slug
                    if (marketSlug) {
                        try {
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 5000);
                            // Use /markets/slug/{slug} endpoint - returns full market with event info
                            const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${marketSlug}`, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
                            clearTimeout(timeoutId);
                            if (response.ok) {
                                const marketData = await response.json();
                                // Event slug is in the events array
                                if (marketData?.events?.length > 0) {
                                    eventSlug = marketData.events[0]?.slug || "";
                                }
                            }
                        }
                        catch (gammaError) {
                            console.log(`[WARN] Gamma API failed for slug ${marketSlug}`);
                        }
                    }
                    console.log(`[DEBUG] Slugs for ${p.conditionId}: market="${marketSlug}", event="${eventSlug}"`);
                }
                positions.push({
                    marketId: p.conditionId || p.market,
                    tokenId: p.asset,
                    outcome: p.outcome || 'UNK',
                    balance: size,
                    valueUsd: currentValueUsd,
                    investedValue: investedValueUsd,
                    entryPrice: entryPrice,
                    currentPrice: currentPrice,
                    unrealizedPnL: unrealizedPnL,
                    unrealizedPnLPercent: unrealizedPnLPercent,
                    question: question,
                    image: image,
                    marketSlug: marketSlug,
                    eventSlug: eventSlug,
                    clobOrderId: p.asset
                });
            }
            return positions;
        }
        catch (e) {
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
            let negRisk = false;
            let minOrderSize = 5;
            let tickSize = 0.01;
            try {
                const market = await this.client.getMarket(params.marketId);
                negRisk = market.neg_risk;
                if (market.minimum_order_size)
                    minOrderSize = Number(market.minimum_order_size);
                if (market.minimum_tick_size)
                    tickSize = Number(market.minimum_tick_size);
            }
            catch (e) {
                // Fallback: Get from orderbook metadata
                try {
                    const book = await this.getOrderBook(params.tokenId);
                    if (book.min_order_size)
                        minOrderSize = book.min_order_size;
                    if (book.tick_size)
                        tickSize = book.tick_size;
                    if (book.neg_risk !== undefined)
                        negRisk = book.neg_risk;
                }
                catch (e2) {
                    this.logger.debug(`Order: Market info fetch fallback for ${params.marketId}`);
                }
            }
            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            let rawPrice = params.priceLimit;
            if (rawPrice === undefined || rawPrice === 0) {
                const book = await this.client.getOrderBook(params.tokenId);
                if (side === Side.BUY) {
                    if (!book.asks || book.asks.length === 0)
                        throw new Error("skipped_no_liquidity");
                    rawPrice = Number(book.asks[0].price);
                }
                else {
                    if (book.bids && book.bids.length > 0) {
                        rawPrice = Number(book.bids[0].price);
                    }
                    else {
                        throw new Error("skipped_no_liquidity");
                    }
                }
            }
            if (rawPrice >= 0.99)
                rawPrice = 0.99;
            if (rawPrice <= 0.01)
                rawPrice = 0.01;
            // DIRECTIONAL TICK ROUNDING
            const inverseTick = Math.round(1 / tickSize);
            let roundedPrice;
            if (side === Side.BUY) {
                roundedPrice = Math.ceil(rawPrice * inverseTick) / inverseTick;
            }
            else {
                roundedPrice = Math.floor(rawPrice * inverseTick) / inverseTick;
            }
            if (roundedPrice > 0.99)
                roundedPrice = 0.99;
            if (roundedPrice < 0.01)
                roundedPrice = 0.01;
            let shares = params.sizeShares || Math.floor(params.sizeUsd / roundedPrice);
            // CRITICAL FIX: Polymarket enforces a 2-decimal limit on the Maker collateral amount (USDC) for BUY orders.
            // Additionally, marketable orders (FOK) must be AT LEAST $1.00 USDC in total value.
            if (side === Side.BUY) {
                const MIN_ORDER_VALUE = 1.01;
                // 1. Ensure total value >= $1.00
                if (shares * roundedPrice < MIN_ORDER_VALUE) {
                    shares = Math.ceil(MIN_ORDER_VALUE / roundedPrice);
                }
                // 2. Ensure the product has exactly 2 decimals of precision
                // We adjust shares up/down slightly to find a valid product if needed
                let totalCost = shares * roundedPrice;
                let attempts = 0;
                while (attempts < 10 && (Math.round(shares * roundedPrice * 100) / 100) !== (shares * roundedPrice)) {
                    shares++;
                    attempts++;
                }
                // Final safety truncate/rounding
                const finalMakerAmount = Math.floor(shares * roundedPrice * 100) / 100;
                if (finalMakerAmount < 1.00) {
                    this.logger.warn(`Warning: Cannot meet 1.00 minimum at price ${roundedPrice}. Skipping.`);
                    return { success: false, error: "skipped_min_value_limit", sharesFilled: 0, priceFilled: 0 };
                }
            }
            if (shares < minOrderSize) {
                this.logger.warn(`Warning: Order Rejected: Size (${shares}) < Minimum (${minOrderSize} shares). Req: ${params.sizeUsd.toFixed(2)} @ ${roundedPrice.toFixed(2)}`);
                return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 };
            }
            const order = {
                tokenID: params.tokenId,
                price: roundedPrice,
                side: side,
                size: shares,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            };
            this.logger.info(`Placing Order: ${params.side} ${shares} shares @ ${roundedPrice.toFixed(2)}`);
            const res = await this.client.createAndPostOrder(order, { negRisk, tickSize: tickSize }, OrderType.FOK);
            if (res && res.success) {
                this.logger.success(`Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return { success: true, orderId: res.orderID, txHash: res.transactionHash, sharesFilled: shares, priceFilled: roundedPrice };
            }
            throw new Error(res.errorMsg || "Order failed response");
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
    async cashout(amount, destination) {
        if (!this.safeManager)
            throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
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
}
