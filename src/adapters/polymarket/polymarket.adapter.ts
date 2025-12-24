import { 
    IExchangeAdapter, 
    OrderParams,
    OrderResult
} from '../interfaces.js';
import { OrderBook, PositionData } from '../../domain/market.types.js';
import { TradeSignal, TradeHistoryEntry } from '../../domain/trade.types.js';
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import { Wallet as WalletV6, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { Wallet as WalletV5 } from 'ethers-v5'; // V5 for SDK
import { EvmWalletService } from '../../services/evm-wallet.service.js';
import { SafeManagerService } from '../../services/safe-manager.service.js';
import { TradingWalletConfig } from '../../domain/wallet.types.js';
import { User } from '../../database/index.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { Logger } from '../../utils/logger.util.js';
import { TOKENS } from '../../config/env.js';
import axios from 'axios';

const HOST_URL = 'https://clob.polymarket.com';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2
}

interface PolyActivityResponse {
  type: string;
  timestamp: number;
  conditionId: string;
  asset: string;
  size: number;
  usdcSize: number;
  price: number;
  side: string;
  outcomeIndex: number;
  transactionHash: string;
}

export class PolymarketAdapter implements IExchangeAdapter {
    readonly exchangeName = 'Polymarket';
    
    private client?: ClobClient;
    private wallet?: WalletV6; 
    private walletV5?: WalletV5; // Dedicated V5 wallet for SDK
    private walletService?: EvmWalletService;
    private safeManager?: SafeManagerService;
    private usdcContract?: Contract;
    private provider?: JsonRpcProvider;
    private safeAddress?: string;

    private marketMetadataCache: Map<string, any> = new Map();

    constructor(
        private config: {
            rpcUrl: string;
            walletConfig: TradingWalletConfig;
            userId: string;
            l2ApiCredentials?: any;
            builderApiKey?: string;
            builderApiSecret?: string;
            builderApiPassphrase?: string;
            mongoEncryptionKey: string;
        },
        private logger: Logger
    ) {}

