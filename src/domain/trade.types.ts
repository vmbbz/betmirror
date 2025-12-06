
export type TradeSignal = {
  trader: string;
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
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
  status: 'OPEN' | 'CLOSED' | 'SKIPPED' | 'FAILED';
  txHash?: string;
  // Metadata for UI
  aiReasoning?: string;
  riskScore?: number;
};

// Tracks open positions to calculate REAL PnL on sell
export interface ActivePosition {
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  entryPrice: number;
  sizeUsd: number;
  timestamp: number;
}
