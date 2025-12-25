# 🏛️ Scalable Trading Architecture Plan

**Objective:** Upgrade the Bet Mirror backend to support multiple prediction markets (Polymarket, Kalshi, PredictBase) while maintaining robust authentication and high-performance execution.

## 1. The Core Problem (RESOLVED)
The previous architecture used simple EOAs which required users to manage GAS (MATIC) and limited our ability to perform advanced operations.
*   **Resolution:** We have implemented a **Gnosis Safe + Relayer Model**.
*   **Mechanism:** We use the `Signer` (EOA) to sign standard messages/orders, while using the `Safe Address` as the "Funder". The Polymarket Relayer handles gas abstraction.

## 2. Performance Upgrades (COMPLETED)

To handle high-frequency signals and ensure 24/7 reliability, we have applied the following optimizations:

### A. Memory Leak Prevention (`TradeMonitor`)
*   **Problem:** Storing every processed transaction hash in a `Set` indefinitely causes OOM crashes after weeks of runtime.
*   **Fix:** Implemented an **LRU (Least Recently Used)** pruning strategy using a `Map<Hash, Timestamp>`. Hashes older than the aggregation window (5 mins) are automatically removed.

### B. Latency Reduction (`TradeExecutor`)
*   **Problem:** Fetching a whale's portfolio balance takes 300ms-800ms via HTTP. Doing this *before* every trade slows down execution.
*   **Fix:** Implemented **WhaleBalanceCache**. We cache balance data for 5 minutes. Subsequent signals from the same whale execute instantly without waiting for the Data API.

### C. Execution Intelligence (Absolute Pricing)
*   **Context**: Prediction markets often trade at extreme ends of the $0-$1 spectrum.
*   **Optimization**: Switched from percentage-based slippage to **Absolute Cent Gap** monitoring. This allows the bot to trade in high-volume, low-price markets (like $0.02) where a 1-cent gap is mathematically a 50% spread but practically a high-liquidity environment.
*   **Book Sweep**: Implemented a "Sweep" logic for SELL orders. The bot analyzes the bid-side depth and executes a Fill-And-Kill (FAK) order to capture the best possible weighted average price instantly.

### D. RPC Rate Limit Protection (`FundManager`)
*   **Problem:** Checking the blockchain balance every few seconds burns through RPC credits and can trigger IP bans.
*   **Fix:** Implemented **Throttling**. The Auto-Cashout logic now only runs once per hour (or upon specific trigger events), reducing RPC load by 99%.

## 3. The Solution: Exchange Adapter Pattern

We have abstracted the specific logic of each exchange into **Adapters**. The `BotEngine` does not care *how* a trade is executed, only that it *is* executed.

### A. The Interface (`IExchangeAdapter`)

Every market integration implements this contract:

```typescript
export interface IExchangeAdapter {
    readonly exchangeName: string;
    
    // Lifecycle
    initialize(): Promise<void>;
    
    // Auth & Setup
    validatePermissions(): Promise<boolean>;
    authenticate(): Promise<void>;
    
    // Market Data
    fetchBalance(address: string): Promise<number>;
    getMarketPrice(marketId: string, tokenId: string): Promise<number>;
    
    // Execution
    createOrder(params: OrderParams): Promise<OrderResult>;
    cancelOrder(orderId: string): Promise<boolean>;
    
    // Order Management
    cashout(amount: number, destination: string): Promise<string>;
    
    // Legacy Accessors (Optional)
    getFunderAddress?(): string | undefined;
}
```

### B. Polymarket Implementation (`PolymarketAdapter`)

This adapter encapsulates the Gnosis Safe logic.

*   **Signer:** Uses `ethers.Wallet` (EOA) initialized with the **Encrypted Private Key**.
*   **Funder:** Uses the **Gnosis Safe Address** as the `funderAddress` in the CLOB Client.
*   **Auth:** Performs the `createOrDeriveApiKey` handshake using `SignatureType.POLY_GNOSIS_SAFE`.
*   **Gas:** Uses `SafeManagerService` to route withdrawals via the Relayer.

### C. Future Scaling (PredictBase Example)

The architecture is fully ready for **PredictBase** (or Kalshi) integration. To add PredictBase:

1.  **Create Adapter:** `src/adapters/predictbase/predictbase.adapter.ts`.
2.  **Implement Contract:**
    *   `getPositions()`: Map PredictBase's API response to our `PositionData` type.
    *   `createOrder()`: Use the PredictBase SDK to submit the order.
3.  **Inject:** Simply change the import in `bot-engine.ts`.

This ensures that the core bot logic (AI Risk Analysis, Notification Service, Database Sync, and **AES-256 Encryption**) remains **100% reusable** across different markets.
