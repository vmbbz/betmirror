
export type TrackedUser = {
  address: string;
};

export interface UserStats {
  totalPnl: number;
  totalVolume: number;
  totalFeesPaid: number;
  winRate: number;
  tradesCount: number;
  allowanceApproved: boolean;
  portfolioValue: number;
  cashBalance: number;
}
