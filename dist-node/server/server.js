import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import { ethers, JsonRpcProvider } from 'ethers';
import { BotEngine } from './bot-engine.js';
import { connectDB, User, Registry, Trade, Feedback, BridgeTransaction, BotLog, DepositLog, HunterEarning } from '../database/index.js';
import { PortfolioSnapshotModel } from '../database/portfolio.schema.js';
import { loadEnv, TOKENS } from '../config/env.js';
import { DbRegistryService } from '../services/db-registry.service.js';
import { registryAnalytics } from '../services/registry-analytics.service.js';
import { EvmWalletService } from '../services/evm-wallet.service.js';
import { SafeManagerService } from '../services/safe-manager.service.js';
import { GlobalWhalePollerService } from '../services/global-whale-poller.service.js';
import { MarketIntelligenceService } from '../services/market-intelligence.service.js';
import { WebSocketManager } from '../services/websocket-manager.service.js';
import { FlashMoveService } from '../services/flash-move.service.js';
import { MarketMetadataService } from '../services/market-metadata.service.js';
import { DEFAULT_FLASH_MOVE_CONFIG } from '../config/flash-move.config.js';
import { PolymarketAdapter } from '../adapters/polymarket/polymarket.adapter.js';
import axios from 'axios';
// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
// Simple Logger for Server context
const serverLogger = {
    info: (msg) => console.log(`[SERVER] ${msg}`),
    warn: (msg) => console.warn(`[SERVER WARN] ${msg}`),
    error: (msg, err) => console.error(`[SERVER ERROR] ${msg}`, err),
    debug: (msg) => console.debug(`[SERVER DEBUG] ${msg}`),
    success: (msg) => console.log(`[SERVER SUCCESS] ${msg}`)
};
const PORT = process.env.PORT || 3000;
const ENV = loadEnv();
// Service Singletons
const dbRegistryService = new DbRegistryService();
const evmWalletService = new EvmWalletService(ENV.rpcUrl, ENV.mongoEncryptionKey);
// Create a pseudo-adapter for metadata service (it only needs the getMarketData method)
const metadataAdapter = new PolymarketAdapter({
    rpcUrl: ENV.rpcUrl,
    walletConfig: { address: '0x0000000000000000000000000000000000000000' },
    userId: 'system',
    mongoEncryptionKey: ENV.mongoEncryptionKey
}, serverLogger);
const serverMetadataService = new MarketMetadataService(metadataAdapter, serverLogger);
// Create WebSocket manager for global intelligence (market-only connection)
const wsManager = new WebSocketManager(serverLogger, null);
// Create global intelligence service WITH WebSocket manager and Metadata Service
const globalIntelligence = new MarketIntelligenceService(serverLogger, wsManager, undefined, serverMetadataService);
// Create global FlashMoveService for server-level flash detection
const globalFlashMoveService = new FlashMoveService(globalIntelligence, DEFAULT_FLASH_MOVE_CONFIG, null, // No trade executor needed at server level
serverLogger, serverMetadataService);
// Wire global services
globalIntelligence.setFlashMoveService(globalFlashMoveService);
globalFlashMoveService.setEnabled(true);
// GLOBAL Whale Poller - Single instance for all bots
const globalWhalePoller = GlobalWhalePollerService.getInstance(serverLogger);
// Listen for global whale events and broadcast to all clients
globalWhalePoller.on('whale_trade_detected', (whaleEvent) => {
    io.emit('WHALE_DETECTED', {
        trader: whaleEvent.trader,
        tokenId: whaleEvent.tokenId,
        side: whaleEvent.side,
        price: whaleEvent.price,
        size: whaleEvent.sizeUsd / whaleEvent.price,
        timestamp: whaleEvent.timestamp,
        question: 'Unknown Market',
        marketSlug: null,
        eventSlug: null,
        conditionId: null
    });
    serverLogger.info(`[GLOBAL WHALE] ${whaleEvent.trader.slice(0, 10)}... ${whaleEvent.side} ${whaleEvent.sizeUsd / whaleEvent.price} @ ${whaleEvent.price}`);
});
// In-Memory Bot Instances (Runtime State)
const ACTIVE_BOTS = new Map();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// --- STATIC FILES (For Production) ---
const distPath = path.join(__dirname, '../../dist');
app.use(express.static(distPath));
// --- MASTER HEARTBEAT ORCHESTRATOR ---
let currentTickIndex = 0;
setInterval(async () => {
    const bots = Array.from(ACTIVE_BOTS.values());
    if (bots.length === 0)
        return;
    // Tick exactly ONE bot every 500ms to stagger outbound traffic
    const engine = bots[currentTickIndex % bots.length];
    if (engine && engine.isRunning) {
        engine.performTick().catch(() => { });
    }
    // Broadcast global heat updates
    const moves = await globalIntelligence.getLatestMoves();
    if (moves.length > 0)
        io.emit('FOMO_VELOCITY_UPDATE', moves);
    currentTickIndex++;
}, 500);
// --- HELPER: Start Bot Instance ---
async function startUserBot(userId, config) {
    const normId = userId.toLowerCase();
    if (ACTIVE_BOTS.has(normId)) {
        const oldEngine = ACTIVE_BOTS.get(normId);
        if (oldEngine)
            await oldEngine.stop();
    }
    const engine = new BotEngine(config, globalIntelligence, dbRegistryService, {
        onPositionsUpdate: async (positions) => {
            await User.updateOne({ address: normId }, { activePositions: positions });
            io.to(normId).emit('POSITIONS_UPDATE', positions);
        },
        onTradeComplete: async (trade) => {
            try {
                const origin = trade.serviceOrigin || 'COPY';
                serverLogger.info(`Trade Complete [${origin}] for ${normId}: ${trade.side} ${trade.outcome}`);
                const update = {
                    $inc: {
                        'stats.totalVolume': trade.executedSize || 0,
                        'stats.tradesCount': 1
                    }
                };
                if (trade.side === 'SELL' && trade.pnl !== undefined) {
                    update.$inc['stats.totalPnl'] = trade.pnl;
                    if (trade.pnl >= 0)
                        update.$inc['stats.winCount'] = 1;
                    else
                        update.$inc['stats.lossCount'] = 1;
                }
                await User.updateOne({ address: normId }, update);
                const exists = await Trade.findById(trade.id);
                if (!exists) {
                    await Trade.create({
                        _id: trade.id, userId: normId, marketId: trade.marketId, outcome: trade.outcome,
                        side: trade.side, size: trade.size, executedSize: trade.executedSize || 0,
                        price: trade.price, pnl: trade.pnl, status: trade.status, txHash: trade.txHash,
                        clobOrderId: trade.clobOrderId, assetId: trade.assetId,
                        aiReasoning: trade.aiReasoning, riskScore: trade.riskScore,
                        timestamp: trade.timestamp, marketSlug: trade.marketSlug,
                        eventSlug: trade.eventSlug, serviceOrigin: origin
                    });
                }
                else {
                    await Trade.findByIdAndUpdate(trade.id, {
                        status: trade.status, pnl: trade.pnl,
                        executedSize: trade.executedSize || exists.executedSize
                    });
                }
                io.to(normId).emit('TRADE_COMPLETE', trade);
            }
            catch (err) {
                serverLogger.error(`Failed to save trade for ${normId}: ${err.message}`);
            }
        },
        onStatsUpdate: async (stats) => {
            await User.updateOne({ address: normId }, {
                $set: {
                    'stats.portfolioValue': stats.portfolioValue,
                    'stats.cashBalance': stats.cashBalance,
                    'stats.allowanceApproved': stats.allowanceApproved
                }
            });
            io.to(normId).emit('STATS_UPDATE', stats);
        },
        onLog: (log) => io.to(normId).emit('BOT_LOG', log),
        onFeePaid: async (event) => {
            const lister = await Registry.findOne({ address: { $regex: new RegExp(`^${event.listerAddress}$`, "i") } });
            if (lister) {
                lister.copyCount = (lister.copyCount || 0) + 1;
                lister.copyProfitGenerated = (lister.copyProfitGenerated || 0) + event.profitAmount;
                await lister.save();
            }
        }
    });
    // Load bookmarks
    try {
        const user = await User.findOne({ address: normId }).select('bookmarkedMarkets').lean();
        if (user?.bookmarkedMarkets?.length) {
            const scanner = engine.arbScanner;
            if (scanner && typeof scanner.initializeBookmarks === 'function') {
                scanner.initializeBookmarks(user.bookmarkedMarkets);
            }
        }
    }
    catch (e) { }
    ACTIVE_BOTS.set(normId, engine);
    // Listen for whale events from this bot engine
    engine.on('whale_detected', (whaleEvent) => {
        io.emit('WHALE_DETECTED', whaleEvent);
        serverLogger.info(`[WHALE] ${whaleEvent.trader.slice(0, 10)}... ${whaleEvent.side} ${whaleEvent.size} @ ${whaleEvent.price}`);
    });
    await engine.start();
}
// Socket.io Room Management
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        const normId = userId.toLowerCase();
        socket.join(normId);
        serverLogger.info(`Socket ${socket.id} joined room: ${normId}`);
    });
    // Flash Moves WebSocket subscriptions
    socket.on('subscribe_flash_moves', (userId) => {
        const normId = userId.toLowerCase();
        socket.join(`flash_moves_${normId}`);
        serverLogger.info(`Socket ${socket.id} subscribed to flash moves for: ${normId}`);
        // Forward flash move events to this socket
        const engine = ACTIVE_BOTS.get(normId);
        if (engine) {
            const flashMoveService = engine.getFlashMoveService();
            if (flashMoveService) {
                // Listen for flash move events and forward to client
                flashMoveService.on('flash_move_detected', (event) => {
                    socket.emit('flash_move_detected', {
                        ...event,
                        serviceStatus: flashMoveService.getStatus()
                    });
                });
            }
        }
    });
});
// 0. Health Check
app.get('/health', (req, res) => {
    const dbState = mongoose.connection.readyState;
    const dbStatusMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    res.status(200).json({
        status: 'ok',
        db: dbStatusMap[dbState] || 'unknown',
        activeBots: ACTIVE_BOTS.size
    });
});
// 0. Fomo Data Feed
app.get('/api/fomo/history', async (req, res) => {
    try {
        const moves = await globalIntelligence.getLatestMoves();
        res.json(moves);
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
// 1. Check Status / Init
app.post('/api/wallet/status', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'User Address required' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        console.log(`[STATUS CHECK] Querying user: ${normId}`);
        // Use explicit selection to find safe and eoa address if needed
        const user = await User.findOne({ address: normId });
        // If user has a wallet, return it
        if (!user || !user.tradingWallet) {
            console.log(`[STATUS CHECK] User ${normId} needs activation.`);
            res.json({ status: 'NEEDS_ACTIVATION' });
        }
        else {
            let safeAddr = user.tradingWallet.safeAddress || null;
            if (user.tradingWallet.address) {
                try {
                    const correctSafeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
                    if (!safeAddr || safeAddr.toLowerCase() !== correctSafeAddr.toLowerCase()) {
                        safeAddr = correctSafeAddr;
                        user.tradingWallet.safeAddress = safeAddr;
                        user.tradingWallet.type = 'GNOSIS_SAFE';
                        await user.save();
                        console.log(`[STATUS CHECK] Repaired/Aligned Safe address: ${safeAddr}`);
                    }
                }
                catch (err) {
                    console.warn("Failed to compute safe address", err);
                }
            }
            console.log(`[STATUS CHECK] Active. Proxy(Safe): ${safeAddr} | Signer: ${user.tradingWallet.address}`);
            res.json({
                status: 'ACTIVE',
                address: user.tradingWallet.address, // EOA (Signer)
                safeAddress: safeAddr, // Gnosis (Funder)
                type: user.tradingWallet.type,
                recoveryOwnerAdded: user.tradingWallet.recoveryOwnerAdded || false
            });
        }
    }
    catch (e) {
        console.error("[STATUS CHECK ERROR]", e);
        res.status(500).json({ error: 'DB Error: ' + e.message });
    }
});
// 2. Activate Trading Wallet (EOA + Safe Calculation)
app.post('/api/wallet/activate', async (req, res) => {
    console.log(`[ACTIVATION REQUEST] Received payload for user: ${req.body?.userId}`);
    const { userId } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        let user = await User.findOne({ address: normId });
        // Prevent new wallet creation in development
        if ((!user || !user.tradingWallet || !user.tradingWallet.address) &&
            (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local')) {
            console.warn(`[ACTIVATION BLOCKED] New wallet generation blocked in development mode for ${normId}`);
            return res.status(400).json({
                error: 'New wallet creation is disabled in development mode. Use an existing wallet or set NODE_ENV=production'
            });
        }
        if (user && user.tradingWallet && user.tradingWallet.address) {
            console.log(`[ACTIVATION] User ${normId} already has wallet.`);
            // Force SDK-aligned derivation
            const safeAddr = await SafeManagerService.computeAddress(user.tradingWallet.address);
            user.tradingWallet.safeAddress = safeAddr;
            user.tradingWallet.type = 'GNOSIS_SAFE';
            await user.save();
            return res.json({
                success: true,
                address: user.tradingWallet.address,
                safeAddress: safeAddr,
                restored: true
            });
        }
        console.log(`[ACTIVATION] Generating NEW keys for ${normId}...`);
        const walletConfig = await evmWalletService.createTradingWallet(normId);
        // Force SDK-aligned derivation from the start
        const safeAddr = await SafeManagerService.computeAddress(walletConfig.address);
        const configToSave = {
            ...walletConfig,
            type: 'GNOSIS_SAFE',
            safeAddress: safeAddr,
            isSafeDeployed: false,
            recoveryOwnerAdded: false
        };
        await User.findOneAndUpdate({ address: normId }, { tradingWallet: configToSave }, { upsert: true, new: true });
        console.log(`[ACTIVATION SUCCESS] EOA: ${configToSave.address} | Safe: ${safeAddr}`);
        res.json({
            success: true,
            address: configToSave.address,
            safeAddress: safeAddr
        });
    }
    catch (e) {
        console.error("[ACTIVATION ERROR]", e);
        res.status(500).json({
            error: e.message || 'Failed to activate',
            details: process.env.NODE_ENV === 'development' ? e.stack : undefined
        });
    }
});
// 2b. Add Recovery Owner (Multi-Owner Safe)
app.post('/api/wallet/add-recovery', async (req, res) => {
    const { userId } = req.body;
    if (!userId)
        return res.status(400).json({ error: 'Missing User ID' });
    const normId = userId.toLowerCase();
    try {
        // MUST explicitly select encrypted field for signer instance
        const user = await User.findOne({ address: normId }).select('+tradingWallet.encryptedPrivateKey');
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) {
            return res.status(404).json({ error: 'User wallet not found' });
        }
        const walletConfig = user.tradingWallet;
        const safeAddr = walletConfig.safeAddress || await SafeManagerService.computeAddress(walletConfig.address);
        const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
        const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
        // Execute Add Owner
        const txHash = await safeManager.addOwner(normId);
        if (txHash === "ALREADY_OWNER" || txHash.startsWith("0x")) {
            user.tradingWallet.recoveryOwnerAdded = true;
            await user.save();
            res.json({ success: true, txHash: txHash === "ALREADY_OWNER" ? null : txHash, alreadyOwner: txHash === "ALREADY_OWNER" });
        }
        else {
            throw new Error("Failed to add owner");
        }
    }
    catch (e) {
        serverLogger.error(`Recovery Add Failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});
// 3. Global Stats
app.get('/api/stats/global', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        const tradeAgg = await Trade.aggregate([
            { $group: { _id: null, signalVolume: { $sum: "$size" }, executedVolume: { $sum: "$executedSize" }, count: { $sum: 1 } } }
        ]);
        const signalVolume = tradeAgg[0]?.signalVolume || 0;
        const executedVolume = tradeAgg[0]?.executedVolume || 0;
        const internalTrades = tradeAgg[0]?.count || 0;
        const revenueAgg = await User.aggregate([
            { $group: { _id: null, total: { $sum: "$stats.totalFeesPaid" } } }
        ]);
        const totalRevenue = revenueAgg[0]?.total || 0;
        const bridgeAgg = await BridgeTransaction.aggregate([
            { $match: { status: 'COMPLETED' } },
            { $group: { _id: null, total: { $sum: { $toDouble: "$amountIn" } } } }
        ]);
        const directAgg = await DepositLog.aggregate([
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const totalBridged = bridgeAgg[0]?.total || 0;
        const totalDirect = directAgg[0]?.total || 0;
        const totalLiquidity = totalBridged + totalDirect;
        let builderStats = null;
        let leaderboard = [];
        let ecosystemVolume = 0;
        const myBuilderId = ENV.builderId || 'BetMirror';
        try {
            const lbUrl = `https://data-api.polymarket.com/v1/builders/leaderboard?timePeriod=ALL&limit=50`;
            const lbResponse = await axios.get(lbUrl, { timeout: 4000 });
            if (Array.isArray(lbResponse.data)) {
                leaderboard = lbResponse.data;
                ecosystemVolume = leaderboard.reduce((acc, curr) => acc + (curr.volume || 0), 0);
                const myEntry = leaderboard.find(b => b.builder.toLowerCase() === myBuilderId.toLowerCase());
                if (myEntry) {
                    builderStats = myEntry;
                }
                else {
                    builderStats = {
                        builder: myBuilderId,
                        rank: 'Unranked',
                        volume: 0,
                        activeUsers: 0,
                        verified: false,
                        builderLogo: ''
                    };
                }
            }
        }
        catch (e) {
            console.warn("Failed to fetch external builder stats:", e instanceof Error ? e.message : 'Unknown');
            builderStats = { builder: myBuilderId, rank: 'Error', volume: 0, activeUsers: 0, verified: false };
        }
        res.json({
            internal: {
                totalUsers: userCount,
                signalVolume: signalVolume,
                executedVolume: executedVolume,
                totalTrades: internalTrades,
                totalRevenue,
                totalLiquidity,
                activeBots: ACTIVE_BOTS.size
            },
            builder: {
                current: builderStats,
                history: leaderboard,
                builderId: myBuilderId,
                ecosystemVolume
            }
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
        await Feedback.create({ userId: userId.toLowerCase(), rating, comment });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});
// 5. Start Bot
app.post('/api/bot/start', async (req, res) => {
    const { userId, userAddresses, rpcUrl, geminiApiKey, multiplier, riskProfile, enableMoneyMarkets, enableCopyTrading, enableFomoRunner = true, maxTradeAmount } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId }).select('+tradingWallet.encryptedPrivateKey +tradingWallet.l2ApiCredentials.key +tradingWallet.l2ApiCredentials.secret +tradingWallet.l2ApiCredentials.passphrase');
        if (!user || !user.tradingWallet)
            return res.status(400).json({ error: 'Trading Wallet not activated.' });
        const config = {
            userId: normId,
            walletConfig: user.tradingWallet,
            userAddresses: Array.isArray(userAddresses) ? userAddresses : userAddresses.split(',').map((s) => s.trim()),
            rpcUrl,
            geminiApiKey,
            multiplier: Number(multiplier),
            riskProfile,
            enableNotifications: false,
            enableCopyTrading: enableCopyTrading ?? true,
            enableMoneyMarkets: enableMoneyMarkets ?? true,
            enableFomoRunner: enableFomoRunner,
            maxTradeAmount: maxTradeAmount || 100,
            mongoEncryptionKey: ENV.mongoEncryptionKey,
            l2ApiCredentials: user.tradingWallet.l2ApiCredentials
        };
        await startUserBot(normId, config);
        await User.updateOne({ address: normId }, { activeBotConfig: config, isBotRunning: true });
        res.json({ success: true, status: 'RUNNING' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// 6. Stop Bot
app.post('/api/bot/stop', async (req, res) => {
    const { userId } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (engine)
        engine.stop();
    await User.updateOne({ address: normId }, { isBotRunning: false });
    res.json({ success: true, status: 'STOPPED' });
});
// Live Update Bot
app.post('/api/bot/update', async (req, res) => {
    const { userId, targets, multiplier, riskProfile, autoTp, autoCashout, notifications, maxTradeAmount, enableCopyTrading } = req.body;
    if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
    }
    const normId = userId.toLowerCase();
    try {
        const user = await User.findOne({ address: normId });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        if (!user.activeBotConfig)
            user.activeBotConfig = {};
        const cfg = user.activeBotConfig;
        if (targets)
            cfg.userAddresses = targets;
        if (multiplier)
            cfg.multiplier = multiplier;
        if (riskProfile)
            cfg.riskProfile = riskProfile;
        if (autoTp)
            cfg.autoTp = autoTp;
        if (autoCashout)
            cfg.autoCashout = autoCashout;
        if (maxTradeAmount)
            cfg.maxTradeAmount = maxTradeAmount;
        if (enableCopyTrading !== undefined)
            cfg.enableCopyTrading = enableCopyTrading;
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
                maxTradeAmount: maxTradeAmount ? Number(maxTradeAmount) : undefined,
                enableCopyTrading: enableCopyTrading
            });
            // Update copy trading targets if engine supports it
            if (engine.updateCopyTradingTargets && targets) {
                engine.updateCopyTradingTargets(targets);
            }
        }
        res.json({ success: true });
    }
    catch (e) {
        console.error("Failed to update bot config:", e);
        res.status(500).json({ error: e.message });
    }
});
// 7. Bot Status & Logs
app.get('/api/bot/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    try {
        const user = await User.findOne({ address: normId }).lean();
        const dbLogs = await BotLog.find({ userId: normId }).sort({ timestamp: -1 }).limit(100).lean();
        const history = await Trade.find({ userId: normId }).sort({ timestamp: -1 }).limit(50).lean();
        let mmOpportunities = [];
        let flashMoves = [];
        if (engine) {
            const arbScanner = engine.getArbitrageScanner();
            if (arbScanner) {
                mmOpportunities = arbScanner.getOpportunities() || [];
            }
            const flashMoveService = engine.getFlashMoveService();
            if (flashMoveService) {
                flashMoves = Array.from(flashMoveService.getActivePositions().values());
            }
        }
        let livePositions = [];
        if (engine) {
            const scanner = engine.arbScanner;
            livePositions = (engine.getActivePositions() || []).map(p => ({
                ...p,
                managedByMM: scanner?.hasActiveQuotes(p.tokenId) || false
            }));
        }
        else if (user && user.activePositions) {
            livePositions = user.activePositions;
        }
        res.json({
            isRunning: engine ? engine.isRunning : (user?.isBotRunning || false),
            logs: dbLogs.map(l => ({ id: l._id.toString(), time: l.timestamp.toLocaleTimeString(), type: l.type, message: l.message })),
            history: history.map((t) => ({ ...t, id: t._id.toString() })),
            positions: livePositions,
            stats: user?.stats || null,
            config: user?.activeBotConfig || null,
            mmOpportunities,
            flashMoves: flashMoves
        });
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
// 8. Registry Routes
app.get('/api/registry', async (req, res) => {
    try {
        const profiles = await Registry.find().sort({ copyCount: -1, totalPnl: -1 });
        res.json(profiles);
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.get('/api/registry/:address/earnings', async (req, res) => {
    try {
        const address = req.params.address.toLowerCase();
        const earnings = await HunterEarning.find({ hunterAddress: address })
            .sort({ timestamp: -1 })
            .limit(50);
        const totalEarned = earnings.reduce((sum, e) => sum + e.hunterFeeUsd, 0);
        const totalTrades = earnings.length;
        const uniqueCopiers = new Set(earnings.map(e => e.copierUserId)).size;
        res.json({
            totalEarned,
            totalTrades,
            uniqueCopiers,
            recentEarnings: earnings.slice(0, 10)
        });
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
            listedBy: listedBy.toLowerCase(),
            listedAt: new Date().toISOString(),
            isSystem: false,
            tags: [],
            winRate: 0, totalPnl: 0, tradesLast30d: 0, followers: 0, copyCount: 0, copyProfitGenerated: 0
        });
        registryAnalytics.analyzeWallet(address);
        res.json({ success: true, profile });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// PROXY: Get raw trades
app.get('/api/proxy/trades/:address', async (req, res) => {
    const { address } = req.params;
    try {
        const url = `https://data-api.polymarket.com/trades?user=${address}&limit=50`;
        const response = await axios.get(url);
        res.json(response.data);
    }
    catch (e) {
        res.status(500).json({ error: "Failed to fetch trades from Polymarket" });
    }
});
// 9. Bridge Routes
app.get('/api/bridge/history/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const history = await BridgeTransaction.find({ userId: userId.toLowerCase() }).sort({ timestamp: -1 }).lean();
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
    const normId = userId.toLowerCase();
    try {
        await BridgeTransaction.findOneAndUpdate({ userId: normId, bridgeId: transaction.id }, { userId: normId, bridgeId: transaction.id, ...transaction }, { upsert: true });
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.post('/api/deposit/record', async (req, res) => {
    const { userId, amount, txHash } = req.body;
    if (!userId || !amount || !txHash) {
        res.status(400).json({ error: 'Missing Data' });
        return;
    }
    try {
        await DepositLog.create({ userId: userId.toLowerCase(), amount: Number(amount), txHash });
        res.json({ success: true });
    }
    catch (e) {
        res.json({ success: true, exists: true });
    }
});
app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, tokenType, toAddress, forceEoa, targetSafeAddress } = req.body;
    const normId = userId.toLowerCase();
    const isForceEoa = forceEoa === true;
    try {
        // MUST explicitly select encrypted field for withdrawal
        const user = await User.findOne({ address: normId })
            .select('+tradingWallet.encryptedPrivateKey');
        if (!user || !user.tradingWallet || !user.tradingWallet.encryptedPrivateKey) {
            res.status(400).json({ error: 'Wallet not configured' });
            return;
        }
        const walletConfig = user.tradingWallet;
        let txHash = '';
        const provider = new JsonRpcProvider(ENV.rpcUrl);
        const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
        const usdcContract = new ethers.Contract(TOKENS.USDC_BRIDGED, USDC_ABI, provider);
        let safeAddr = targetSafeAddress || walletConfig.safeAddress;
        if (!safeAddr) {
            safeAddr = await SafeManagerService.computeAddress(walletConfig.address);
        }
        let balanceToWithdraw = 0n;
        let eoaBalance = 0n;
        if (tokenType === 'POL') {
            balanceToWithdraw = await provider.getBalance(safeAddr);
            if (!targetSafeAddress)
                eoaBalance = await provider.getBalance(walletConfig.address);
        }
        else {
            try {
                balanceToWithdraw = await usdcContract.of(safeAddr);
                if (!targetSafeAddress)
                    eoaBalance = await usdcContract.balanceOf(walletConfig.address);
            }
            catch (e) { }
        }
        if (!isForceEoa) {
            if (balanceToWithdraw > 0n) {
                const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
                const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
                if (tokenType === 'POL') {
                    const reserve = ethers.parseEther("0.05");
                    if (balanceToWithdraw > reserve) {
                        const amountStr = ethers.formatEther(balanceToWithdraw - reserve);
                        txHash = await safeManager.withdrawNativeOnChain(toAddress || normId, amountStr);
                    }
                    else {
                        throw new Error("Insufficient POL in Safe to cover gas for withdrawal.");
                    }
                }
                else {
                    txHash = await safeManager.withdrawUSDC(toAddress || normId, balanceToWithdraw.toString());
                }
            }
            else if (eoaBalance > 0n && !targetSafeAddress) {
                let tokenAddr = TOKENS.USDC_BRIDGED;
                if (tokenType === 'POL')
                    tokenAddr = TOKENS.POL;
                let amountStr = "";
                if (tokenType === 'POL') {
                    const reserve = ethers.parseEther("0.05");
                    if (eoaBalance > reserve) {
                        amountStr = ethers.formatEther(eoaBalance - reserve);
                    }
                    else {
                        throw new Error("Insufficient POL in EOA to cover gas for rescue.");
                    }
                }
                txHash = await evmWalletService.withdrawFunds(walletConfig.encryptedPrivateKey, toAddress || normId, tokenAddr, amountStr);
            }
            else {
                return res.status(400).json({ error: `Insufficient ${tokenType || 'USDC'} funds.` });
            }
        }
        else if (isForceEoa) {
            const signer = await evmWalletService.getWalletInstance(walletConfig.encryptedPrivateKey);
            const safeManager = new SafeManagerService(signer, ENV.builderApiKey, ENV.builderApiSecret, ENV.builderApiPassphrase, serverLogger, safeAddr);
            if (tokenType === 'POL') {
                txHash = await safeManager.withdrawNativeOnChain(toAddress || normId, ethers.formatEther(balanceToWithdraw));
            }
            else {
                txHash = await safeManager.withdrawUSDCOnChain(toAddress || normId, balanceToWithdraw.toString());
            }
        }
        res.json({ success: true, txHash });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/trade/exit', async (req, res) => {
    const { userId, marketId, outcome } = req.body;
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine)
        return res.status(400).json({ error: 'Bot is not active for this user.' });
    try {
        const result = await engine.emergencySell(marketId, outcome);
        res.json({ success: true, result });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Sync Positions API
app.post('/api/trade/sync', async (req, res) => {
    const { userId, force } = req.body;
    if (!userId)
        return res.status(400).json({ error: 'User ID required' });
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    try {
        if (engine) {
            await engine.getPortfolioTracker().syncPositions(force === true);
            res.json({ success: true });
        }
        else {
            // If bot not running, fetch positions from database for UI
            const user = await User.findOne({ address: normId }).select('+tradingWallet.address +activePositions');
            if (user?.tradingWallet?.address) {
                // Return database positions if available
                const dbPositions = user.activePositions || [];
                res.json({
                    success: true,
                    positions: dbPositions,
                    note: 'Bot not running, showing database positions'
                });
            }
            else {
                res.status(404).json({ error: 'No wallet found' });
            }
        }
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Runtime Service Toggle APIs
app.post('/api/bot/services/toggle', async (req, res) => {
    const { userId, service, enabled } = req.body;
    if (!userId || !service || enabled === undefined) {
        return res.status(400).json({ error: 'Missing required fields: userId, service, enabled' });
    }
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine) {
        return res.status(404).json({ error: 'Bot not running' });
    }
    try {
        const result = await engine.toggleService(service, enabled);
        res.json({ success: true, result });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/bot/services/status', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
    }
    const normId = userId.toLowerCase();
    const engine = ACTIVE_BOTS.get(normId);
    if (!engine) {
        return res.status(404).json({ error: 'Bot not running' });
    }
    try {
        const status = engine.getServicesStatus();
        res.json({ success: true, status });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Market-Making REST Proxy
app.post('/api/bot/mm/add-market', async (req, res) => {
    const { userId, conditionId, slug } = req.body;
    const engine = ACTIVE_BOTS.get(userId.toLowerCase());
    if (!engine)
        return res.status(400).json({ error: 'Bot not running' });
    try {
        let success = false;
        if (conditionId)
            success = await engine.addMarketToMM(conditionId);
        else if (slug)
            success = await engine.addMarketBySlug(slug);
        res.json({ success });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/bot/mm/bookmark', async (req, res) => {
    const { userId, marketId, isBookmarked } = req.body;
    const normId = userId.toLowerCase();
    try {
        if (isBookmarked) {
            await User.updateOne({ address: normId }, { $addToSet: { bookmarkedMarkets: marketId } });
            ACTIVE_BOTS.get(normId)?.bookmarkMarket(marketId);
        }
        else {
            await User.updateOne({ address: normId }, { $pull: { bookmarkedMarkets: marketId } });
            ACTIVE_BOTS.get(normId)?.unbookmarkMarket(marketId);
        }
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: 'DB Error' });
    }
});
app.post('/api/bot/execute-arb', async (req, res) => {
    const { userId, marketId } = req.body;
    const engine = ACTIVE_BOTS.get(userId.toLowerCase());
    if (!engine)
        return res.status(400).json({ error: 'Bot not running' });
    const success = await engine.dispatchManualMM(marketId);
    res.json({ success });
});
app.get('/api/orders/open', async (req, res) => {
    const { userId } = req.query;
    const engine = ACTIVE_BOTS.get(userId.toLowerCase());
    if (!engine || !engine.getAdapter())
        return res.json({ orders: [] });
    try {
        const orders = await engine.getAdapter().getOpenOrders();
        res.json({ orders });
    }
    catch (e) {
        res.status(500).json({ error: 'Order fetch failed' });
    }
});
app.post('/api/orders/cancel', async (req, res) => {
    const { userId, orderId } = req.body;
    const engine = ACTIVE_BOTS.get(userId.toLowerCase());
    if (!engine || !engine.getAdapter())
        return res.status(400).json({ error: 'Bot inactive' });
    try {
        const success = await engine.getAdapter().cancelOrder(orderId);
        res.json({ success });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/redeem', async (req, res) => {
    const { userId, marketId, outcome } = req.body;
    const engine = ACTIVE_BOTS.get(userId.toLowerCase());
    if (!engine || !engine.getAdapter())
        return res.status(400).json({ error: 'Bot inactive' });
    try {
        const positions = await engine.getAdapter().getPositions(engine.getAdapter().getFunderAddress());
        const target = positions.find(p => p.marketId === marketId && p.outcome === outcome);
        if (!target)
            throw new Error("Position not found on-chain");
        const resRedeem = await engine.getAdapter().redeemPosition(marketId, target.tokenId);
        res.json(resRedeem);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Portfolio Snapshots
// --- PORTFOLIO ANALYTICS ENDPOINTS ---
app.get('/api/portfolio/snapshots/:userId', async (req, res) => {
    const { userId } = req.params;
    const { period = 'ALL' } = req.query;
    const normId = userId.toLowerCase();
    try {
        const now = new Date();
        let startDate;
        switch (period) {
            case '1D':
                startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            case '1W':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30D':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case 'ALL':
            default:
                startDate = new Date(0);
                break;
        }
        // Use lean to ensure clean objects for the frontend
        const snapshots = await PortfolioSnapshotModel.find({
            userId: normId,
            timestamp: { $gte: startDate }
        }).sort({ timestamp: 1 }).lean();
        res.json(snapshots.map((s) => ({ ...s, id: s._id.toString() })));
    }
    catch (e) {
        serverLogger.error(`Portfolio snapshots error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/portfolio/analytics/:userId', async (req, res) => {
    const { userId } = req.params;
    const { period = 'ALL' } = req.query;
    const normId = userId.toLowerCase();
    try {
        const analytics = await PortfolioSnapshotModel.getAnalytics(normId, period);
        res.json(analytics);
    }
    catch (e) {
        serverLogger.error(`Portfolio analytics error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/portfolio/latest/:userId', async (req, res) => {
    const { userId } = req.params;
    const normId = userId.toLowerCase();
    try {
        const snapshot = await PortfolioSnapshotModel
            .findOne({ userId: normId })
            .sort({ timestamp: -1 })
            .lean();
        if (snapshot) {
            res.json({ ...snapshot, id: snapshot._id.toString() });
        }
        else {
            res.json(null);
        }
    }
    catch (e) {
        serverLogger.error(`Portfolio latest error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});
// --- ENHANCED REGISTRY SEEDING ---
async function seedRegistry() {
    const systemWallets = ENV.userAddresses;
    if (!systemWallets || systemWallets.length === 0) {
        console.log('⚠️ No system wallets found in ENV.userAddresses');
        return;
    }
    console.log(`🌱 Seeding Registry with ${systemWallets.length} system wallets from wallets.txt...`);
    let addedCount = 0;
    let upgradedCount = 0;
    let errorCount = 0;
    // Validate addresses first
    const validWallets = systemWallets.filter(address => {
        return address &&
            address.startsWith('0x') &&
            address.length === 42 &&
            /^0x[a-fA-F0-9]{40}$/.test(address);
    });
    if (validWallets.length !== systemWallets.length) {
        console.warn(`⚠️ Filtered ${systemWallets.length - validWallets.length} invalid addresses`);
    }
    // Batch operations for better performance
    const operations = [];
    for (const address of validWallets) {
        const normalized = address.toLowerCase();
        operations.push((async () => {
            try {
                const exists = await Registry.findOne({
                    address: { $regex: new RegExp(`^${normalized}$`, "i") }
                });
                if (!exists) {
                    await Registry.create({
                        address: normalized,
                        listedBy: 'SYSTEM',
                        listedAt: new Date().toISOString(),
                        isSystem: true,
                        tags: ['OFFICIAL', 'WHALE', 'SYSTEM'],
                        winRate: 0,
                        totalPnl: 0,
                        tradesLast30d: 0,
                        followers: 0,
                        copyCount: 0,
                        copyProfitGenerated: 0,
                        lastUpdated: new Date(),
                        isVerified: true // FIX: Changed from 'verified' to 'isVerified'
                    });
                    addedCount++;
                    console.log(`   ✅ Added ${normalized.slice(0, 8)}... as Official System Wallet`);
                }
                else if (!exists.isSystem) {
                    // Upgrade existing wallet to system status
                    const updateData = {
                        isSystem: true,
                        isVerified: true, // FIX: Changed from 'verified' to 'isVerified'
                        lastUpdated: new Date()
                    };
                    // Merge tags properly
                    const existingTags = exists.tags || [];
                    const newTags = new Set([...existingTags, 'OFFICIAL', 'SYSTEM']);
                    if (!newTags.has('WHALE'))
                        newTags.add('WHALE');
                    updateData.tags = Array.from(newTags);
                    await Registry.updateOne({ address: { $regex: new RegExp(`^${normalized}$`, "i") } }, updateData);
                    upgradedCount++;
                    console.log(`   🔄 Upgraded ${normalized.slice(0, 8)}... to Official System Status`);
                }
                else {
                    console.log(`   ℹ️ ${normalized.slice(0, 8)}... already exists as System Wallet`);
                }
            }
            catch (e) {
                errorCount++;
                console.error(`   ❌ Failed to process ${normalized.slice(0, 8)}...:`, e instanceof Error ? e.message : e);
            }
        })());
    }
    // Wait for all operations to complete
    await Promise.allSettled(operations);
    console.log(`\n📊 Registry Seeding Complete:`);
    console.log(`   ✅ Added: ${addedCount} new system wallets`);
    console.log(`   🔄 Upgraded: ${upgradedCount} existing wallets`);
    console.log(`   ❌ Errors: ${errorCount} failed operations`);
    console.log(`   📈 Total processed: ${validWallets.length} wallets\n`);
    // Update analytics for all wallets
    try {
        await registryAnalytics.updateAllRegistryStats();
        console.log('📈 Registry analytics updated successfully');
    }
    catch (e) {
        console.error('⚠️ Failed to update registry analytics:', e);
    }
}
// Handle React SPA Routing
app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});
// --- SERVER START ---
async function bootstrap() {
    serverLogger.info("Starting bootstrap...");
    await connectDB();
    await seedRegistry();
    await globalIntelligence.start();
    serverLogger.success("Global Market Intelligence Online.");
    const runningUsers = await User.find({ isBotRunning: true }).select('+tradingWallet.encryptedPrivateKey +tradingWallet.l2ApiCredentials.key +tradingWallet.l2ApiCredentials.secret +tradingWallet.l2ApiCredentials.passphrase');
    serverLogger.info(`Restoring ${runningUsers.length} active bot instances...`);
    // Group by wallet address to prevent duplicate instances
    const walletGroups = new Map();
    for (const u of runningUsers) {
        if (!u.tradingWallet?.address)
            continue;
        const walletAddr = u.tradingWallet.address.toLowerCase();
        if (!walletGroups.has(walletAddr)) {
            walletGroups.set(walletAddr, u);
        }
        else {
            serverLogger.warn(`[DUPLICATE] Skipping duplicate bot instance for wallet ${walletAddr} (user: ${u.address})`);
            // Mark duplicate as stopped
            await User.updateOne({ address: u.address }, { isBotRunning: false });
        }
    }
    // Attach core hub events once at startup (CRITICAL: Fixes the listener leak)
    // Note: whale_trade events are deprecated - now handled by GlobalWhalePollerService
    globalIntelligence.on('flash_move_detected', (flashEvent) => {
        io.emit('flash_move_detected', flashEvent);
        serverLogger.info(`[GLOBAL FLASH] ${flashEvent.event.velocity > 0 ? 'Spike' : 'Crash'} detected: ${flashEvent.event.question?.slice(0, 30)}...`);
    });
    // Listen for whale events from individual bot engines
    for (const [userId, engine] of ACTIVE_BOTS.entries()) {
        engine.on('whale_detected', (whaleEvent) => {
            io.emit('WHALE_DETECTED', whaleEvent);
            serverLogger.info(`[WHALE] ${whaleEvent.trader.slice(0, 10)}... ${whaleEvent.side} ${whaleEvent.size} @ ${whaleEvent.price}`);
        });
    }
    // Collect all whale targets from all bots
    const allWhaleTargets = new Set();
    for (const u of walletGroups.values()) {
        if (u.activeBotConfig?.userAddresses) {
            u.activeBotConfig.userAddresses.forEach((addr) => allWhaleTargets.add(addr.toLowerCase()));
        }
    }
    // Start global whale poller with all targets
    if (allWhaleTargets.size > 0) {
        globalWhalePoller.updateTargets(Array.from(allWhaleTargets));
        await globalWhalePoller.start();
        serverLogger.success(`🐋 Global whale poller started for ${allWhaleTargets.size} wallets`);
    }
    for (const u of walletGroups.values()) {
        if (!u.activeBotConfig || !u.tradingWallet)
            continue;
        try {
            await startUserBot(u.address, {
                ...u.activeBotConfig,
                walletConfig: u.tradingWallet,
                mongoEncryptionKey: ENV.mongoEncryptionKey,
                l2ApiCredentials: u.tradingWallet.l2ApiCredentials,
                builderApiKey: ENV.builderApiKey,
                builderApiSecret: ENV.builderApiSecret,
                builderApiPassphrase: ENV.builderApiPassphrase
            });
            // STAGGERING: Add delay to respect 25 req/min Relayer Rate Limit
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
        catch (e) {
            serverLogger.error(`Failed to restore bot for ${u.address}: ${e.message}`);
        }
    }
    httpServer.listen(PORT, () => {
        serverLogger.success(`Bet Mirror Pro Node running on http://localhost:${PORT}`);
    });
}
bootstrap().catch(err => {
    serverLogger.error("CRITICAL BOOTSTRAP FAILURE", err);
    process.exit(1);
});
