export function computeProportionalSizing(input) {
    const { yourUsdBalance, traderUsdBalance, traderTradeUsd, multiplier, currentPrice, maxTradeAmount, minOrderSize = 5 // Default to 5 shares if not provided
     } = input;
    // 0. Safety: Valid Price
    const price = Math.max(0.01, Math.min(0.99, currentPrice)); // Prevent div by zero and invalid ranges
    // 1. Calculate raw ratio
    const denom = Math.max(1, traderUsdBalance + Math.max(0, traderTradeUsd));
    const ratio = Math.max(0, yourUsdBalance / denom);
    // 2. Calculate raw target size based on proportion
    const base = Math.max(0, traderTradeUsd * ratio);
    let targetUsdSize = Math.max(0, base * Math.max(0, multiplier));
    let reason = "proportional";
    // 3. THE "SMART MATCH" LOGIC
    // A. Calculate minimum USD needed for minimum shares
    // CRITICAL FIX: We need at least (minOrderSize * price) USD to get minOrderSize shares
    const minUsdForMinShares = minOrderSize * price;
    const SYSTEM_MIN_ORDER = Math.max(1.00, minUsdForMinShares);
    if (targetUsdSize < SYSTEM_MIN_ORDER) {
        if (yourUsdBalance >= SYSTEM_MIN_ORDER) {
            targetUsdSize = SYSTEM_MIN_ORDER;
            reason = "floor_boost_min_shares";
        }
        else {
            // User cannot afford minimum shares
            return {
                targetUsdSize: 0,
                targetShares: 0,
                ratio,
                reason: "insufficient_for_min_shares"
            };
        }
    }
    // B. The Safety Ceiling (Max Cap)
    if (maxTradeAmount && targetUsdSize > maxTradeAmount) {
        targetUsdSize = maxTradeAmount;
        reason = "capped_at_max";
    }
    // C. The Wallet Cap
    if (targetUsdSize > yourUsdBalance) {
        targetUsdSize = yourUsdBalance;
        reason = "capped_at_balance";
    }
    // 4. Final Formatting - ROUND UP to ensure we have enough for shares
    // Using Math.ceil instead of Math.floor to avoid losing shares due to precision
    targetUsdSize = Math.ceil(targetUsdSize * 100) / 100;
    // 5. Calculate expected shares and validate
    const expectedShares = Math.floor(targetUsdSize / price);
    // 6. Final validation: If we still can't get minimum shares, reject or boost
    if (expectedShares < minOrderSize) {
        // Try to boost USD to exactly meet minimum shares
        const boostUsd = Math.ceil((minOrderSize * price) * 100) / 100;
        if (boostUsd <= yourUsdBalance && (!maxTradeAmount || boostUsd <= maxTradeAmount)) {
            targetUsdSize = boostUsd;
            reason = "boosted_for_min_shares";
        }
        else {
            return {
                targetUsdSize: 0,
                targetShares: 0,
                ratio,
                reason: "cannot_meet_min_shares"
            };
        }
    }
    const finalShares = Math.floor(targetUsdSize / price);
    return {
        targetUsdSize,
        targetShares: finalShares,
        ratio,
        reason
    };
}
