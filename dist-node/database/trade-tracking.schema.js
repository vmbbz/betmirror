import mongoose, { Schema } from 'mongoose';
const CopiedTradeSchema = new Schema({
    sourceWallet: { type: String, required: true, index: true },
    copierUserId: { type: String, required: true, index: true },
    tradeId: { type: String, required: true },
    marketId: { type: String, required: true },
    outcome: { type: String, required: true },
    side: { type: String, required: true },
    sizeUsd: { type: Number, required: true },
    executedSize: { type: Number, required: true },
    price: { type: Number, required: true },
    timestamp: { type: Date, required: true, index: true },
    txHash: String,
    isSuccessful: { type: Boolean, default: true },
    profitUsd: Number
});
const HunterEarningSchema = new Schema({
    hunterAddress: { type: String, required: true, index: true },
    sourceWallet: { type: String, required: true, index: true },
    tradeId: { type: String, required: true },
    copierUserId: { type: String, required: true },
    profitUsd: { type: Number, required: true },
    hunterFeeUsd: { type: Number, required: true },
    platformFeeUsd: { type: Number, required: true },
    txHash: String,
    timestamp: { type: Date, required: true, index: true }
});
const WalletAnalyticsSchema = new Schema({
    walletAddress: { type: String, required: true, unique: true, index: true },
    totalCopiedTrades: { type: Number, default: 0 },
    successfulBuys: { type: Number, default: 0 },
    totalProfitGenerated: { type: Number, default: 0 },
    totalFeesEarnedByHunters: { type: Number, default: 0 },
    uniqueCopiers: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now }
});
export const CopiedTrade = mongoose.model('CopiedTrade', CopiedTradeSchema);
export const HunterEarning = mongoose.model('HunterEarning', HunterEarningSchema);
export const WalletAnalytics = mongoose.model('WalletAnalytics', WalletAnalyticsSchema);
