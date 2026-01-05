export interface AutoCashoutConfig {
  enabled: boolean;
  percentage: number;
  destinationAddress?: string;
  sweepThreshold?: number; // Minimum balance to keep in the wallet before sweeping
}

export type TradeSignal = {
  trader: string;
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
  autoCashout?: AutoCashoutConfig;
};

export type TradeEvent = {
  trader: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
};

// Added marketSlug and eventSlug to TradeHistoryEntry for UI deep links
export type TradeHistoryEntry = {
  id: string;
  timestamp: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  executedSize?: number;
  price: number;
  pnl?: number;
  status: 'OPEN' | 'CLOSED' | 'SKIPPED' | 'FAILED' | 'FILLED';
  txHash?: string;
  // Metadata for UI
  aiReasoning?: string;
  riskScore?: number;
  // CLOB Tracking
  clobOrderId?: string;
  assetId?: string;
  marketSlug?: string;
  eventSlug?: string;
};

// Tracks open positions to calculate REAL PnL on sell
export interface ActivePosition {
  tradeId: string; // Link to the original TradeHistoryEntry._id
  clobOrderId?: string; // The specific order ID on Polymarket
  marketId: string;
  conditionId?: string; // The condition ID used by Polymarket's CLOB API
  tokenId: string; // The token ID for the position
  outcome: 'YES' | 'NO';
  entryPrice: number;
  currentPrice?: number; // Current market price
  shares: number; // Exact number of shares held (Critical for selling)
  valueUsd: number; // Current market value in USD
  sizeUsd: number; // Initial invested amount
  pnl?: number; // Profit and Loss in USD
  pnlPercentage?: number; // PnL as a percentage of investment
  lastUpdated?: number; // Timestamp of last update
  autoCashout?: AutoCashoutConfig; // Auto-cashout configuration
  investedValue?: number; // Total amount invested
  timestamp: number; // When the position was opened
  unrealizedPnL?: number; // Unrealized PnL in USD
  unrealizedPnLPercent?: number;
  question?: string;
  image?: string;
  endDate?: string;
  marketSlug?: string;
  eventSlug?: string;
  // Market State Tracking
  marketState?: 'ACTIVE' | 'CLOSED' | 'RESOLVED' | 'ARCHIVED';
  marketAcceptingOrders?: boolean;
  marketActive?: boolean;
  marketClosed?: boolean;
  marketArchived?: boolean;
  // --- NEW: MM MANAGEMENT FIELDS ---
  managedByMM?: boolean;      // True if this position is part of a market-making strategy
  inventorySkew?: number;     // -1.0 to 1.0 (Shows if we are heavy on YES or NO)
  activeBidPrice?: number;    // Current resting bid
  activeAskPrice?: number;    // Current resting ask
  // ---
  // Resolution and Metadata
  isResolved?: boolean; // Whether the market has been resolved
  updatedAt?: Date; // When the position metadata was last updated
  // Additional metadata fields for display
  description?: string;
  category?: string;
  resolutionSource?: string;
  resolutionTime?: string;
  winningOutcome?: 'YES' | 'NO' | 'INVALID' | 'CANCELED';
  // Trading status
  isTradable?: boolean;
  // Volume and liquidity metrics
  volume24h?: number;
  openInterest?: number;
  // Additional metadata for UI
  metadata?: {
    [key: string]: any; // Flexible metadata storage
  };
}
