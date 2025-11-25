
# Bet Mirror | Pro Cloud Terminal

**The world's first AI-powered, 24/7 server-side copy trading platform for Polymarket.**

## 🏗 Architecture

1.  **Trustless Auth (Account Abstraction):** 
    - Users connect via **MetaMask/Phantom**.
    - The system deploys a **ZeroDev Smart Account** (Kernel v3.1) on Polygon.
    - Users sign a **Session Key** giving the server permission to trade (but not withdraw).
    
2.  **Server Engine (Node.js):**
    - Runs 24/7.
    - Tracks **Real PnL** by remembering entry prices.
    - Uses the Session Key to sign UserOps.

3.  **Cross-Chain Bridging (Li.Fi):**
    - Fund your bot directly from Base, BSC, Arbitrum, or Solana.
    - **0.5% Protocol Fee** applied to bridge transactions.

## 🚀 Features

*   **Wallet (Formerly Vault):** Manage your Smart Account, view keys, and configure strategy.
*   **System:** View global platform metrics (Volume, Revenue, Active Bots).
*   **Registry:** Copy high-performance traders and earn 1% fees if you list your own wallet.
*   **Bridge:** Seamlessly deposit funds from any chain.

## 🛠 Quick Start

### 1. Installation
```bash
npm install
```

### 2. Configuration (.env)

You must configure the `.env` file for the application to function correctly.

**Admin Revenue**
```env
# Revenue Wallet (Where 1% Fees are sent)
ADMIN_REVENUE_WALLET=0xYourColdWallet
```

**ZeroDev (Account Abstraction)**
*Required for Smart Accounts to work on Polygon.*
1.  Go to [ZeroDev Dashboard](https://dashboard.zerodev.app).
2.  Create a Project on **Polygon Mainnet**.
3.  Copy your Project ID.
```env
ZERODEV_RPC=https://rpc.zerodev.app/api/v2/bundler/YOUR_PROJECT_ID_HERE
ZERODEV_PROJECT_ID=YOUR_PROJECT_ID_HERE
```

**Polymarket API Keys (Admin Only)**
*Note: Regular users use Smart Accounts and do not need these keys. These are only for Headless/Admin bots.*
```env
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
```

**Li.Fi (Bridging)**
*Required for official integration and fee collection.*
1.  The app works out of the box with public endpoints.
2.  To collect the 0.5% integrator fee, register your project name with Li.Fi and update the `integrator` string in `src/services/lifi-bridge.service.ts`.

### 3. Run
```bash
npm run dev:all
```
Open `http://localhost:5173`.
