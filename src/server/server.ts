
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import mongoose from 'mongoose';
import { ethers, JsonRpcProvider } from 'ethers';
import { BotEngine, BotConfig } from './bot-engine.js';
import { TradingWalletConfig } from '../domain/wallet.types.js';
import { connectDB, User, Registry, Trade, Feedback, BridgeTransaction, BotLog, DepositLog } from '../database/index.js';
import { loadEnv, TOKENS } from '../config/env.js';
import { DbRegistryService } from '../services/db-registry.service.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
import { EvmWalletService } from '../services/evm-wallet.service.js';
import { SafeManagerService } from '../services/safe-manager.service.js';
import { BuilderVolumeData } from '../domain/alpha.types.js';
import axios from 'axios';
import { Logger } from '../utils/logger.util.js';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = loadEnv();

const dbRegistryService = new DbRegistryService();
const evmWalletService = new EvmWalletService(ENV.rpcUrl, ENV.mongoEncryptionKey);

const ACTIVE_BOTS = new Map<string, BotEngine>();

const serverLogger: Logger = {
    info: (msg) => console.log(`[SERVER] ${msg}`),
    warn: (msg) => console.warn(`[SERVER WARN] ${msg}`),
    error: (msg, err) => console.error(`[SERVER ERROR] ${msg}`, err),
    debug: (msg) => console.debug(`[SERVER DEBUG] ${msg}`),
    success: (msg) => console.log(`[SERVER SUCCESS] ${msg}`)
};

app.use(cors());
app.use(express.json({ limit: '10mb' }) as any); 

const distPath = path.join(__dirname, '../../dist');
app.use(express.static(distPath) as any);


async function startUserBot(userId: string, config: BotConfig) {
    const normId = userId.toLowerCase();
    if (ACTIVE_BOTS.has(normId)) {
        ACTIVE_BOTS.get(normId)?.stop();
    }
    const startCursor = config.startCursor || Math.floor(Date.now() / 1000);
    const engineConfig = { ...config, userId: normId, startCursor };
    const engine = new BotEngine(engineConfig, dbRegistryService, {
        onPositionsUpdate: async (positions) => {
            await User.updateOne({ address: normId }, { activePositions: positions });
        },
        onCashout: async (record) => {
            await User.updateOne({ address: normId }, { $push: { cashoutHistory: record } });
        },
        onTradeComplete: async (trade) => {
            try {
                await Trade.create({
                    _id: trade.id, 
                    userId: normId,
                    marketId: trade.marketId,
                    outcome: trade.outcome,
                    side: trade.side,
                    size: trade.size,
                    executedSize: trade.executedSize || 0,
                    price: trade.price,
                    pnl: trade.pnl,
                    status: trade.status,
                    txHash: trade.txHash,
                    aiReasoning: trade.aiReasoning,
                    riskScore: trade.riskScore,
                    timestamp: trade.timestamp ? new Date(trade.timestamp) : new Date()
                });
            } catch (err: any) {
                console.error(`[DATABASE ERROR] Failed to save trade ${trade.id}:`, err.message);
            }
        },
        onStatsUpdate: async (stats) => {
            await User.updateOne({ address: normId }, { stats });
        }
    });
    ACTIVE_BOTS.set(normId, engine);
    engine.start().catch(err => console.error(`[Bot Error] ${normId}:`, err.message));
}

app.post('/api/wallet/status', async (req: any, res: any) => {
  const { userId } = req.body; 
  if (!userId) { res.status(400).json({ error: 'User Address required' }); return; }
  const normId = userId.toLowerCase();
  
  try {
      const user = await User.findOne({ address: normId });
      if (!user || !user.tradingWallet) {
        res.json({ status: 'NEEDS_ACTIVATION' });
      } else {
        let safeAddr = user.tradingWallet.safeAddress || null;
        if (user.tradingWallet.address && !safeAddr) {
            try {
                safeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
                user.tradingWallet.safeAddress = safeAddr;
                user.tradingWallet.type = 'GNOSIS_SAFE';
                await user.save();
            } catch (err) {}
        }
        console.log(`[STATUS CHECK] Querying user: ${normId}`);
        console.log(`[STATUS CHECK] Active. Proxy(Safe): ${safeAddr} | Signer: ${user.tradingWallet.address}`);
        res.json({ 
            status: 'ACTIVE', 
            address: user.tradingWallet.address, 
            safeAddress: safeAddr,               
            type: user.tradingWallet.type,
            recoveryOwnerAdded: user.tradingWallet.recoveryOwnerAdded || false
        });
      }
  } catch (e: any) {
      res.status(500).json({ error: 'DB Error: ' + e.message });
  }
});

