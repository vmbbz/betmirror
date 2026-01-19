import mongoose, { Schema } from 'mongoose';
import { DatabaseEncryptionService } from '../services/database-encryption.service.js';
// Initialize the encryption service immediately with the environment key
DatabaseEncryptionService.init(process.env.MONGO_ENCRYPTION_KEY || '');
const FlashMoveSchema = new Schema({
    tokenId: { type: String, required: true, index: true },
    conditionId: String,
    oldPrice: Number,
    newPrice: Number,
    velocity: Number,
    timestamp: { type: Date, default: Date.now, index: true },
    question: String,
    image: String,
    marketSlug: String
});
const MarketMetadataSchema = new Schema({
    conditionId: { type: String, required: true, unique: true, index: true },
    question: { type: String, required: true },
    image: String,
    marketSlug: String,
    eventSlug: String,
    acceptingOrders: { type: Boolean, default: true },
    closed: { type: Boolean, default: false },
    rewards: {
        max_spread: { type: Number, default: 15 },
        min_size: { type: Number, default: 10 },
        rates: Schema.Types.Mixed
    },
    tags: [Schema.Types.Mixed],
    minimum_order_size: { type: Number, default: 5 },
    minimum_tick_size: { type: Number, default: 0.01 },
    lastPrice: Number,
    volume24h: Number,
    liquidity: Number,
    updatedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});
