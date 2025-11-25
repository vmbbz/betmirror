import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { createPolymarketClient } from '../infrastructure/clob-client.factory.js';
import { TradeMonitorService } from '../services/trade-monitor.service.js';
import { TradeExecutorService } from '../services/trade-executor.service.js';
import { FundManagerService } from '../services/fund-manager.service.js';
import { NotificationService } from '../services/notification.service.js';
import { FeeDistributorService } from '../services/fee-distributor.service.js';
import { ConsoleLogger } from '../utils/logger.util.js';
import { getUsdBalanceApprox, getPolBalance } from '../utils/get-balance.util.js';
async function main() {
    const logger = new ConsoleLogger();
    const env = loadEnv();
    console.log(`
  ==============================================
   BET MIRROR | HEADLESS BOT MODE (CLI)
  ==============================================
  ℹ️  This process runs the bot logic on THIS machine/server.
  ℹ️  It reads keys from the local .env file.
  ℹ️  It does NOT provide a UI.
  ==============================================
  `);
    if (!env.privateKey) {
        logger.error('❌ STARTUP FAILED: No PRIVATE_KEY found in .env');
        logger.warn('To run the Headless Bot, you must configure a local .env file.');
        logger.warn('To run the Web Platform, use: npm run build && npm start');
        process.exit(1);
    }
    const client = await createPolymarketClient({
        rpcUrl: env.rpcUrl,
        privateKey: env.privateKey,
        apiKey: env.polymarketApiKey,
        apiSecret: env.polymarketApiSecret,
        apiPassphrase: env.polymarketApiPassphrase,
    });
    const notifier = new NotificationService(env, logger);
    const fundManagerConfig = {
        enabled: env.enableAutoCashout,
        maxRetentionAmount: env.maxRetentionAmount,
        destinationAddress: env.mainWalletAddress,
        usdcContractAddress: env.usdcContractAddress
    };
    const fundManager = new FundManagerService(client.wallet, fundManagerConfig, logger, notifier);
    const feeDistributor = new FeeDistributorService(client.wallet, env, logger);
    try {
        const polBalance = await getPolBalance(client.wallet);
        const usdcBalance = await getUsdBalanceApprox(client.wallet, env.usdcContractAddress);
        logger.info(`🔐 Headless Wallet: ${client.wallet.address}`);
        logger.info(`💰 Balance: ${usdcBalance.toFixed(2)} USDC | ${polBalance.toFixed(4)} POL`);
        await fundManager.checkAndSweepProfits();
    }
    catch (err) {
        logger.error('Failed to fetch balances', err);
    }
    const executor = new TradeExecutorService({
        client,
        proxyWallet: env.proxyWallet,
        logger,
        env
    });
    const monitor = new TradeMonitorService({
        client,
        logger,
        env,
        userAddresses: env.userAddresses,
        onDetectedTrade: async (signal) => {
            await executor.copyTrade(signal);
            if (signal.side === 'SELL') {
                const estimatedProfit = signal.sizeUsd * 0.1;
                if (estimatedProfit > 0) {
                    await feeDistributor.distributeFeesOnProfit(signal.marketId, estimatedProfit, signal.trader);
                }
            }
            await notifier.sendTradeAlert(signal);
            setTimeout(async () => {
                await fundManager.checkAndSweepProfits();
            }, 15000);
        },
    });
    // Start immediately with current time as cursor
    await monitor.start(Math.floor(Date.now() / 1000));
}
main().catch((err) => {
    console.error('Fatal error', err);
    process.exit(1);
});