app.post('/api/wallet/activate', async (req: any, res: any) => {
    const { userId } = req.body;
    if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
    const normId = userId.toLowerCase();
    try {
        let user = await User.findOne({ address: normId });
        if (user && user.tradingWallet && user.tradingWallet.address) {
            let safeAddr = user.tradingWallet.safeAddress;
            if (!safeAddr) {
                 safeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
                 user.tradingWallet.safeAddress = safeAddr;
                 user.tradingWallet.type = 'GNOSIS_SAFE';
                 await user.save();
            }
            res.json({ success: true, address: user.tradingWallet.address, safeAddress: safeAddr, restored: true });
            return;
        }
        const walletConfig = await evmWalletService.createTradingWallet(normId);
        const safeAddr = await SafeManagerService.computeAddress(walletConfig.address);
        const configToSave: TradingWalletConfig = { ...walletConfig, type: 'GNOSIS_SAFE', safeAddress: safeAddr, isSafeDeployed: false };
        await User.findOneAndUpdate({ address: normId }, { tradingWallet: configToSave }, { upsert: true, new: true });
        res.json({ success: true, address: configToSave.address, safeAddress: safeAddr });
    } catch (e: any) {
        res.status(500).json({ error: e.message || 'Failed to activate' });
    }
});

app.get('/api/stats/global', async (req: any, res: any) => {
    try {
        const userCount = await User.countDocuments();
        const tradeAgg = await Trade.aggregate([
            { $group: { _id: null, signalVolume: { $sum: "$size" }, executedVolume: { $sum: "$executedSize" }, count: { $sum: 1 } } }
        ]);
        const signalVolume = tradeAgg[0]?.signalVolume || 0;
        const executedVolume = tradeAgg[0]?.executedVolume || 0;
        const totalRevenue = signalVolume * 0.01; 
        res.json({ internal: { totalUsers: userCount, signalVolume, executedVolume, totalTrades: tradeAgg[0]?.count || 0, totalRevenue, totalLiquidity: 0, activeBots: ACTIVE_BOTS.size }, builder: { current: null, history: [], builderId: ENV.builderId, ecosystemVolume: 0 } });
    } catch (e) {
        res.status(500).json({ error: 'Stats Error' });
    }
});

app.post('/api/bot/start', async (req: any, res: any) => {
  const { userId, userAddresses, multiplier, riskProfile, autoTp, notifications, autoCashout, maxTradeAmount } = req.body;
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
  const normId = userId.toLowerCase();
  try {
      const user = await User.findOne({ address: normId });
      if (!user || !user.tradingWallet) { res.status(400).json({ error: 'Trading Wallet not activated.' }); return; }
      const config: BotConfig = {
        userId: normId,
        walletConfig: user.tradingWallet,
        userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s: string) => s.trim()),
        rpcUrl: ENV.rpcUrl,
        geminiApiKey: process.env.API_KEY,
        multiplier: Number(multiplier),
        riskProfile,
        autoTp: autoTp ? Number(autoTp) : undefined,
        enableNotifications: notifications?.enabled,
        userPhoneNumber: notifications?.phoneNumber,
        autoCashout: autoCashout,
        maxTradeAmount: maxTradeAmount ? Number(maxTradeAmount) : 100, 
        activePositions: user.activePositions || [],
        stats: user.stats,
        l2ApiCredentials: user.tradingWallet.l2ApiCredentials,
        mongoEncryptionKey: ENV.mongoEncryptionKey,
        builderApiKey: ENV.builderApiKey,
        builderApiSecret: ENV.builderApiSecret,
        builderApiPassphrase: ENV.builderApiPassphrase,
        startCursor: Math.floor(Date.now() / 1000) 
      };
      await startUserBot(normId, config);
      user.isBotRunning = true;
      await user.save();
      res.json({ success: true, status: 'RUNNING' });
  } catch (e: any) {
      res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/stop', async (req: any, res: any) => {
    const { userId } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (engine) engine.stop();
    await User.updateOne({ address: normId }, { isBotRunning: false });
    res.json({ success: true, status: 'STOPPED' });
});

