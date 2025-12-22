import mongoose, { Schema, Document } from 'mongoose';

// Global tracking for copied trades
export interface ICopiedTrade extends Document {
  sourceWallet: string;
  copierUserId: string;
  tradeId: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  executedSize: number;
  price: number;
  timestamp: Date;
  txHash?: string;
  isSuccessful: boolean;
  profitUsd?: number; // Only for SELL trades
}

// Wallet hunter earnings tracking
export interface IHunterEarning extends Document {
  hunterAddress: string;
  sourceWallet: string;
  tradeId: string;
  copierUserId: string;
  profitUsd: number;
  hunterFeeUsd: number; // 1% of profit
  platformFeeUsd: number; // 1% of profit
  txHash?: string;
  timestamp: Date;
}

// Enhanced wallet performance analytics
export interface IWalletAnalytics extends Document {
  walletAddress: string;
  totalCopiedTrades: number;
  successfulBuys: number;
  totalProfitGenerated: number; // Total profit for all copiers
  totalFeesEarnedByHunters: number;
  uniqueCopiers: number;
  lastUpdated: Date;
}

const CopiedTradeSchema = new Schema<ICopiedTrade>({
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

const HunterEarningSchema = new Schema<IHunterEarning>({
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

const WalletAnalyticsSchema = new Schema<IWalletAnalytics>({
  walletAddress: { type: String, required: true, unique: true, index: true },
  totalCopiedTrades: { type: Number, default: 0 },
  successfulBuys: { type: Number, default: 0 },
  totalProfitGenerated: { type: Number, default: 0 },
  totalFeesEarnedByHunters: { type: Number, default: 0 },
  uniqueCopiers: { type: Number, default: 0 },
  lastUpdated: { type: Date, default: Date.now }
});

export const CopiedTrade = mongoose.model<ICopiedTrade>('CopiedTrade', CopiedTradeSchema);
export const HunterEarning = mongoose.model<IHunterEarning>('HunterEarning', HunterEarningSchema);
export const WalletAnalytics = mongoose.model<IWalletAnalytics>('WalletAnalytics', WalletAnalyticsSchema);
