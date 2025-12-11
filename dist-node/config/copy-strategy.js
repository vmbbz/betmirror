export function computeProportionalSizing(input) {
    const { yourUsdBalance, traderUsdBalance, traderTradeUsd, multiplier, currentPrice, maxTradeAmount } = input;
    // 0. Safety: Valid Price
    const price = Math.max(0.01, currentPrice); // Prevent div by zero
    // 1. Calculate raw ratio
    // We use a minimum denominator of 1 to avoid division by zero
    const denom = Math.max(1, traderUsdBalance + Math.max(0, traderTradeUsd));
    const ratio = Math.max(0, yourUsdBalance / denom);
    // 2. Calculate raw target size based on proportion
    const base = Math.max(0, traderTradeUsd * ratio);
    let targetUsdSize = Math.max(0, base * Math.max(0, multiplier));
    let reason = "proportional";
    // 3. THE "SMART MATCH" LOGIC
    // A. The Hard Floor ($1.00)
    // Polymarket APIs typically reject orders < $1 (Dust). 
    // If the proportional math says "$0.05", we boost it to "$1.00" so the user actually participates.
    const SYSTEM_MIN_ORDER = 1.00;
    if (targetUsdSize < SYSTEM_MIN_ORDER) {
        if (yourUsdBalance >= SYSTEM_MIN_ORDER) {
            targetUsdSize = SYSTEM_MIN_ORDER;
            reason = "floor_boost_min_1";
        }
        else {
            // User has less than $1.00. 
            // Can they buy at least 1 share?
            if (yourUsdBalance > price) {
                targetUsdSize = yourUsdBalance; // All in (Micro-balance)
                reason = "all_in_micro";
            }
            else {
                targetUsdSize = 0; // Too poor to buy even 1 share
                reason = "insufficient_for_1_share";
            }
        }
    }
    // B. The Safety Ceiling (Max Cap)
    // If user has $1M and sets max trade to $500, we clamp.
    if (maxTradeAmount && targetUsdSize > maxTradeAmount) {
        targetUsdSize = maxTradeAmount;
        reason = "capped_at_max";
    }
    // C. The Wallet Cap
    if (targetUsdSize > yourUsdBalance) {
        targetUsdSize = yourUsdBalance;
        reason = "capped_at_balance";
    }
    // 4. Final Formatting
    // Polymarket requires strict 2-decimal precision for USDC amounts (FOK orders).
    // We floor to avoid "Insufficient Balance" due to 0.00001 diffs.
    targetUsdSize = Math.floor(targetUsdSize * 100) / 100;
    return { targetUsdSize, ratio, reason };
}