app.get('/api/bot/status/:userId', async (req: any, res: any) => {
    const { userId } = req.params;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    try {
        const tradeHistory = await Trade.find({ userId: normId }).sort({ timestamp: -1 }).limit(50).lean();
        const user = await User.findOne({ address: normId }).lean();
        
        // DYNAMIC PNL AGGREGATION
        const pnlAgg = await Trade.aggregate([
            { $match: { userId: normId, status: 'CLOSED' } },
            { $group: { _id: null, totalPnl: { $sum: "$pnl" } } }
        ]);
        const currentPnl = pnlAgg[0]?.totalPnl || 0;

        const dbLogs = await BotLog.find({ userId: normId }).sort({ timestamp: -1 }).limit(100).lean();
        const formattedLogs = dbLogs.map(l => ({ id: (l as any)._id.toString(), time: (l as any).timestamp.toLocaleTimeString(), type: (l as any).type, message: (l as any).message }));
        
        const stats = user?.stats ? { ...user.stats, totalPnl: currentPnl } : null;

        res.json({ 
            isRunning: engine ? engine.isRunning : (user?.isBotRunning || false), 
            logs: formattedLogs, 
            history: tradeHistory, 
            stats, 
            positions: user?.activePositions || [] 
        });
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

app.post('/api/feedback', async (req: any, res: any) => {
    const { userId, rating, comment } = req.body;
    try {
        await Feedback.create({ userId: userId.toLowerCase(), rating, comment });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/bot/update', async (req: any, res: any) => {
    const { userId, targets, multiplier, riskProfile, autoTp, autoCashout, notifications, maxTradeAmount } = req.body;
    if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user) { res.status(404).json({ error: 'User not found' }); return; }
        if (!user.activeBotConfig) user.activeBotConfig = {} as any;
        const cfg = user.activeBotConfig!;
        if (targets) cfg.userAddresses = targets;
        if (multiplier) cfg.multiplier = multiplier;
        if (riskProfile) cfg.riskProfile = riskProfile;
        if (autoTp) cfg.autoTp = autoTp;
        if (autoCashout) cfg.autoCashout = autoCashout;
        if (maxTradeAmount) cfg.maxTradeAmount = maxTradeAmount;
        if (notifications) {
            cfg.enableNotifications = notifications.enabled;
            cfg.userPhoneNumber = notifications.phoneNumber;
        }
        await User.updateOne({ address: normId }, { activeBotConfig: cfg });
        const engine = ACTIVE_BOTS.get(normId);
        if (engine && engine.isRunning) {
            engine.updateConfig({
                userAddresses: targets,
                multiplier: multiplier ? Number(multiplier) : undefined,
                riskProfile: riskProfile,
                autoTp: autoTp ? Number(autoTp) : undefined,
                autoCashout: autoCashout,
                maxTradeAmount: maxTradeAmount ? Number(maxTradeAmount) : undefined
            });
        }
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/registry', async (req, res) => {
    try {
        const list = await Registry.find().sort({ isSystem: -1, winRate: -1 }).lean();
        res.json(list);
    } catch (e) { res.status(500).json({error: 'DB Error'}); }
});

app.get('/api/registry/:address', async (req: any, res: any) => {
    const { address } = req.params;
    try {
        const profile = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } }).lean();
        if(!profile) return res.status(404).json({error: 'Not found'});
        res.json(profile);
    } catch (e) { res.status(500).json({error: 'DB Error'}); }
});

