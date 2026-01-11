import mongoose, { Schema } from 'mongoose';
// Portfolio Snapshot Schema
const portfolioSnapshotSchema = new Schema({
    userId: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now },
    totalValue: { type: Number, required: true },
    cashBalance: { type: Number, required: true },
    positionsValue: { type: Number, required: true },
    positionsCount: { type: Number, required: true },
    totalPnL: { type: Number, required: true },
    totalPnLPercent: { type: Number, required: true },
    positionsBreakdown: [{
            marketId: { type: String, required: true },
            outcome: { type: String, required: true },
            shares: { type: Number, required: true },
            entryPrice: { type: Number, required: true },
            currentPrice: { type: Number, required: true },
            value: { type: Number, required: true },
            pnl: { type: Number, required: true }
        }]
}, {
    timestamps: true,
    versionKey: false
});
// Create indexes for performance
portfolioSnapshotSchema.index({ userId: 1, timestamp: 1 });
portfolioSnapshotSchema.index({ timestamp: 1 });
portfolioSnapshotSchema.index({ userId: 1, timestamp: -1 });
// Static methods for portfolio analytics
portfolioSnapshotSchema.statics.getAnalytics = async function (userId, period) {
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
    const snapshots = await this.find({
        userId: userId.toLowerCase(),
        timestamp: { $gte: startDate }
    }).sort({ timestamp: 1 }).lean();
    if (snapshots.length === 0) {
        return null;
    }
    const startingValue = snapshots[0].totalValue;
    const endingValue = snapshots[snapshots.length - 1].totalValue;
    const totalReturn = endingValue - startingValue;
    const totalReturnPercent = startingValue > 0 ? (totalReturn / startingValue) * 100 : 0;
    // Calculate max drawdown
    let maxValue = startingValue;
    let maxDrawdown = 0;
    snapshots.forEach((snapshot) => {
        if (snapshot.totalValue > maxValue) {
            maxValue = snapshot.totalValue;
        }
        const drawdown = maxValue - snapshot.totalValue;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
    });
    const maxDrawdownPercent = maxValue > 0 ? (maxDrawdown / maxValue) * 100 : 0;
    return {
        userId,
        period,
        snapshots: snapshots.map((s) => ({ ...s, id: s._id.toString() })),
        startingValue,
        endingValue,
        totalReturn,
        totalReturnPercent,
        maxDrawdown,
        maxDrawdownPercent
    };
};
// Method to create a new snapshot
portfolioSnapshotSchema.statics.createSnapshot = async function (userId, totalValue, cashBalance, positionsValue, positionsCount, totalPnL, totalPnLPercent, positionsBreakdown) {
    return this.create({
        userId: userId.toLowerCase(),
        timestamp: new Date(),
        totalValue,
        cashBalance,
        positionsValue,
        positionsCount,
        totalPnL,
        totalPnLPercent,
        positionsBreakdown
    });
};
// Cleanup old snapshots (keep last 90 days)
portfolioSnapshotSchema.statics.cleanupOldSnapshots = async function () {
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return this.deleteMany({
        timestamp: { $lt: cutoffDate }
    });
};
export const PortfolioSnapshotModel = mongoose.model('PortfolioSnapshot', portfolioSnapshotSchema);
