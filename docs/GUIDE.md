# 📘 Bet Mirror Pro | User & Technical Guide

Welcome to the institutional-grade prediction market terminal. This guide covers everything from your first deposit to the technical architecture powering the bot.

---

## 🚀 Getting Started: What Next?

Now that you have connected your wallet and initialized your **Trading Wallet**, here is your roadmap to profit.

### 1. Fund Your Bot
Your Trading Wallet (Gnosis Safe) lives on the **Polygon** network. You primarily need **USDC.e** to trade.
*   **Option A (Direct):** If you already have funds on Polygon, send them to the **Smart Bot** address shown in the Dashboard (top left card).
*   **Option B (Bridge):** Go to the **Bridge** tab. Select your source chain (Base, Solana, Ethereum, Arbitrum) and transfer funds. Our Li.Fi integration handles the swapping and bridging automatically.
*   **Gas:** Bet Mirror uses the **Polymarket Relayer** to pay for gas fees on your behalf. You do **NOT** need to hold POL (Matic) to trade, though having a small amount for emergency manual withdrawals is optional.

### 2. Select Traders (Marketplace)
Go to the **Marketplace** tab.
*   Browse the **Alpha Registry** to find "Whales" or high-win-rate traders.
*   Click **COPY** on a trader to add them to your target list.
*   *Tip: Look for the "OFFICIAL" badge for system-verified wallets.*

### 3. Configure Strategy (Vault)
Go to the **Vault** tab to fine-tune your risk.
*   **Multiplier:** Want to bet bigger than the whale? Set `1.5x` or `2.0x`.
*   **Risk Profile:**
    *   **Conservative:** AI blocks trades on volatile markets.
    *   **Degen:** AI allows almost everything.
*   **Auto-Cashout:** Set a threshold (e.g., $1000). Profits above this are automatically swept back to your main cold wallet.

### 4. Start the Engine
Click the **START ENGINE** button in the header.
*   The bot will spin up on our cloud server.
*   You can now close your browser. The bot runs 24/7.
*   Monitor your **Dashboard** for live logs and PnL updates.

---

## 🧠 Technical Deep Dive: Execution & Liquidity

Bet Mirror is not a simple script; it is a high-performance execution engine designed to protect your capital while capturing the best possible prices on the **Polymarket Central Limit Order Book (CLOB)**.

### Order Execution Logic
Our engine handles **Buying** and **Selling** with distinct, optimized strategies:

#### 🟢 Buying (Entry)
*   **Proportional Sizing**: The bot calculates your position size based on the whale's portfolio percentage, adjusted by your multiplier.
*   **Slippage Protection**: We calculate a 5% buffer on the whale's entry price. If the market moves too fast and the price exceeds this buffer, the bot skips the trade to avoid overpaying.
*   **Minimum Thresholds**: Every order must meet the exchange minimum of 5 shares and $1.00 value. The bot automatically "boosts" tiny whale signals to meet these requirements if you have the balance.

#### 🔴 Selling (Exit)
*   **Book Sweep Strategy**: When selling, the bot doesn't just place a static limit. It constructs a "Sweep" order targeting the best available bids. This ensures you liquidate your position instantly at the highest possible weighted average price.
*   **FAK (Fill-And-Kill)**: We use FAK order types for exits. This means the bot captures all available liquidity at our floor price immediately, then "kills" the remainder to prevent stuck orders in a crashing market.

### Liquidity Shields & Absolute Spreads
Standard trading bots use **Percentage Spreads** to determine market health. However, in prediction markets, this metric is mathematically flawed at extreme prices. 
*   **The Problem:** A 1-cent gap at a price of $0.02 is a 50% spread. Most bots would skip this, thinking it's illiquid.
*   **Our Solution:** Bet Mirror Pro uses **Absolute Cents Gap**. If the gap is 1 or 2 cents, the bot considers it highly liquid, regardless of the percentage.
*   **Health Ranks**:
    *   **HIGH**: Spread <= 2 cents AND Depth >= $500 USD.
    *   **MEDIUM**: Spread <= 5 cents AND Depth >= $100 USD.
    *   **LOW**: Depth exists ($20+) but spread may be wider.
*   *You can configure your "Liquidity Filter" in the Vault to ensure the bot only enters markets with deep order books.*

---

## 🛡️ Security & Recovery

### Field-Level Encryption (FLE)
To provide institutional-grade protection, Bet Mirror Pro implements **AES-256-GCM** field-level encryption for all sensitive database fields.
*   **Scrypt Key Derivation**: The master encryption key is derived using the Scrypt algorithm with high iteration counts, performed once at server startup for performance.
*   **Automatic Middleware**: Mongoose hooks automatically encrypt `encryptedPrivateKey` and `l2ApiCredentials` before they hit the database.
*   **No Plain-Text Storage**: Even if a database dump is compromised, your private keys and API credentials remain encrypted and unusable without the server's environment key.

### Dedicated Wallet Model
*   **Isolation:** We create a specific wallet configuration just for your bot. This limits risk. Even if the bot key were compromised, your Main Wallet (MetaMask) remains safe.
*   **Encryption:** Your bot's private key (Signer) is encrypted in our database using **AES-256-GCM**. It is only decrypted in server memory for the split-second required to sign an order.

### Emergency Recovery
To withdraw funds:
1.  Use the **Withdraw** button on the Dashboard.
2.  This triggers the server to instruct the Relayer to move funds from your Safe back to your Main Wallet.
3.  **Manual Recovery (Trustless):** If you enabled **Multi-Sig Sovereignty** in the Vault, your Main Wallet is a co-owner of the Safe. You can interact directly with the Gnosis Safe contracts on Etherscan or the Gnosis UI to move funds, bypassing the Bet Mirror server entirely.

---

## 💎 The Alpha Registry Economy

*   **List:** Anyone can list a wallet in the Marketplace.
*   **Earn:** If users copy a wallet you listed, **1% of their net profit** is sent to *your* wallet automatically.
*   **Finder's Fee:** You don't have to be the trader. You just need to be the one who found them.
