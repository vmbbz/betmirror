import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import { BotEngine } from './bot-engine.js';
import { connectDB, User, Registry, Trade, Feedback, BridgeTransaction } from '../database/index.js';
import { loadEnv } from '../config/env.js';
// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const ENV = loadEnv();
// In-Memory Bot Instances (Runtime State)
const ACTIVE_BOTS = new Map();
app.use(cors());
app.use(express.json());
// --- STATIC FILES (For Production) ---
// This allows the Node server to serve the React app
const distPath = path.join(__dirname, '../../dist');
app.use(express.static(distPath));
// --- HELPER: Start Bot Instance ---
async function startUserBot(userId, config) {
    if (ACTIVE_BOTS.has(userId)) {
        ACTIVE_BOTS.get(userId)?.stop();
    }
    // Default start cursor to now if not provided, to prevent replay
    const startCursor = config.startCursor || Math.floor(Date.now() / 1000);
    // Ensure the bot knows where the API is (Internal communication)
    // In a monolithic deployment, it's this same server.
    const registryApiUrl = `http://localhost:${PORT}/api`;
    const engineConfig = { ...config, startCursor, registryApiUrl };
    const engine = new BotEngine(engineConfig, {
        onPositionsUpdate: async (positions) => {
            await User.updateOne({ address: userId }, { activePositions: positions });
        },
        onCashout: async (record) => {
            await User.updateOne({ address: userId }, { $push: { cashoutHistory: record } });
        },
        onTradeComplete: async (trade) => {
            // Save Trade to separate collection
            await Trade.create({
                userId: userId,
                marketId: trade.marketId,
                outcome: trade.outcome,
                side: trade.side,
                size: trade.size,
                price: trade.price,
                pnl: trade.pnl,
                status: trade.status,
                txHash: trade.txHash,
                aiReasoning: trade.aiReasoning,
                riskScore: trade.riskScore,
                timestamp: trade.timestamp
            });
        },
        onStatsUpdate: async (stats) => {
            await User.updateOne({ address: userId }, { stats });
        },
        onFeePaid: async (event) => {
            // Find the lister and increment their stats
            const lister = await Registry.findOne({ address: { $regex: new RegExp(`^${event.listerAddress}$`, "i") } });
            if (lister) {
                lister.copyCount = (lister.copyCount || 0) + 1;
                lister.copyProfitGenerated = (lister.copyProfitGenerated || 0) + event.profitAmount;
                await lister.save();
            }
        }
    });
    ACTIVE_BOTS.set(userId, engine);
    await engine.start();
}
// --- API ROUTES ---
// 1. Check Status / Init
app.post('/api/wallet/status', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'User Address required' });
        return;
    }
    try {
        const user = await User.findOne({ address: userId });
        if (!user || !user.proxyWallet) {
            res.json({ status: 'NEEDS_ACTIVATION' });
        }
        else {
            res.json({
                status: 'ACTIVE',
                address: user.proxyWallet.address,
                type: 'SMART_ACCOUNT'
            });
        }
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'DB Error' });
    }
});
// 2. Activate Smart Account
app.post('/api/wallet/activate', async (req, res) => {
    const { userId, serializedSessionKey, smartAccountAddress } = req.body;
    if (!userId || !serializedSessionKey || !smartAccountAddress) {
        res.status(400).json({ error: 'Missing activation parameters' });
        return;
    }
    const walletConfig = {
        type: 'SMART_ACCOUNT',
        address: smartAccountAddress,
        serializedSessionKey: serializedSessionKey,
        ownerAddress: userId,
        createdAt: new Date().toISOString()
    };
    try {
        await User.findOneAndUpdate({ address: userId }, { proxyWallet: walletConfig }, { upsert: true, new: true });
        console.log(`[ACTIVATION] Smart Account Activated: ${smartAccountAddress} (Owner: ${userId})`);
        res.json({ success: true, address: smartAccountAddress });
    }
    catch (e) {
        res.status(500).json({ error: 'Failed to activate' });
    }
});
// 3. Global Stats
app.get('/api/stats/global', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        // Aggregate stats
        const agg = await User.aggregate([
            { $group: {
                    _id: null,
                    totalVolume: { $sum: "$stats.totalVolume" },
                    totalRevenue: { $sum: "$stats.totalFeesPaid" } // Platform revenue approximation
                } }
        ]);
        const totalVolume = agg[0]?.totalVolume || 0;
        const totalRevenue = agg[0]?.totalRevenue || 0;
        // Add Registry generated stats
        const registryAgg = await Registry.aggregate([
            { $group: { _id: null, totalGenerated: { $sum: "$copyProfitGenerated" } } }
        ]);
        const registryRevenue = (registryAgg[0]?.totalGenerated || 0) * 0.01;
        // Get actual bridged volume from DB
        const bridgeAgg = await BridgeTransaction.aggregate([
            { $group: { _id: null, totalBridged: { $sum: { $toDouble: "$amountIn" } } } }
        ]);
        const totalBridged = bridgeAgg[0]?.totalBridged || 0;
        res.json({
            totalUsers: userCount,
            totalVolume,
            totalRevenue: totalRevenue + registryRevenue,
            totalBridged: totalBridged,
            activeBots: ACTIVE_BOTS.size
        });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Stats Error' });
    }
});
// 4. Feedback
app.post('/api/feedback', async (req, res) => {
    const { userId, rating, comment } = req.body;
    try {
        await Feedback.create({ userId, rating, comment });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});
// 5. Start Bot
app.post('/api/bot/start', async (req, res) => {
    const { userId, userAddresses, rpcUrl, geminiApiKey, multiplier, riskProfile, autoTp, notifications, autoCashout } = req.body;
    try {
        const user = await User.findOne({ address: userId });
        if (!user || !user.proxyWallet) {
            res.status(400).json({ error: 'Bot Wallet not activated.' });
            return;
        }
        const config = {
            userId,
            walletConfig: user.proxyWallet,
            userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s) => s.trim()),
            rpcUrl,
            geminiApiKey,
            multiplier: Number(multiplier),
            riskProfile,
            autoTp: autoTp ? Number(autoTp) : undefined,
            enableNotifications: notifications?.enabled,
            userPhoneNumber: notifications?.phoneNumber,
            autoCashout: autoCashout,
            activePositions: user.activePositions || [],
            stats: user.stats,
            zeroDevRpc: process.env.ZERODEV_RPC
        };
        await startUserBot(userId, config);
        // Update DB state
        user.activeBotConfig = config;
        user.isBotRunning = true;
        await user.save();
        res.json({ success: true, status: 'RUNNING' });
    }
    catch (e) {
        console.error("Failed to start bot:", e);
        res.status(500).json({ error: e.message });
    }
});
// 6. Stop Bot
app.post('/api/bot/stop', async (req, res) => {
    const { userId } = req.body;
    const engine = ACTIVE_BOTS.get(userId);
    if (engine)
        engine.stop();
    await User.updateOne({ address: userId }, { isBotRunning: false });
    res.json({ success: true, status: 'STOPPED' });
});
// 7. Bot Status & Logs
app.get('/api/bot/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const engine = ACTIVE_BOTS.get(userId);
    try {
        // Fetch latest history from DB
        const tradeHistory = await Trade.find({ userId }).sort({ timestamp: -1 }).limit(50).lean();
        const user = await User.findOne({ address: userId }).lean();
        // Convert DB trades to UI format
        const historyUI = tradeHistory.map((t) => ({
            ...t,
            timestamp: t.timestamp.toISOString(),
            id: t._id.toString()
        }));
        res.json({
            isRunning: engine ? engine.isRunning : false,
            logs: engine ? engine.getLogs() : [],
            history: historyUI,
            stats: user?.stats || null
        });
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
// 8. Registry Routes
app.get('/api/registry', async (req, res) => {
    try {
        const list = await Registry.find().sort({ winRate: -1 }).lean();
        res.json(list);
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.get('/api/registry/:address', async (req, res) => {
    const { address } = req.params;
    try {
        const profile = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } }).lean();
        if (!profile)
            return res.status(404).json({ error: 'Not found' });
        res.json(profile);
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.post('/api/registry', async (req, res) => {
    const { address, listedBy } = req.body;
    if (!address || !address.startsWith('0x')) {
        res.status(400).json({ error: 'Invalid address' });
        return;
    }
    try {
        const existing = await Registry.findOne({ address: { $regex: new RegExp(`^${address}$`, "i") } });
        if (existing) {
            res.status(409).json({ error: 'Already listed', profile: existing });
            return;
        }
        const profile = await Registry.create({
            address,
            listedBy,
            listedAt: new Date().toISOString(),
            winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0
        });
        res.json({ success: true, profile });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// 9. Bridge History Routes
app.get('/api/bridge/history/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const history = await BridgeTransaction.find({ userId }).sort({ timestamp: -1 }).lean();
        res.json(history.map((h) => ({ ...h, id: h.bridgeId })));
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.post('/api/bridge/record', async (req, res) => {
    const { userId, transaction } = req.body;
    if (!userId || !transaction) {
        res.status(400).json({ error: 'Missing Data' });
        return;
    }
    try {
        // Upsert based on bridgeId to handle status updates
        await BridgeTransaction.findOneAndUpdate({ userId, bridgeId: transaction.id }, {
            userId,
            bridgeId: transaction.id,
            ...transaction
        }, { upsert: true });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
// --- SPA Fallback (Frontend) ---
// If API route not matched, serve the React App
app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});
// --- SYSTEM RESTORE ---
async function restoreBots() {
    console.log("🔄 Restoring Active Bots from Database...");
    try {
        const activeUsers = await User.find({ isBotRunning: true, activeBotConfig: { $exists: true } });
        console.log(`Found ${activeUsers.length} bots to restore.`);
        for (const user of activeUsers) {
            if (user.activeBotConfig && user.proxyWallet) {
                const config = {
                    ...user.activeBotConfig,
                    walletConfig: user.proxyWallet,
                    stats: user.stats,
                    activePositions: user.activePositions,
                    startCursor: Math.floor(Date.now() / 1000) // Reset cursor to now on restart to avoid replay
                };
                await startUserBot(user.address, config);
                console.log(`✅ Restored Bot: ${user.address}`);
            }
        }
    }
    catch (e) {
        console.error("Restore failed:", e);
    }
}
// --- INIT ---
connectDB(ENV.mongoUri).then(() => {
    app.listen(PORT, () => {
        console.log(`🌍 Bet Mirror Cloud Server running on port ${PORT}`);
        console.log(`📂 Serving Frontend from ${distPath}`);
        restoreBots();
    });
});
