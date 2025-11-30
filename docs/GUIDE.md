
# 📘 Bet Mirror Pro | User & Technical Guide

Welcome to the institutional-grade prediction market terminal. This guide covers everything from your first deposit to the technical architecture powering the bot.

---

## 🚀 Getting Started: What Next?

Now that you have connected your wallet and activated your **Smart Account**, here is your roadmap to profit.

### 1. Fund Your Bot
Your Smart Account lives on the **Polygon** network. You need **USDC** to trade.
*   **Option A (Direct):** If you already have USDC on Polygon, send it to the address shown in the Dashboard (top left card).
*   **Option B (Bridge):** Go to the **Bridge** tab. Select your source chain (Base, Solana, Ethereum, Arbitrum) and transfer funds. Our Li.Fi integration handles the swapping and bridging automatically.
*   **Gas?** You do **NOT** need MATIC. We use a Paymaster to sponsor gas fees or pay them in USDC.

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

## 🧠 Technical Deep Dive: Polymarket CLOB

Bet Mirror is not a derivative platform. We interact directly with the **Polymarket Central Limit Order Book (CLOB)**.

### How it works
1.  **Signal Detection:** We monitor the `Activity` endpoints of target wallets in real-time.
2.  **Order Construction:** When a target buys `YES` on "Bitcoin > 100k", your bot constructs an identical order.
3.  **Attribution:** We inject specific **Builder Headers** (`POLY_BUILDER_API_KEY`) into the API request. This identifies your trade as coming from "Bet Mirror" infrastructure, allowing us to participate in the **Polymarket Builder Program**.
4.  **Execution:** The order is cryptographically signed by your Session Key and submitted to the Relayer.
5.  **Settlement:** The trade settles on the CTF Exchange contract on Polygon.

### Architecture Comparison

We align closely with Polymarket's native architecture but optimize for **High-Frequency Copy Trading**.

| Feature | Polymarket Native | Bet Mirror Pro | Why we chose this |
| :--- | :--- | :--- | :--- |
| **Smart Account** | Gnosis Safe | **ZeroDev Kernel v3.1** | Kernel is significantly lighter and cheaper for high-volume automated transactions than Safe. |
| **Signing** | User Signs (Metamask) | **Session Keys** | Allows 24/7 server-side execution without the user needing to be online to sign every trade. |
| **Gas** | Relayer (Gasless) | **ERC-4337 Paymaster** | Standardized, decentralized infrastructure to pay network fees in USDC. |
| **Liquidity** | CLOB | **CLOB** | We access the exact same liquidity depth as the main site. No side pools. |

---

## 🛡️ Security & Recovery

### Non-Custodial Promise
*   **We do not hold your funds.** Your funds live in a Smart Contract on the blockchain.
*   **We cannot withdraw.** The "Session Key" held by the bot is restricted. It can only call `createOrder`. It cannot call `transfer`.

### Emergency Recovery
If the Bet Mirror website goes offline forever:
1.  Go to any ERC-4337 Explorer (like Jiffyscan).
2.  Your Smart Account Address is deterministic based on your Owner Wallet.
3.  You can interact directly with the contract to withdraw funds using your Metamask/Phantom wallet.

---

## 💎 The Alpha Registry Economy

*   **List:** Anyone can list a wallet in the Marketplace.
*   **Earn:** If users copy you, **1% of their net profit** is sent to your wallet automatically via a smart contract transfer.
*   **Grow:** High win-rate traders rise to the top of the leaderboard.
