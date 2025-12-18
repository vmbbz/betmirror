
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
        this.logger.info(`[${this.exchangeName}] Initializing Adapter (Ethers v6/v5 Hybrid)...`);
        
        this.walletService = new EvmWalletService(this.config.rpcUrl, this.config.mongoEncryptionKey);
        
        if (this.config.walletConfig.encryptedPrivateKey) {
             // V6 for general operations
             this.wallet = await this.walletService.getWalletInstance(this.config.walletConfig.encryptedPrivateKey);
             // V5 for SDK stability
             this.walletV5 = await this.walletService.getWalletInstanceV5(this.config.walletConfig.encryptedPrivateKey);
        } else {
             throw new Error("Missing Encrypted Private Key for Trading Wallet");
        }

        // Initialize Safe Manager
        let safeAddressToUse = this.config.walletConfig.safeAddress;
        
        if (!safeAddressToUse) {
            this.logger.warn(`   ⚠️ Safe address missing in config. Computing...`);
            safeAddressToUse = await SafeManagerService.computeAddress(this.config.walletConfig.address);
        }

        if (!safeAddressToUse) {
             throw new Error("Failed to resolve Safe Address.");
        }

        this.safeManager = new SafeManagerService(
            this.wallet,
            this.config.builderApiKey,
            this.config.builderApiSecret,
            this.config.builderApiPassphrase,
            this.logger,
            safeAddressToUse 
        );

        this.safeAddress = this.safeManager.getSafeAddress();
        this.logger.info(`   Smart Bot Address: ${this.safeAddress}`);

        this.provider = new JsonRpcProvider(this.config.rpcUrl);
        this.usdcContract = new Contract(TOKENS.USDC_BRIDGED, USDC_ABI, this.provider);
    }

    async validatePermissions(): Promise<boolean> {
        return true;
    }

    async authenticate(): Promise<void> {
        if (!this.wallet || !this.safeManager || !this.safeAddress) throw new Error("Adapter not initialized");

        // 1. Ensure Safe is Deployed
        await this.safeManager.deploySafe();

        // 2. Ensure Approvals
        await this.safeManager.enableApprovals();

        // 3. L2 Auth (API Keys)
        let apiCreds = this.config.l2ApiCredentials;
        if (!apiCreds || !apiCreds.key) {
            this.logger.info('🤝 Deriving L2 API Keys...');
            await this.deriveAndSaveKeys();
            apiCreds = this.config.l2ApiCredentials; 
        } else {
             this.logger.info('🔌 Using existing CLOB Credentials');
        }

        // 4. Initialize Clob Client
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
            SignatureType.POLY_GNOSIS_SAFE, // Funder is Safe
            this.safeAddress, // Explicitly set funder (Maker)
            undefined, 
            undefined,
            builderConfig
        );
    }

    private async deriveAndSaveKeys() {
        try {
            // Keys must be derived using SignatureType.EOA because the EOA is the signer.
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
                { "tradingWallet.l2ApiCredentials": apiCreds }
            );
            this.config.l2ApiCredentials = apiCreds;
            this.logger.success('✅ API Keys Derived & Saved');
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
            asks: book.asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        };
    }

    async getPositions(address: string): Promise<PositionData[]> {
        try {
            const url = `https://data-api.polymarket.com/positions?user=${address}`;
            const res = await axios.get(url);
            if(!Array.isArray(res.data)) return [];
            return res.data.map((p: any) => ({
                marketId: p.conditionId || p.market,
                tokenId: p.asset,
                outcome: p.outcome || 'UNK',
                balance: Number(p.size),
                valueUsd: Number(p.size) * Number(p.price),
                entryPrice: Number(p.avgPrice || p.price),
                currentPrice: Number(p.price),
                question: p.title,
                image: p.icon,
                marketSlug: p.market_slug
            }));
        } catch(e) { return []; }
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
        if (!this.client) return { success: false, error: "Client not authenticated", sharesFilled: 0, priceFilled: 0 };

        try {
            const marketPromise = this.client.getMarket(params.marketId);
            const bookPromise = this.client.getOrderBook(params.tokenId);

            const [market, book] = await Promise.all([
                marketPromise.catch(e => null), 
                bookPromise.catch(e => null)
            ]);

            if (!market) throw new Error("Market data not available");
            if (!book) throw new Error("Orderbook not available (Liquidity check failed)");

            const negRisk = market.neg_risk;
            let minOrderSize = 5; 
            let tickSize = 0.01;

            if (book.tick_size) {
                tickSize = Number(book.tick_size);
            } else if (market.minimum_tick_size) {
                tickSize = Number(market.minimum_tick_size);
            }

            if (market.minimum_order_size) minOrderSize = Number(market.minimum_order_size);

            const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
            
            let rawPrice = params.priceLimit;

            if (rawPrice === undefined) {
                 if (side === Side.BUY) {
                     if (!book.asks || book.asks.length === 0) return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                     rawPrice = Number(book.asks[0].price); 
                 } else {
                     if (!book.bids || book.bids.length === 0) return { success: false, error: "skipped_no_liquidity", sharesFilled: 0, priceFilled: 0 };
                     rawPrice = Number(book.bids[0].price); 
                 }
            }

            // Price clamp safety
            if (rawPrice >= 0.99) rawPrice = 0.99;
            if (rawPrice <= 0.01) rawPrice = 0.01;

            // Tick alignment
            const inverseTick = Math.round(1 / tickSize);
            const roundedPrice = Math.floor(rawPrice * inverseTick) / inverseTick;
            
            let shares = params.sizeShares || 0;
            
            if (!shares && params.sizeUsd > 0) {
                 const rawShares = params.sizeUsd / roundedPrice;
                 shares = Math.ceil(rawShares);
            }

            // MINIMUM SHARE CHECK (5 Shares)
            if (shares < minOrderSize) {
                this.logger.warn(`⚠️ Order Rejected: Size (${shares}) < Minimum (${minOrderSize} shares). Req: $${params.sizeUsd.toFixed(2)} @ ${roundedPrice}`);
                return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 }; 
            }
            
            // MINIMUM USD AMOUNT CHECK ($1.00 USD hard requirement from CLOB error)
            const usdValue = shares * roundedPrice;
            if (usdValue < 1.00) {
                this.logger.warn(`⚠️ Order Rejected: Value ($${usdValue.toFixed(2)}) < $1.00 Minimum. Req: ${shares} shares @ ${roundedPrice}`);
                return { success: false, error: "skipped_min_usd_limit", sharesFilled: 0, priceFilled: 0 };
            }

            const order: any = {
                tokenID: params.tokenId,
                price: roundedPrice,
                side: side,
                size: shares,
                feeRateBps: 0,
                taker: "0x0000000000000000000000000000000000000000" 
            };

            this.logger.info(`📝 Placing Order (Safe): ${params.side} ${shares} shares @ $${roundedPrice} (Tick: ${tickSize})`);

            const res = await this.client.createAndPostOrder(
                order, 
                { 
                    negRisk,
                    tickSize: tickSize as any 
                }, 
                OrderType.FOK as any
            );

            if (res && res.success) {
                this.logger.success(`✅ Order Accepted. Tx: ${res.transactionHash || res.orderID || 'OK'}`);
                return { 
                    success: true, 
                    orderId: res.orderID, 
                    txHash: res.transactionHash, 
                    sharesFilled: shares,
                    priceFilled: roundedPrice
                };
            }
            
            throw new Error(res.errorMsg || "Order failed response");

        } catch (error: any) {
            const errStr = String(error);

            if (retryCount < 1 && (errStr.includes("401") || errStr.includes("403") || errStr.includes("invalid signature"))) {
                this.logger.warn("⚠️ Auth Error. Refreshing keys and retrying...");
                this.config.l2ApiCredentials = undefined; 
                await this.deriveAndSaveKeys();
                this.initClobClient(this.config.l2ApiCredentials);
                return this.createOrder(params, retryCount + 1);
            }
            
            if (error.response?.data) {
                this.logger.error(`[CLOB Client] request error ${JSON.stringify(error.response)}`);
            }

            const errorMsg = error.response?.data?.error || error.message;
            
            if (errorMsg?.includes("allowance")) {
                this.logger.error("❌ Failed: Insufficient Allowance. Retrying approvals...");
                await this.safeManager?.enableApprovals();
            } else if (errorMsg?.includes("balance")) {
                this.logger.error("❌ Failed: Insufficient USDC Balance.");
                return { success: false, error: "insufficient_funds", sharesFilled: 0, priceFilled: 0 };
            } else if (errorMsg?.includes("minimum") || errorMsg?.includes("invalid amount")) {
                 this.logger.error(`❌ Failed: Below Min Size (CLOB Rejection).`);
                 return { success: false, error: "skipped_min_size_limit", sharesFilled: 0, priceFilled: 0 };
            } else {
                this.logger.error(`Order Error: ${errorMsg}`);
            }
            return { success: false, error: "failed", sharesFilled: 0, priceFilled: 0 };
        }
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.cancelOrder({ orderID: orderId });
            return true;
        } catch (e) { return false; }
    }

    async cashout(amount: number, destination: string): Promise<string> {
        if (!this.safeManager) throw new Error("Safe Manager not initialized");
        const amountStr = Math.floor(amount * 1000000).toString();
        return await this.safeManager.withdrawUSDC(destination, amountStr);
    }
    
    getFunderAddress() {
        return this.safeAddress || this.config.walletConfig.address;
    }
}