const SportsMatchSchema = new Schema({
    matchId: { type: String, required: true, unique: true },
    conditionId: { type: String, required: true, index: true },
    homeTeam: String,
    awayTeam: String,
    league: String,
    lastScore: { type: [Number], default: [0, 0] },
    lastMinute: { type: Number, default: 0 },
    status: String,
    updatedAt: { type: Date, default: Date.now }
});
const MoneyMarketOpportunitySchema = new Schema({
    marketId: { type: String, required: true, index: true },
    tokenId: { type: String, required: true, unique: true },
    question: String,
    image: String,
    marketSlug: String,
    bestBid: Number,
    bestAsk: Number,
    spread: Number,
    spreadPct: Number,
    midpoint: Number,
    volume: Number,
    liquidity: Number,
    isNewMarket: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now, expires: 3600 }, // Expire after 1 hour
    roi: Number,
    capacityUsd: Number
});
const ActivePositionSchema = new Schema({
    tradeId: String,
    clobOrderId: String,
    marketId: String,
    conditionId: String,
    tokenId: String,
    outcome: String,
    entryPrice: Number,
    shares: Number,
    sizeUsd: Number,
    timestamp: Number,
    currentPrice: Number,
    question: String,
    image: String,
    marketSlug: {
        type: String,
        default: "",
        validate: {
            validator: function (v) {
                return !v || /^[a-z0-9-]+$/.test(v);
            },
            message: 'marketSlug must be lowercase with hyphens only'
        }
    },
    eventSlug: {
        type: String,
        default: "",
        validate: {
            validator: function (v) {
                return !v || /^[a-z0-9-]+$/.test(v);
            },
            message: 'eventSlug must be lowercase with hyphens only'
        }
    }
}, { _id: false });
const TradingWalletSchema = new Schema({
    address: { type: String, required: true },
    type: { type: String, required: true },
    encryptedPrivateKey: {
        type: String,
        required: true,
        select: false // Never include in queries by default
    },
    ownerAddress: { type: String, required: true },
    createdAt: { type: String, required: true },
    safeAddress: { type: String, required: true },
    isSafeDeployed: { type: Boolean, default: false },
    recoveryOwnerAdded: { type: Boolean, default: false },
    l2ApiCredentials: {
        key: {
            type: String,
            select: false // Never include in queries by default
        },
        secret: {
            type: String,
            select: false // Never include in already queries by default
        },
        passphrase: {
            type: String,
            select: false // Never include in queries by default
        }
    }
}, { _id: false });
// Apply field-level encryption to sensitive fields
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'encryptedPrivateKey');
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'l2ApiCredentials.key');
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'l2ApiCredentials.secret');
DatabaseEncryptionService.createEncryptionMiddleware(TradingWalletSchema, 'l2ApiCredentials.passphrase');
const UserSchema = new Schema({
    address: { type: String, required: true, unique: true, index: true },
    tradingWallet: TradingWalletSchema,
    activeBotConfig: { type: Schema.Types.Mixed },
    isBotRunning: { type: Boolean, default: false },
    activePositions: [ActivePositionSchema],
    stats: {
        totalPnl: { type: Number, default: 0 },
        totalVolume: { type: Number, default: 0 },
        totalFeesPaid: { type: Number, default: 0 },
        winRate: { type: Number, default: 0 },
        tradesCount: { type: Number, default: 0 },
        allowanceApproved: { type: Boolean, default: false },
        portfolioValue: { type: Number, default: 0 },
        cashBalance: { type: Number, default: 0 }
    },
    bookmarkedMarkets: { type: [String], default: [] },
    whalePreferences: { type: [String], default: [] }, // User's whale wallet watchlist
    cashoutHistory: [Schema.Types.Mixed],
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});
const TradeSchema = new Schema({
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    marketId: { type: String, required: true },
    clobOrderId: { type: String, index: true },
    assetId: String,
    outcome: String,
    side: String,
    size: Number,
    executedSize: { type: Number, default: 0 },
    price: Number,
    pnl: Number,
    status: String,
    txHash: String,
    aiReasoning: String,
    riskScore: Number,
    timestamp: { type: Date, default: Date.now },
    marketSlug: {
        type: String,
        default: "",
        validate: {
            validator: function (v) {
                return !v || /^[a-z0-9-]+$/.test(v);
            },
            message: 'marketSlug must be lowercase with hyphens only'
        }
    },
    eventSlug: {
        type: String,
        default: "",
        validate: {
            validator: function (v) {
                return !v || /^[a-z0-9-]+$/.test(v);
            },
            message: 'eventSlug must be lowercase with hyphens only'
        }
    },
    // Added serviceOrigin to the schema for DB persistence
    serviceOrigin: { type: String, index: true }
});
const RegistrySchema = new Schema({
    address: { type: String, required: true, unique: true },
    ens: String,
    winRate: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },
    tradesLast30d: { type: Number, default: 0 },
    followers: { type: Number, default: 0 },
    isVerified: { type: Boolean, default: false },
    isSystem: { type: Boolean, default: false },
    tags: [String],
    listedBy: String,
    listedAt: String,
    copyCount: { type: Number, default: 0 },
    copyProfitGenerated: { type: Number, default: 0 }
});
const FeedbackSchema = new Schema({
    userId: String,
    rating: Number,
    comment: String,
    timestamp: { type: Date, default: Date.now }
});
const BridgeTransactionSchema = new Schema({
    userId: { type: String, required: true, index: true },
    bridgeId: String,
    timestamp: String,
    fromChain: String,
    toChain: String,
    amountIn: String,
    amountOut: String,
    status: String,
    txHash: String,
    tool: String,
    fees: String
});
const DepositLogSchema = new Schema({
    userId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    txHash: { type: String, required: true, unique: true },
    timestamp: { type: Date, default: Date.now }
});
const BotLogSchema = new Schema({
    userId: { type: String, required: true, index: true },
    type: String,
    message: String,
    timestamp: { type: Date, default: Date.now, expires: 86400 * 3 }
});
// --- Models ---
export const User = mongoose.model('User', UserSchema);
export const Trade = mongoose.model('Trade', TradeSchema);
export const Registry = mongoose.model('Registry', RegistrySchema);
export const Feedback = mongoose.model('Feedback', FeedbackSchema);
// Re-export trade tracking models
export { CopiedTrade, HunterEarning, WalletAnalytics } from './trade-tracking.schema.js';
export const BridgeTransaction = mongoose.model('BridgeTransaction', BridgeTransactionSchema);
export const DepositLog = mongoose.model('DepositLog', DepositLogSchema);
export const BotLog = mongoose.model('BotLog', BotLogSchema);
export const FlashMove = mongoose.model('FlashMove', FlashMoveSchema);
export const MoneyMarketOpportunity = mongoose.model('MoneyMarketOpportunity', MoneyMarketOpportunitySchema);
export const MarketMetadata = mongoose.model('MarketMetadata', MarketMetadataSchema);
export const SportsMatch = mongoose.model('SportsMatch', SportsMatchSchema);
// --- Connection ---
export const connectDB = async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error('MONGO_URI environment variable is not defined');
    }
    // Validate database encryption key
    if (!DatabaseEncryptionService.validateEncryptionKey()) {
        console.warn('Database encryption key is not properly configured. Initializing now...');
        DatabaseEncryptionService.init(process.env.MONGO_ENCRYPTION_KEY || '');
    }
    try {
        mongoose.set('strictQuery', true);
        console.log(`🔌 Attempting to connect to MongoDB...`);
        await mongoose.connect(uri, {
            dbName: 'betmirror'
        });
        console.log(`📦 Connected to MongoDB successfully!`);
    }
    catch (error) {
        console.error('❌ MongoDB Connection Error:', error);
        throw error;
    }
};