app.post('/api/registry', async (req, res) => {
    const { address, listedBy } = req.body;
    if (!address || !address.startsWith('0x')) { res.status(400).json({error:'Invalid address'}); return; }
    try {
        const existing = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } });
        if (existing) { res.status(409).json({error:'Already listed', profile: existing}); return; }
        const profile = await Registry.create({ address, listedBy: listedBy.toLowerCase(), listedAt: new Date().toISOString(), isSystem: false, tags: [], winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0 });
        registryAnalytics.analyzeWallet(address);
        res.json({success:true, profile});
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/proxy/trades/:address', async (req: any, res: any) => {
    const { address } = req.params;
    try {
        const url = `https://data-api.polymarket.com/trades?user=${address}&limit=50`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch trades from Polymarket" });
    }
});

app.get('/api/bridge/history/:userId', async (req: any, res: any) => {
    const { userId } = req.params;
    try {
        const history = await BridgeTransaction.find({ userId: userId.toLowerCase() }).sort({ timestamp: -1 }).lean();
        res.json(history.map((h: any) => ({ ...h, id: h.bridgeId })));
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

app.post('/api/bridge/record', async (req: any, res: any) => {
    const { userId, transaction } = req.body;
    if (!userId || !transaction) { res.status(400).json({ error: 'Missing Data' }); return; }
    const normId = userId.toLowerCase();
    try {
        await BridgeTransaction.findOneAndUpdate({ userId: normId, bridgeId: transaction.id }, { userId: normId, bridgeId: transaction.id, ...transaction }, { upsert: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});

app.post('/api/deposit/record', async (req: any, res: any) => {
    const { userId, amount, txHash } = req.body;
    if (!userId || !amount || !txHash) { res.status(400).json({ error: 'Missing Data' }); return; }
    try {
        await DepositLog.create({ userId: userId.toLowerCase(), amount: Number(amount), txHash });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: true, exists: true });
    }
});

app.post('/api/wallet/withdraw', async (req: any, res: any) => {
    const { userId, tokenType, toAddress, forceEoa, targetSafeAddress } = req.body;
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) { res.status(400).json({ error: 'Wallet not configured' }); return; }
        const walletConfig = user.tradingWallet;
        let txHash = '';
        const provider = new JsonRpcProvider(ENV.rpcUrl);
        const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
        const usdcContract = new ethers.Contract(TOKENS.USDC_BRIDGED, USDC_ABI, provider);
        let safeAddr = targetSafeAddress || walletConfig.safeAddress;
        if (!safeAddr) { safeAddr = await SafeManagerService.computeAddress(walletConfig.address); }
        if (!forceEoa) {
             let balanceToWithdraw = 0n;
             if (tokenType === 'POL') { balanceToWithdraw = await provider.getBalance(safeAddr); }
             else { try { balanceToWithdraw = await usdcContract.balanceOf(safeAddr); } catch(e) {} }
             let eoaBalance = 0n;
             if (!targetSafeAddress) { try { if (tokenType === 'POL') { eoaBalance = await provider.getBalance(walletConfig.address); } else { eoaBalance = await usdcContract.balanceOf(walletConfig.address); } } catch(e) {} }
             if (balanceToWithdraw > 0n) {
                 const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
                 const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
                 if (tokenType === 'POL') { txHash = await safeManager.withdrawNative(toAddress || normId, balanceToWithdraw.toString()); }
                 else { txHash = await safeManager.withdrawUSDC(toAddress || normId, balanceToWithdraw.toString()); }
             } else if (eoaBalance > 0n && !targetSafeAddress) {
                 let tokenAddr = TOKENS.USDC_BRIDGED;
                 if (tokenType === 'POL') tokenAddr = TOKENS.POL;
                 let amountStr: string | undefined = undefined;
                 if (tokenType === 'POL') { const reserve = ethers.parseEther("0.05"); if (eoaBalance > reserve) { amountStr = ethers.formatEther(eoaBalance - reserve); } else { throw new Error("Insufficient POL in EOA to cover gas for rescue."); } }
                 txHash = await evmWalletService.withdrawFunds(walletConfig.encryptedPrivateKey, toAddress || normId, tokenAddr, amountStr);
             } else { return res.status(400).json({ error: `Insufficient ${tokenType || 'USDC'} funds.` }); }
        } else {
            let tokenAddress = TOKENS.USDC_BRIDGED;
            if (tokenType === 'POL') tokenAddress = TOKENS.POL;
            txHash = await evmWalletService.withdrawFunds(walletConfig.encryptedPrivateKey, toAddress || normId, tokenAddress);
        }
        res.json({ success: true, txHash });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/wallet/add-recovery', async (req: any, res: any) => {
    const { userId } = req.body;
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) throw new Error("Wallet not configured");
        const signer = await evmWalletService.getWalletInstance(user.tradingWallet.encryptedPrivateKey);
        const safeAddr = user.tradingWallet.safeAddress || await SafeManagerService.computeAddress(user.tradingWallet.address);
        const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
        const txHash = await safeManager.addOwner(normId);
        user.tradingWallet.recoveryOwnerAdded = true;
        await user.save();
        res.json({ success: true, txHash });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/trade/sync', async (req: any, res: any) => {
    const { userId, force } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine) return res.status(404).json({ error: "Bot not running" });
    try {
        await engine.syncPositions(force);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/trade/exit', async (req: any, res: any) => {
    const { userId, marketId, outcome } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine) return res.status(404).json({ error: "Bot not running" });
    try {
        const result = await engine.emergencySell(marketId, outcome);
        res.json({ success: true, result });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('*', (req, res) => {
    const indexPath = path.join(distPath, 'index.html');
    if (!fs.existsSync(indexPath)) { return res.status(500).send("Application frontend not found."); }
    res.sendFile(indexPath);
});

async function restoreBots() {
    try {
        const activeUsers = await User.find({ isBotRunning: true, activeBotConfig: { $exists: true } });
        console.log(`Diagnostic: DB [betmirror] contains ${activeUsers.length} users marked as isBotRunning: true`);
        console.log(`🔄 Restoring ${activeUsers.length} active bots...`);
        for (const user of activeUsers) {
            if (user.activeBotConfig && user.tradingWallet) {
                 const lastTrade = await Trade.findOne({ userId: user.address }).sort({ timestamp: -1 });
                 const lastTime = lastTrade ? Math.floor(lastTrade.timestamp.getTime() / 1000) + 1 : Math.floor(Date.now() / 1000) - 3600;
                 const config: BotConfig = { ...user.activeBotConfig, walletConfig: user.tradingWallet, stats: user.stats, activePositions: user.activePositions, startCursor: lastTime, l2ApiCredentials: user.tradingWallet.l2ApiCredentials, mongoEncryptionKey: ENV.mongoEncryptionKey, builderApiKey: ENV.builderApiKey, builderApiSecret: ENV.builderApiSecret, builderApiPassphrase: ENV.builderApiPassphrase };
                 startUserBot(user.address, config).catch(err => console.error(`Bot Start Error for ${user.address}: ${err.message}`));
            }
        }
    } catch (e) {}
}

async function seedRegistry() {
    const systemWallets = ENV.userAddresses; 
    if (!systemWallets || systemWallets.length === 0) return;
    for (const address of systemWallets) {
        if (!address || !address.startsWith('0x')) continue;
        const normalized = address.toLowerCase();
        try {
            const exists = await Registry.findOne({ address: { $regex: new RegExp(`^${normalized}$`, "i") } });
            if (!exists) { await Registry.create({ address: normalized, listedBy: 'SYSTEM', listedAt: new Date().toISOString(), isSystem: true, tags: ['OFFICIAL', 'WHALE'], winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0 }); }
            else if (!exists.isSystem) { exists.isSystem = true; if (!exists.tags?.includes('OFFICIAL')) { exists.tags = [...(exists.tags || []), 'OFFICIAL']; } await exists.save(); }
        } catch(e) {}
    }
    await registryAnalytics.updateAllRegistryStats();
}

const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌍 Bet Mirror Cloud Server running on port ${PORT}`);
});

connectDB(ENV.mongoUri).then(async () => {
    await seedRegistry();
    restoreBots();
}).catch((err) => {
    console.error("❌ CRITICAL: DB Connection Failed. " + err.message);
});
