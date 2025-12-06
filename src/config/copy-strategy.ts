
export type CopyInputs = {
  yourUsdBalance: number;
  traderUsdBalance: number;
  traderTradeUsd: number;
  multiplier: number; // e.g., 1.0, 2.0
};

export type SizingResult = {
  targetUsdSize: number; // final USD size to place
  ratio: number; // your balance vs trader after trade
};

export function computeProportionalSizing(input: CopyInputs): SizingResult {
  const { yourUsdBalance, traderUsdBalance, traderTradeUsd, multiplier } = input;
  
  // 1. Calculate raw ratio
  // We use a minimum denominator of 1 to avoid division by zero
  const denom = Math.max(1, traderUsdBalance + Math.max(0, traderTradeUsd));
  const ratio = Math.max(0, yourUsdBalance / denom);
  
  // 2. Calculate raw target size
  const base = Math.max(0, traderTradeUsd * ratio);
  let targetUsdSize = Math.max(0, base * Math.max(0, multiplier));

  // 3. Smart Floor Logic (World Class Enhancement)
  // Polymarket requires a minimum order size (usually $1 or 5 shares).
  // We lower this to $0.50 to allow for micro-testing with small wallets ($2).
  // WARNING: This drastically increases risk for small wallets (betting 25% of port instead of 1%),
  // but it is necessary for the bot to function during testing.
  const MIN_ORDER_SIZE = 0.50; 

  if (targetUsdSize > 0 && targetUsdSize < MIN_ORDER_SIZE) {
      if (yourUsdBalance >= MIN_ORDER_SIZE) {
          // User has enough for a min bet, so we round up
          // This allows small wallets to still copy whales (albeit with higher risk ratio)
          targetUsdSize = MIN_ORDER_SIZE;
      } else {
          // User is too poor even for the min bet
          targetUsdSize = 0; 
      }
  }

  // 4. Cap at available balance (Safety)
  if (targetUsdSize > yourUsdBalance) {
      targetUsdSize = yourUsdBalance;
  }

  return { targetUsdSize, ratio };
}
