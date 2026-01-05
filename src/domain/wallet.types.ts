
export type WalletType = 'TRADING_EOA' | 'GNOSIS_SAFE';

export interface L2ApiCredentials {
    key: string;        // Client expects 'key'
    secret: string;     // Client expects 'secret'
    passphrase: string;
}

import { AutoCashoutConfig } from './trade.types.js';

export interface TradingWalletConfig {
  address: string; // The EOA Signer Address (Controller)
  type: WalletType;
  
  // Encrypted Private Key (Server-Side Custody)
  encryptedPrivateKey: string; 
  
  // Link to the main user
  ownerAddress: string; 
  createdAt: string;
  
  // Auto-cashout configuration for this wallet
  autoCashout?: AutoCashoutConfig;

  // L2 Auth Credentials
  l2ApiCredentials?: L2ApiCredentials;

  // GNOSIS SAFE SOURCE OF TRUTH
  // Once set, this NEVER changes. It is the vault.
  safeAddress?: string; 
  
  // Track if we have confirmed code on-chain
  isSafeDeployed?: boolean; 
  
  // Metadata for recovery (Salt used to derive)
  saltNonce?: number;

  // Track if recovery owner (Main Wallet) has been added to Safe
  recoveryOwnerAdded?: boolean;
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  formatted: string;
}
