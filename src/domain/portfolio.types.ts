import { ActivePosition } from './trade.types.js';

export interface PositionBreakdown {
  marketId: string;
  outcome: string;
  shares: number;
  entryPrice: number;
  currentPrice: number;
  value: number;
  pnl: number;
}

export interface PortfolioSnapshot {
  id: string;
  userId: string;
  timestamp: Date;
  totalValue: number;
  cashBalance: number;
  positionsValue: number;
  positionsCount: number;
  totalPnL: number;
  totalPnLPercent: number;
  positionsBreakdown: PositionBreakdown[];
}

export interface PortfolioAnalytics {
  userId: string;
  period: '1D' | '1W' | '30D' | 'ALL';
  snapshots: PortfolioSnapshot[];
  startingValue: number;
  endingValue: number;
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
}