    async initialize(): Promise<void> {
        this.logger.info(`[${this.exchangeName}] Initializing Adapter...`);
        
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        if (this.config.walletConfig.encryptedPrivateKey) {
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        /**
         * DERIVATION GUARD:
         * We recalculate the address now to ensure parity with the Polymarket SDK logic.
         * If the address in the DB was derived using a different factory, we override it here.
         */
        const sdkAlignedAddress = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        const dbAddress = this.config.walletConfig.safeAddress;

        if (dbAddress && dbAddress.toLowerCase() !== sdkAlignedAddress.toLowerCase()) {
            this.logger.warn(`⚠️ Mismatched Safe address detected! DB: ${dbAddress} | SDK Expected: ${sdkAlignedAddress}`);
            this.logger.warn(`   Overriding with SDK-aligned address to ensure signature compatibility.`);
        }

        this.safeAddress = sdkAlignedAddress;

        this.safeManager = new SafeManagerService(
            this.wallet,
            this.config.builderApiKey,
            this.config.builderApiSecret,
            this.config.builderApiPassphrase,
            this.logger,
            this.safeAddress 
        );

        this.logger.info(`   Target Bot Address: ${this.safeAddress}`);

        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }

    async validatePermissions(): Promise<boolean> {
        return true;
    }

    async authenticate(): Promise<void> {
        if (!this.wallet || !this.safeManager || !this.safeAddress) throw new Error("Adapter not initialized");

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

    private initClobClient(apiCreds: any) {
        let builderConfig: BuilderConfig | undefined;
        if (this.config.builderApiKey && this.config.builderApiSecret && this.config.builderApiPassphrase) {
            builderConfig = new BuilderConfig({ 
                localBuilderCreds: {
                    key: this.config.builderApiKey,
                    secret: this.config.builderApiSecret,
                    passphrase: this.config.builderApiPassphrase
                }
            });
        }

        this.client = new ClobClient(
            HOST_URL,
            Chain.POLYGON,
            this.walletV5 as any, 
            apiCreds,
            SignatureType.POLY_GNOSIS_SAFE,
            this.safeAddress,
            undefined, 
            undefined,
            builderConfig
        );
    }

    private async deriveAndSaveKeys() {
        try {
            const tempClient = new ClobClient(
                HOST_URL,
                Chain.POLYGON,
                this.walletV5 as any, 
                undefined,
                SignatureType.EOA,
                undefined
            );

            const rawCreds = await tempClient.createOrDeriveApiKey();
            if (!rawCreds || !rawCreds.key) throw new Error("Empty keys returned");

            const apiCreds = {
                key: rawCreds.key,
                secret: rawCreds.secret,
                passphrase: rawCreds.passphrase
            };

            await User.findOneAndUpdate(
                { address: this.config.userId },
                { 
                    "tradingWallet.l2ApiCredentials": apiCreds,
                    "tradingWallet.safeAddress": this.safeAddress // Sync the correct address back to DB
                }
            );
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('API Keys Derived and Saved');
        } catch (e: any) {
            this.logger.error(`Handshake Failed: ${e.message}`);
            throw e;
        }
    }

    async fetchBalance(address: string): Promise<number> {
        if(!this.usdcContract) return 0;
        try {
            const bal = await this.usdcContract.balanceOf(address);
            return parseFloat(formatUnits(bal, 6));
        } catch (e) { return 0; }
    }

    async getPortfolioValue(address: string): Promise<number> {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/value?user=${address}`);
            return parseFloat(res.data) || 0;
        } catch (e) { return 0; }
    }

    async getMarketPrice(marketId: string, tokenId: string): Promise<number> {
        if (!this.client) return 0;
        try {
            const mid = await this.client.getMidpoint(tokenId);
            return parseFloat(mid.mid);
        } catch (e) { return 0; }
    }

    async getOrderBook(tokenId: string): Promise<OrderBook> {
        if (!this.client) throw new Error("Not auth");
        const book = await this.client.getOrderBook(tokenId);
        return {
            bids: book.bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
            min_order_size: (book as any).min_order_size ? Number((book as any).min_order_size) : 5,
            tick_size: (book as any).tick_size ? Number((book as any).tick_size) : 0.01,
            neg_risk: (book as any).neg_risk
        };
    }

    private async fetchMarketSlugs(marketId: string): Promise<{ marketSlug: string; eventSlug: string; question: string; image: string }> {
        let marketSlug = "";
        let eventSlug = "";
        let question = marketId;
        let image = "";

        // CLOB API for market data - force fresh fetch
        if (this.client && marketId) {
            try {
                // Clear cache to force fresh data
                this.marketMetadataCache.delete(marketId);
                
                const marketData = await this.client.getMarket(marketId);
                this.marketMetadataCache.set(marketId, marketData);

                if (marketData) {
                    marketSlug = marketData.market_slug || "";
                    question = marketData.question || question;
                    image = marketData.image || image;
                }
            } catch (e) {
                this.logger.debug(`CLOB API fetch failed for ${marketId}`);
            }
        }

        // Gamma API for event slug - use slug endpoint for accurate results
        if (marketSlug) {
            try {
                const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${marketSlug}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                const gammaResponse = await fetch(gammaUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                if (gammaResponse.ok) {
                    const marketData = await gammaResponse.json();
                    
                    // The event slug should be in the events array
                    if (marketData.events && marketData.events.length > 0) {
                        eventSlug = marketData.events[0]?.slug || "";
                    }
                }
            } catch (e) {
                this.logger.debug(`Gamma API fetch failed for slug ${marketSlug}`);
            }
        }

        return { marketSlug, eventSlug, question, image };
    }

    async getPositions(address: string): Promise<PositionData[]> {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if(!Array.isArray(res.data)) return [];
            
            const positions: PositionData[] = [];
            
            for (const p of res.data) {
                const size = parseFloat(p.size) || 0;
                if (size <= 0) continue;

                const marketId = p.conditionId || p.market;
                const tokenId = p.asset;

                let currentPrice = parseFloat(p.price) || 0;
                if (currentPrice === 0 && this.client && tokenId) {
                    try {
                        const mid = await this.client.getMidpoint(tokenId);
                        currentPrice = parseFloat(mid.mid) || 0;
                    } catch (e) {
                        currentPrice = parseFloat(p.avgPrice) || 0.5;
                    }
                }

                const entryPrice = parseFloat(p.avgPrice) || currentPrice || 0.5;
                const currentValueUsd = size * currentPrice;
                const investedValueUsd = size * entryPrice;
                const unrealizedPnL = currentValueUsd - investedValueUsd;
                const unrealizedPnLPercent = investedValueUsd > 0 ? (unrealizedPnL / investedValueUsd) * 100 : 0;

                // Reusable slug fetching
                const { marketSlug, eventSlug, question, image } = await this.fetchMarketSlugs(marketId);

                positions.push({
                    marketId: marketId,
                    tokenId: tokenId,
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
                    clobOrderId: tokenId 
                });
            }
            
            return positions;
        } catch (e) {
            this.logger.error("Failed to fetch positions", e as Error);
            return [];
        }
    }

    async fetchPublicTrades(address: string, limit: number = 20): Promise<TradeSignal[]> {
        try {
            const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`;
            const res = await axios.get<PolyActivityResponse[]>(url);
            if (!res.data || !Array.isArray(res.data)) return [];
            return res.data
                .filter(act => act.type === 'TRADE' || act.type === 'ORDER_FILLED')
                .map(act => ({
                    trader: address,
                    marketId: act.conditionId,
                    tokenId: act.asset,
                    outcome: act.outcomeIndex === 0 ? 'YES' : 'NO',
                    side: act.side.toUpperCase() as 'BUY' | 'SELL',
                    sizeUsd: act.usdcSize || (act.size * act.price),
                    price: act.price,
                    timestamp: (act.timestamp > 1e11 ? act.timestamp : act.timestamp * 1000)
                }));
        } catch (e) { return []; }
    }

    async getTradeHistory(address: string, limit: number = 50): Promise<TradeHistoryEntry[]> {
        return []; 
    }

    async createOrder(params: OrderParams, retryCount = 0): Promise<OrderResult> {
        if (!this.client) throw new Error("Client not authenticated");

        try {
            let negRisk = false;
            let minOrderSize = 5; 
            let tickSize = 0.01;

            try {
                const market = await this.client.getMarket(params.marketId);
                negRisk = market.neg_risk;
                if (market.minimum_order_size) minOrderSize = Number(market.minimum_order_size);
                if (market.minimum_tick_size) tickSize = Number(market.minimum_tick_size);
            } catch (e) {
                try {
                    const book = await this.getOrderBook(params.tokenId);
                    if (book.min_order_size) minOrderSize = book.min_order_size;
                    if (book.tick_size) tickSize = book.tick_size;
                    if (book.neg_risk !== undefined) negRisk = book.neg_risk;
                } catch(e2) {
                    this.logger.debug(`Order: Market info fetch fallback for ${params.marketId}`);
                }
            }

            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            let rawPrice = params.priceLimit;

            if (rawPrice === undefined || rawPrice === 0) {
                 const book = await this.client.getOrderBook(params.tokenId);
                 if (side === Side.BUY) {
                     if (!book.asks || book.asks.length === 0) throw new Error("skipped_no_liquidity");
                     rawPrice = Number(book.asks[0].price);
                 } else {
                     if (book.bids && book.bids.length > 0) {
                        rawPrice = Number(book.bids[0].price);
                     } else {
                        throw new Error("skipped_no_liquidity");
                     }
                 }
            }

            if (rawPrice >= 0.99) rawPrice = 0.99;
            if (rawPrice <= 0.01) rawPrice = 0.01;

            const inverseTick = Math.round(1 / tickSize);
            let roundedPrice: number;
            
            if (side === Side.BUY) {
                roundedPrice = Math.ceil(rawPrice * inverseTick) / inverseTick;
            } else {
                roundedPrice = Math.floor(rawPrice * inverseTick) / inverseTick;
            }

            if (roundedPrice > 0.99) roundedPrice = 0.99;
            if (roundedPrice < 0.01) roundedPrice = 0.01;
            
            let shares = params.sizeShares || Math.floor(params.sizeUsd / roundedPrice);

            if (side === Side.BUY) {
                const MIN_ORDER_VALUE = 1.01;
                
                if (shares * roundedPrice < MIN_ORDER_VALUE) {
                    shares = Math.ceil(MIN_ORDER_VALUE / roundedPrice);
                }

                let totalCost = shares * roundedPrice;
                let attempts = 0;
                while (attempts < 10 && (Math.round(shares * roundedPrice * 100) / 100) !== (shares * roundedPrice)) {
                    shares++;
                    attempts++;
                }
                
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

            const order: any = {
                tokenID: params.tokenId,
                price: roundedPrice,
                side: side,
                size: shares,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000"
            };

            this.logger.info(`Placing Order: ${params.side} ${shares} shares @ ${roundedPrice.toFixed(2)}`);

            // Smart order type selection with fallback strategy
            if (side === Side.SELL) {
                // Get order book to check liquidity and get market parameters
                const book = await this.client.getOrderBook(params.tokenId);
                const bestBid = book.bids.length > 0 ? Number(book.bids[0].price) : null;
                const bidLiquidity = book.bids.reduce((sum, b) => sum + Number(b.size), 0);
                const tickSize = parseFloat(book.tick_size) || 0.01;
                const minOrderSize = parseFloat(book.min_order_size) || 5;
                
                this.logger.info(`Best bid: ${bestBid}, Bid liquidity: ${bidLiquidity} shares, Tick: ${tickSize}, Min: ${minOrderSize}`);

                // Apply proper rounding for sell orders
                const inverseTick = Math.round(1 / tickSize);
                const sellRoundedPrice = Math.floor(roundedPrice * inverseTick) / inverseTick; // Round DOWN for sells
                
                // Clamp price to valid range
                const finalPrice = sellRoundedPrice > 0.99 ? 0.99 : sellRoundedPrice < 0.01 ? 0.01 : sellRoundedPrice;
                
                // Round shares to avoid decimal precision issues
                const roundedShares = Math.floor(shares);
                
                // Validate minimum size
                if (roundedShares < minOrderSize) {
                    this.logger.warn(`Order size ${roundedShares} below minimum ${minOrderSize}`);
                    return { success: false, error: `Order size ${roundedShares} below minimum ${minOrderSize}`, sharesFilled: 0, priceFilled: 0 };
                }

                let remainingShares = roundedShares;

                // Strategy 1: Try FAK at best bid if liquidity exists
                if (bestBid && bidLiquidity > 0) {
                    try {
                        // Apply tick size rounding to best bid as well
                        const fakPrice = Math.floor(bestBid * inverseTick) / inverseTick;
                        
                        // Use createAndPostMarketOrder for FAK (immediate fill)
                        const fakResult = await this.client.createAndPostMarketOrder(
                            {
                                tokenID: params.tokenId,
                                amount: Math.floor(roundedShares * 1e6), // Amount in 1e6 precision
                                side: Side.SELL,
                                price: fakPrice, // Price limit
                            },
                            { negRisk, tickSize: tickSize as any },
                            OrderType.FAK // FAK for partial fills
                        );

                        if (fakResult && fakResult.success) {
                            const filled = parseFloat(fakResult.takingAmount) / 1e6 || 0;
                            this.logger.success(`FAK filled ${filled}/${roundedShares} shares at ${fakPrice}`);
                            
                            if (filled >= roundedShares) {
                                return { success: true, orderId: fakResult.orderID, txHash: fakResult.transactionHash, sharesFilled: filled, priceFilled: fakPrice };
                            }
                            
                            // Partial fill - update remaining shares for GTC
                            remainingShares = roundedShares - filled;
                        }
                    } catch (e) {
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        this.logger.warn(`FAK failed: ${errorMessage}`);
                    }
                }

                // Strategy 2: Place GTC limit order for remaining shares
                try {
                    const gtcPrice = bestBid ? Math.floor(bestBid * inverseTick) / inverseTick : finalPrice;
                    const gtcResult = await this.client.createAndPostOrder(
                        { 
                            tokenID: params.tokenId, 
                            price: gtcPrice, 
                            side: Side.SELL, 
                            size: Math.floor(remainingShares) // Raw shares
                        },
                        { negRisk, tickSize: tickSize as any },
                        OrderType.GTC
                    );

                    if (gtcResult && gtcResult.success) {
                        this.logger.success(`GTC placed: ${gtcResult.orderID} for ${remainingShares} @ ${gtcPrice}`);
                        const filledShares = roundedShares - remainingShares; // Amount already filled by FAK
                        return { success: true, orderId: gtcResult.orderID, txHash: gtcResult.transactionHash, sharesFilled: filledShares, priceFilled: gtcPrice };
                    }
                } catch (e) {
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    this.logger.error(`GTC failed: ${errorMessage}`);
                    return { success: false, error: errorMessage, sharesFilled: 0, priceFilled: 0 };
                }
                
                // Final fallback if all strategies fail
                return { success: false, error: "All sell strategies failed", sharesFilled: 0, priceFilled: 0 };
            } else {
                // Buy orders use GTC (updated from FOK)
                const res = await this.client.createAndPostOrder(
                    order, 
                    { negRisk, tickSize: tickSize as any }, 
                    OrderType.GTC
                );

                if (res && res.success) {
                    this.logger.success(`Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                    return { success: true, orderId: res.orderID, txHash: res.transactionHash, sharesFilled: shares, priceFilled: roundedPrice };
                }
                throw new Error(res.errorMsg || "Order failed response");
            }

        } catch (error: any) {
            if (retryCount < 1 && (String(error).includes("401") || String(error).includes("signature"))) {
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            return { success: false, error: error.message, sharesFilled: 0, priceFilled: 0 };
        }
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) { return false; }
    }

    async getOpenOrders(): Promise<any[]> {
        // Note: ClobClient doesn't have getOrders() method
        // This would need to be implemented via REST API or stored locally
        this.logger.warn('getOpenOrders() not implemented - ClobClient lacks getOrders method');
        return [];
    }

    async getOrderStatus(orderId: string): Promise<any | null> {
        if (!this.client) return null;
        try {
            // Use individual order lookup if available
            const order = await this.client.getOrder(orderId);
            return order;
        } catch (e) {
            this.logger.debug(`Failed to get order status: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }

    public getRawClient(): any {
        return this.client;
    }

    public getSigner(): any {
        return this.wallet;
    }
}