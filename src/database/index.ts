
import mongoose, { Schema, Document, Model } from 'mongoose';
import { TraderProfile } from '../domain/alpha.types';
import { ProxyWalletConfig } from '../domain/wallet.types';
import { ActivePosition, TradeHistoryEntry } from '../domain/trade.types';
import { UserStats } from '../domain/user.types';
import { BotConfig } from '../server/bot-engine';
import { BridgeTransactionRecord } from '../services/lifi-bridge.service';

// --- Interfaces ---

export interface IUser extends Document {
  address: string;
  proxyWallet?: ProxyWalletConfig;
  activeBotConfig?: BotConfig;
  isBotRunning: boolean;
  activePositions: ActivePosition[];
  stats: UserStats;
  cashoutHistory: any[];
  createdAt: Date;
  lastActive: Date;
}

export interface ITrade extends Document {
  userId: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  pnl?: number;
  status: string;
  txHash?: string;
  aiReasoning?: string;
  riskScore?: number;
  timestamp: Date;
}

export interface IRegistry extends Document, TraderProfile {}

export interface IFeedback extends Document {
  userId: string;
  rating: number;
  comment: string;
  timestamp: Date;
}

export interface IBridgeTransaction extends Document, Omit<BridgeTransactionRecord, 'id'> {
  userId: string;
  bridgeId: string; // Internal ID
}

// --- Schemas ---

const ActivePositionSchema = new Schema({
  marketId: String,
  tokenId: String,
  outcome: String,
  entryPrice: Number,
  sizeUsd: Number,
  timestamp: Number
}, { _id: false });

const ProxyWalletSchema = new Schema({
  address: String,
  type: String,
  serializedSessionKey: String,
  sessionPrivateKey: String,
  ownerAddress: String,
  createdAt: String
}, { _id: false });

const UserSchema = new Schema<IUser>({
  address: { type: String, required: true, unique: true, index: true },
  proxyWallet: ProxyWalletSchema,
  activeBotConfig: { type: Schema.Types.Mixed }, // Store flex config
  isBotRunning: { type: Boolean, default: false },
  activePositions: [ActivePositionSchema],
  stats: {
    totalPnl: { type: Number, default: 0 },
    totalVolume: { type: Number, default: 0 },
    totalFeesPaid: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    tradesCount: { type: Number, default: 0 },
    allowanceApproved: { type: Boolean, default: false }
  },
  cashoutHistory: [Schema.Types.Mixed],
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const TradeSchema = new Schema<ITrade>({
  userId: { type: String, required: true, index: true },
  marketId: { type: String, required: true },
  outcome: String,
  side: String,
  size: Number,
  price: Number,
  pnl: Number,
  status: String,
  txHash: String,
  aiReasoning: String,
  riskScore: Number,
  timestamp: { type: Date, default: Date.now }
});

const RegistrySchema = new Schema<IRegistry>({
  address: { type: String, required: true, unique: true },
  ens: String,
  winRate: { type: Number, default: 0 },
  totalPnl: { type: Number, default: 0 },
  tradesLast30d: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: false },
  listedBy: String,
  listedAt: String,
  copyCount: { type: Number, default: 0 },
  copyProfitGenerated: { type: Number, default: 0 }
});

const FeedbackSchema = new Schema<IFeedback>({
  userId: String,
  rating: Number,
  comment: String,
  timestamp: { type: Date, default: Date.now }
});

const BridgeTransactionSchema = new Schema<IBridgeTransaction>({
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

// --- Models ---

export const User = mongoose.model<IUser>('User', UserSchema);
export const Trade = mongoose.model<ITrade>('Trade', TradeSchema);
export const Registry = mongoose.model<IRegistry>('Registry', RegistrySchema);
export const Feedback = mongoose.model<IFeedback>('Feedback', FeedbackSchema);
export const BridgeTransaction = mongoose.model<IBridgeTransaction>('BridgeTransaction', BridgeTransactionSchema);

// --- Connection ---

export const connectDB = async (uri: string) => {
  try {
    mongoose.set('strictQuery', true);
    
    // Mask URI for safety in logs
    const maskedUri = uri.replace(/:\/\/.*@/, '://***:***@');
    console.log(`🔌 Attempting to connect to MongoDB...`);
    
    await mongoose.connect(uri);
    
    console.log(`📦 Connected to MongoDB successfully (${uri.includes('mongodb.net') ? 'Atlas Cloud' : 'Local'})`);
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};
