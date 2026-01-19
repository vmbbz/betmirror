// Portfolio tracking types for performance analytics

export interface PortfolioSnapshot {
  id: string;
  userId: string;
  timestamp: Date;
  totalValue: number; // Total portfolio value (cash + positions)
  cashBalance: number; // Available cash
  positionsValue: number; // Value of all positions
  positionsCount: number; // Number of active positions
  totalPnL: number; // Cumulative P&L
  totalPnLPercent: number; // P&L percentage
  // Optional: Store positions breakdown for detailed analytics
  positionsBreakdown?: Array<{
    marketId: string;
    outcome: string;
    shares: number;
    entryPrice: number;
    currentPrice: number;
    value: number;
    pnl: number;
  }>;
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
  sharpeRatio?: number;
  volatility?: number;
}
