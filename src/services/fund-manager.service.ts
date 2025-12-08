
import { Wallet, Contract, formatUnits, parseUnits } from 'ethers';
import { Logger } from '../utils/logger.util.js';
import { NotificationService } from './notification.service.js';
import { CashoutRecord } from '../domain/alpha.types.js';

const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

export interface FundManagerConfig {
  enabled: boolean;
  maxRetentionAmount?: number;
  destinationAddress?: string;
  usdcContractAddress: string;
}

export class FundManagerService {
  private usdcContract: Contract;
  private lastCheckTime: number = 0;
  private readonly THROTTLE_MS = 60 * 60 * 1000; // Check max once per hour unless forced

  constructor(
    private wallet: Wallet,
    private config: FundManagerConfig,
    private logger: Logger,
    private notifier: NotificationService
  ) {
    this.usdcContract = new Contract(config.usdcContractAddress, USDC_ABI, wallet);
  }

  async checkAndSweepProfits(force: boolean = false): Promise<CashoutRecord | null> {
    if (!this.config.enabled || !this.config.destinationAddress || !this.config.maxRetentionAmount) {
      return null;
    }

    // THROTTLING: Avoid hitting RPC limits with frequent balance checks
    if (!force && Date.now() - this.lastCheckTime < this.THROTTLE_MS) {
        return null;
    }
    this.lastCheckTime = Date.now();

    try {
      const balanceBigInt = await this.usdcContract.balanceOf(this.wallet.address);
      const balance = parseFloat(formatUnits(balanceBigInt, 6));

      this.logger.info(`🏦 Vault Check: Proxy Balance $${balance.toFixed(2)} (Cap: $${this.config.maxRetentionAmount})`);

      if (balance > this.config.maxRetentionAmount) {
        const sweepAmount = balance - this.config.maxRetentionAmount;
        
        // Safety check: Don't sweep tiny dust (e.g. < $10)
        if (sweepAmount < 10) return null;

        this.logger.info(`💸 Sweeping excess funds: $${sweepAmount.toFixed(2)} -> ${this.config.destinationAddress}`);

        const amountInUnits = parseUnits(sweepAmount.toFixed(6), 6);
        
        const tx = await this.usdcContract.transfer(this.config.destinationAddress, amountInUnits);
        this.logger.info(`⏳ Cashout Tx Sent: ${tx.hash}`);
        
        await tx.wait();
        this.logger.info(`✅ Cashout Confirmed!`);

        await this.notifier.sendCashoutAlert(sweepAmount, tx.hash);

        return {
            id: tx.hash,
            amount: sweepAmount,
            txHash: tx.hash,
            destination: this.config.destinationAddress,
            timestamp: new Date().toISOString()
        };
      }
    } catch (error) {
      this.logger.error('Fund Manager failed to sweep', error as Error);
    }
    return null;
  }
}
