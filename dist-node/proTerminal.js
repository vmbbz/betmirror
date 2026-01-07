import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useEffect } from 'react';
import { Activity, Crosshair, Zap, Scale, Terminal, ShieldCheck, Loader2, Globe, Trophy, TrendingUp, ExternalLink, RefreshCw, Coins, Landmark, Star, BarChart3, Cpu, Lock, Info, X, Recycle, Wallet, CloudRain, LineChart, Globe2 } from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
const formatCompactNumber = (num) => {
    if (num < 1000)
        return num.toString();
    if (num < 1000000)
        return (num / 1000).toFixed(1) + 'K';
    if (num < 1000000000)
        return (num / 1000000).toFixed(1) + 'M';
    return (num / 1000000000).toFixed(1) + 'B';
};
// --- Sub-Component: Reward Scoring Indicator (HFT Specific) ---
const RewardScoringBadge = ({ spread, maxSpread }) => {
    const isScoring = maxSpread ? (spread <= maxSpread) : true;
    return (_jsxs("div", { className: `flex items-center gap-1.5 px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest ${isScoring ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-gray-500/10 text-gray-500 border border-white/5'}`, children: [_jsx(Cpu, { size: 10, className: isScoring ? 'animate-pulse' : '' }), isScoring ? 'Scoring Rewards' : 'Outside Band'] }));
};
// --- Internal Component: Inventory Skew Meter ---
const InventorySkewMeter = ({ skew }) => {
    const isLong = skew >= 0;
    return (_jsxs("div", { className: "space-y-1.5 mt-3 bg-black/40 p-2.5 rounded-xl border border-white/5", children: [_jsxs("div", { className: "flex justify-between text-[7px] font-black uppercase tracking-widest", children: [_jsx("span", { className: "text-gray-500", children: "Inventory Skew" }), _jsxs("span", { className: isLong ? 'text-emerald-500' : 'text-rose-500', children: [isLong ? 'YES' : 'NO', " ", Math.abs(skew * 100).toFixed(0), "%"] })] }), _jsxs("div", { className: "h-1 bg-white/10 rounded-full overflow-hidden relative", children: [_jsx("div", { className: "absolute inset-y-0 left-1/2 w-px bg-white/20 z-10" }), _jsx("div", { className: `h-full transition-all duration-700 ${isLong ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]'}`, style: {
                            width: `${Math.max(5, Math.abs(skew * 50))}%`,
                            left: isLong ? '50%' : `${50 - Math.abs(skew * 50)}%`
                        } })] })] }));
};
// --- Internal Component: Exposure Position Card ---
const PositionCard = ({ position }) => {
    const value = (position.currentPrice || position.entryPrice) * position.shares;
    const cost = position.entryPrice * position.shares;
    const pnl = value - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    return (_jsxs("div", { className: `p-4 bg-white/[0.02] rounded-2xl border transition-all hover:border-blue-500/30 ${position.managedByMM ? 'border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.05)]' : 'border-white/5'}`, children: [_jsxs("div", { className: "flex gap-3 mb-3", children: [_jsx("div", { className: "w-10 h-10 rounded-xl bg-gray-900 shrink-0 border border-white/5 overflow-hidden flex items-center justify-center", children: position.image ? _jsx("img", { src: position.image, className: "w-full h-full object-cover" }) : _jsx(Activity, { size: 16, className: "text-gray-700" }) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-[10px] font-black text-white truncate leading-tight uppercase tracking-tight", children: position.question }), _jsxs("div", { className: "flex items-center gap-1.5 mt-1.5", children: [_jsx("span", { className: `px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${position.outcome === 'YES' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`, children: position.outcome }), position.managedByMM && (_jsxs("span", { className: "text-[8px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1", children: [_jsx(Zap, { size: 8, fill: "currentColor" }), " MM Active"] }))] })] })] }), position.managedByMM && _jsx(InventorySkewMeter, { skew: position.inventorySkew || 0 }), _jsxs("div", { className: "grid grid-cols-2 gap-4 mt-4 border-t border-white/5 pt-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[8px] font-black text-gray-600 uppercase mb-0.5", children: "Valuation" }), _jsxs("p", { className: "text-[11px] font-mono font-black text-white", children: ["$", value.toFixed(2)] })] }), _jsxs("div", { className: "text-right", children: [_jsx("p", { className: "text-[8px] font-black text-gray-600 uppercase mb-0.5", children: "Performance" }), _jsxs("p", { className: `text-[11px] font-mono font-black ${pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`, children: [pnl >= 0 ? '+' : '', pnl.toFixed(2), " (", pnlPct.toFixed(1), "%)"] })] })] })] }));
};
// --- Sub-Component: Money Market Anatomy Modal ---
const MoneyMarketExplainer = ({ isOpen, onClose }) => {
    if (!isOpen)
        return null;
    return (_jsx("div", { className: "fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/95 backdrop-blur-xl animate-in fade-in duration-300", children: _jsxs("div", { className: "relative w-full max-w-4xl max-h-[90vh] overflow-y-auto custom-scrollbar bg-[#0a0a0a] border border-white/10 rounded-[2rem] md:rounded-[3rem] p-6 md:p-10 shadow-2xl", children: [_jsx("button", { onClick: onClose, className: "absolute top-4 right-4 md:top-8 md:right-8 p-2 text-gray-500 hover:text-white hover:bg-white/5 rounded-full transition-all", children: _jsx(X, { size: 24 }) }), _jsxs("div", { className: "space-y-8 md:space-y-12", children: [_jsxs("div", { className: "text-center space-y-4", children: [_jsxs("div", { className: "inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-black uppercase tracking-[0.2em]", children: [_jsx(Terminal, { size: 14 }), " Institutional Engine Anatomy"] }), _jsx("h2", { className: "text-3xl md:text-4xl font-black text-white uppercase tracking-tighter italic", children: "How the Money Market Logic Works" }), _jsx("p", { className: "text-gray-500 max-w-xl mx-auto text-sm font-medium", children: "Bet Mirror Pro operates as a high-frequency market maker, capturing spread arbitrage while earning Polymarket rewards." })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6", children: [_jsxs("div", { className: "p-6 md:p-8 bg-white/[0.02] border border-white/5 rounded-[2rem] space-y-4", children: [_jsx("div", { className: "w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20", children: _jsx(Recycle, { size: 24 }) }), _jsx("h3", { className: "text-xl font-black text-white uppercase italic", children: "1. Spread Arbitrage" }), _jsxs("p", { className: "text-gray-400 text-xs leading-relaxed", children: ["The engine identifies \"gaps\" in the order book. By simultaneously placing a ", _jsx("span", { className: "text-emerald-400 font-bold", children: "BID" }), " (Buy) and an ", _jsx("span", { className: "text-rose-400 font-bold", children: "ASK" }), " (Sell), we capture the spread."] })] }), _jsxs("div", { className: "p-6 md:p-8 bg-white/[0.02] border border-white/5 rounded-[2rem] space-y-4", children: [_jsx("div", { className: "w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center text-white shadow-lg shadow-emerald-600/20", children: _jsx(Trophy, { size: 24 }) }), _jsx("h3", { className: "text-xl font-black text-white uppercase italic", children: "2. Liquidity Rewards" }), _jsxs("p", { className: "text-gray-400 text-xs leading-relaxed", children: ["Polymarket rewards users who provide liquidity. Our server ensures your quotes stay within the ", _jsx("span", { className: "text-blue-400 font-bold", children: "Max Reward Band" }), " to generate passive USDC yield."] })] })] }), _jsxs("div", { className: "space-y-6", children: [_jsx("h4", { className: "text-xs font-black text-gray-500 uppercase tracking-[0.3em] border-l-2 border-blue-500 pl-4", children: "The Autonomous Execution Loop" }), _jsx("div", { className: "grid grid-cols-1 gap-4", children: [
                                        {
                                            icon: _jsx(Crosshair, { className: "text-blue-400" }),
                                            title: "Real-time Midpoint Calculation",
                                            desc: "The server tracks the fair value of a market in milliseconds."
                                        },
                                        {
                                            icon: _jsx(Zap, { className: "text-amber-400" }),
                                            title: "GTC Order Placement",
                                            desc: "Unlike 'Swaps' which lose money to slippage, we use GTC (Good-Til-Cancelled) Limit Orders."
                                        },
                                        {
                                            icon: _jsx(Scale, { className: "text-purple-400" }),
                                            title: "Inventory Skew Management",
                                            desc: "Automatically skews quotes to rebalance inventory and manage exposure."
                                        },
                                        {
                                            icon: _jsx(ShieldCheck, { className: "text-emerald-400" }),
                                            title: "Atomic Re-quoting",
                                            desc: "Cancels stale orders and re-posts fresh ones immediately as the market moves."
                                        }
                                    ].map((step, i) => (_jsxs("div", { className: "flex items-start gap-4 md:gap-6 p-4 md:p-6 hover:bg-white/[0.03] transition-all rounded-3xl group", children: [_jsx("div", { className: "mt-1", children: step.icon }), _jsxs("div", { className: "space-y-1", children: [_jsx("div", { className: "text-sm font-black text-white uppercase tracking-tight group-hover:text-blue-400 transition-colors", children: step.title }), _jsx("div", { className: "text-[11px] text-gray-500 leading-relaxed", children: step.desc })] })] }, i))) })] }), _jsx("div", { className: "p-8 rounded-[2rem] bg-gradient-to-br from-blue-600/20 to-transparent border border-blue-500/20 text-center", children: _jsx("button", { onClick: onClose, className: "px-10 py-4 bg-white text-black font-black rounded-2xl uppercase text-[10px] tracking-widest hover:scale-105 transition-all", children: "Initialize Strategy" }) })] })] }) }));
};
const EnhancedMarketCard = ({ opp, onExecute, onBookmark, isAutoArb, userId, isBookmarking = false, holdings }) => {
    const spreadCents = (opp.spread * 100).toFixed(1);
    const [isHovered, setIsHovered] = useState(false);
    const [isBookmarkLoading, setIsBookmarkLoading] = useState(false);
    const isHighVol = opp.isVolatile || (opp.lastPriceMovePct !== undefined && opp.lastPriceMovePct > 3);
    const movePct = opp.lastPriceMovePct?.toFixed(1) || '0.0';
    const formatNumber = (num = 0) => {
        if (num >= 1000000)
            return `$${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000)
            return `$${(num / 1000).toFixed(1)}K`;
        return `$${num.toFixed(2)}`;
    };
    const getCategoryColor = (category) => {
        const colors = {
            // Existing categories
            sports: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300',
            crypto: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300',
            business: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
            science: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300',
            // New categories
            elections: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300',
            finance: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
            tech: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/50 dark:text-cyan-300',
            climate: 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-300',
            earnings: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
            world: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-300',
            mentions: 'bg-pink-100 text-pink-800 dark:bg-pink-900/50 dark:text-pink-300',
            default: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
        };
        return colors[category?.toLowerCase() || 'default'] || colors.default;
    };
    const handleBookmark = async (e) => {
        e.stopPropagation();
        if (!onBookmark || !opp.marketId || isBookmarkLoading)
            return;
        setIsBookmarkLoading(true);
        try {
            await onBookmark(opp.marketId, !opp.isBookmarked);
        }
        finally {
            setIsBookmarkLoading(false);
        }
    };
    const marketLink = opp.eventSlug
        ? `https://polymarket.com/event/${opp.eventSlug}`
        : opp.marketSlug
            ? `https://polymarket.com/market/${opp.marketSlug}`
            : opp.marketId
                ? `https://polymarket.com/market/${opp.marketId}`
                : null;
    return (_jsxs("div", { className: `relative group bg-white dark:bg-gray-900 border rounded-[2rem] overflow-hidden transition-all duration-300 hover:shadow-2xl hover:-translate-y-1 ${holdings ? 'border-emerald-500/40 shadow-[0_0_20px_rgba(16,185,129,0.1)]' :
            isHighVol ? 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.2)]' : 'border-gray-200 dark:border-white/5 hover:border-blue-500/50'}`, onMouseEnter: () => setIsHovered(true), onMouseLeave: () => setIsHovered(false), children: [isHighVol && (_jsxs("div", { className: "absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-600 text-white text-[10px] font-black px-3 py-1 rounded-full flex items-center gap-1 z-20 shadow-lg uppercase tracking-widest", children: [_jsx(Zap, { className: "w-3 h-3", fill: "currentColor" }), " FLASH MOVE: ", movePct, "%"] })), _jsxs("div", { className: "relative h-40 bg-gray-100 dark:bg-gray-800 overflow-hidden", children: [opp.image ? (_jsx("img", { src: opp.image, alt: "", className: "w-full h-full object-cover transition-transform duration-700 group-hover:scale-105 opacity-60 group-hover:opacity-100" })) : (_jsx("div", { className: "w-full h-full flex items-center justify-center bg-blue-900/10", children: _jsx(BarChart3, { size: 32, className: "text-gray-700 dark:text-gray-600" }) })), _jsx("div", { className: "absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" }), _jsxs("div", { className: "absolute top-3 right-3 flex flex-col items-end space-y-2 z-10", children: [_jsxs("div", { className: "flex items-center space-x-1.5", children: [_jsx(RewardScoringBadge, { spread: opp.spreadCents, maxSpread: opp.rewardsMaxSpread }), _jsx("span", { className: `px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-black/60 backdrop-blur-md border border-white/10 ${opp.status?.toLowerCase() === 'active' ? 'text-emerald-400' : 'text-rose-400'}`, children: opp.status?.toUpperCase() || 'UNKNOWN' })] }), opp.category && (_jsx("span", { className: `px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${getCategoryColor(opp.category)}`, children: opp.category }))] }), _jsx("div", { className: "absolute top-3 left-3 z-10", children: _jsx("button", { onClick: handleBookmark, className: `p-1.5 rounded-full backdrop-blur-md transition-all ${opp.isBookmarked ? 'bg-yellow-500/20 text-yellow-500' : 'bg-black/40 text-gray-400 hover:text-white'}`, children: isBookmarkLoading || isBookmarking ? _jsx(Loader2, { size: 12, className: "animate-spin" }) : _jsx(Star, { size: 12, fill: opp.isBookmarked ? "currentColor" : "none" }) }) }), _jsx("div", { className: "absolute bottom-3 left-4 right-4", children: _jsx("h3", { className: "text-xs font-black text-white leading-tight uppercase tracking-tight line-clamp-2", children: opp.question }) })] }), _jsxs("div", { className: "p-5 space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3 text-[10px] font-black uppercase tracking-widest", children: [_jsxs("div", { className: "p-3 bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 rounded-2xl", children: [_jsx("p", { className: "text-gray-500 dark:text-gray-400 mb-0.5", children: "24h Vol" }), _jsx("p", { className: "text-gray-900 dark:text-white font-mono", children: formatNumber(opp.volume24hr || opp.volume) })] }), _jsxs("div", { className: "p-3 bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 rounded-2xl", children: [_jsx("p", { className: "text-gray-500 dark:text-gray-400 mb-0.5", children: "Liquidity" }), _jsx("p", { className: "text-gray-900 dark:text-white font-mono", children: formatNumber(opp.liquidity || opp.capacityUsd) })] }), _jsxs("div", { className: "p-3 bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 rounded-2xl", children: [_jsx("p", { className: "text-gray-500 dark:text-gray-400 mb-0.5", children: "Spread" }), _jsxs("p", { className: "text-blue-500 dark:text-blue-400 font-mono", children: [spreadCents, "\u00A2"] })] }), _jsxs("div", { className: "p-3 bg-gray-50 dark:bg-white/[0.02] border border-gray-100 dark:border-white/5 rounded-2xl", children: [_jsx("p", { className: "text-gray-500 dark:text-gray-400 mb-0.5", children: "Min Order" }), _jsxs("p", { className: "text-gray-900 dark:text-white font-mono", children: ["$", opp.orderMinSize || 5] })] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { onClick: () => onExecute(opp), disabled: !opp.acceptingOrders, className: `flex-1 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all ${holdings ? 'bg-emerald-600 hover:bg-emerald-500 text-white' :
                                    isHighVol ? 'bg-red-600 hover:bg-red-700 text-white' :
                                        isAutoArb ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20'} disabled:opacity-50`, children: holdings ? 'Adjust Strategy' : isAutoArb ? 'Auto Trade' : 'Trade Now' }), marketLink && (_jsx("a", { href: marketLink, target: "_blank", className: "p-3 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 rounded-2xl transition-all", children: _jsx(ExternalLink, { size: 16 }) }))] })] }), isHovered && !holdings && (_jsx("div", { className: "absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 hidden md:flex", children: _jsx("button", { onClick: () => onExecute(opp), className: "px-8 py-3 bg-white text-black font-black rounded-2xl uppercase text-[10px] tracking-widest hover:scale-105 transition-all", children: isHighVol ? 'Trade Spike (HFT)' : 'Quick Trade' }) }))] }));
};
const ProTerminal = ({ userId, activePositions, moneyMarketOpps, openOrders, isRunning, handleExecuteMM, handleSyncPositions, onRefresh }) => {
    const [activeCategory, setActiveCategory] = useState('all');
    const [manualId, setManualId] = useState('');
    const [scanning, setScanning] = useState(false);
    const [isExplainerOpen, setIsExplainerOpen] = useState(false);
    const [isBookmarking, setIsBookmarking] = useState({});
    // Debug: Log available categories when data changes
    useEffect(() => {
        if (moneyMarketOpps?.length) {
            const categories = new Set();
            moneyMarketOpps.forEach(opp => {
                if (opp.category) {
                    categories.add(opp.category.toLowerCase());
                }
            });
            console.log('Available categories:', Array.from(categories).sort());
            console.log('Sample market with category:', moneyMarketOpps.find(opp => opp.category)?.category);
        }
    }, [moneyMarketOpps]);
    const filteredOpps = useMemo(() => {
        if (!moneyMarketOpps)
            return [];
        if (activeCategory === 'all')
            return moneyMarketOpps;
        if (activeCategory === 'bookmarks')
            return moneyMarketOpps.filter(o => o.isBookmarked);
        // Debug logging for finance category
        if (activeCategory === 'finance') {
            console.log('Filtering for finance category...');
            console.log('Sample market data:', moneyMarketOpps[0]);
        }
        return moneyMarketOpps.filter(o => o.category && o.category.toLowerCase() === activeCategory.toLowerCase());
    }, [moneyMarketOpps, activeCategory]);
    const handleBookmark = async (marketId, isBookmarked) => {
        setIsBookmarking(prev => ({ ...prev, [marketId]: true }));
        try {
            await axios.post('/api/bot/mm/bookmark', { userId, marketId, isBookmarked });
            toast.success(isBookmarked ? "📌 Bookmarked" : "Removed");
            await onRefresh();
        }
        catch (e) {
            toast.error("Failed");
        }
        finally {
            setIsBookmarking(prev => ({ ...prev, [marketId]: false }));
        }
    };
    const handleManualAdd = async () => {
        if (!manualId)
            return;
        setScanning(true);
        try {
            const isSlug = !manualId.startsWith('0x');
            await axios.post('/api/bot/mm/add-market', { userId, [isSlug ? 'slug' : 'conditionId']: manualId });
            toast.success("✅ Intelligence Synced");
            setManualId('');
            onRefresh(true);
        }
        catch (e) {
            toast.error("Sync failed");
        }
        finally {
            setScanning(false);
        }
    };
    return (_jsxs("div", { className: "grid grid-cols-12 gap-6 lg:gap-10 pb-10 animate-in fade-in duration-700 max-w-[1600px] mx-auto", children: [_jsx(MoneyMarketExplainer, { isOpen: isExplainerOpen, onClose: () => setIsExplainerOpen(false) }), _jsxs("div", { className: "col-span-12 lg:col-span-8 space-y-6 lg:space-y-8", children: [_jsxs("div", { className: "glass-panel p-6 lg:p-8 rounded-[2rem] border-white/5 dark:bg-gradient-to-br from-blue-600/[0.04] to-transparent shadow-xl relative overflow-hidden", children: [_jsxs("div", { className: "flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 relative z-10", children: [_jsxs("div", { children: [_jsxs("h2", { className: "text-2xl font-black text-gray-900 dark:text-white uppercase tracking-tight flex items-center gap-4", children: [_jsx(Crosshair, { className: "text-blue-500", size: 28 }), " Money Market Scout"] }), _jsxs("div", { className: "flex items-center gap-3 mt-1.5", children: [_jsx("p", { className: "text-[10px] text-gray-500 font-bold uppercase tracking-[0.4em]", children: "Autonomous Yield Capture - Provide Liquidity & Scalp Orderbook Spreads" }), _jsxs("button", { onClick: () => setIsExplainerOpen(true), className: "flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 hover:bg-blue-500/20 text-[9px] font-black text-blue-600 dark:text-blue-400 uppercase tracking-widest transition-all", children: [_jsx(Info, { size: 12 }), " How it works"] })] })] }), _jsxs("div", { className: "flex gap-2 w-full md:w-auto", children: [_jsx("input", { value: manualId, onChange: (e) => setManualId(e.target.value), placeholder: "Market ID or Slug...", className: "w-full md:w-72 bg-white dark:bg-black/40 border border-gray-200 dark:border-white/5 rounded-2xl px-5 py-3.5 text-xs font-mono text-gray-900 dark:text-white outline-none focus:border-blue-500/50 transition-all placeholder:text-gray-400" }), _jsx("button", { onClick: handleManualAdd, className: "bg-gray-900 dark:bg-white text-white dark:text-black px-6 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-gray-800 dark:hover:bg-gray-200 transition-all shadow-xl", children: scanning ? _jsx(Loader2, { size: 16, className: "animate-spin" }) : 'Sync' })] })] }), _jsx("div", { className: "flex items-center gap-2 overflow-x-auto no-scrollbar pb-2 relative z-10 -mx-1 px-1", children: [
                                    { id: 'all', label: 'All', icon: _jsx(Globe, { size: 12 }) },
                                    { id: 'trending', label: 'Trending', icon: _jsx(TrendingUp, { size: 12 }) },
                                    { id: 'sports', label: 'Sports', icon: _jsx(Trophy, { size: 12 }) },
                                    { id: 'crypto', label: 'Crypto', icon: _jsx(Coins, { size: 12 }) },
                                    { id: 'elections', label: 'Elections', icon: _jsx(Landmark, { size: 12 }) },
                                    { id: 'finance', label: 'Finance', icon: _jsx(Wallet, { size: 12 }) },
                                    { id: 'tech', label: 'Tech', icon: _jsx(Cpu, { size: 12 }) },
                                    { id: 'climate', label: 'Climate', icon: _jsx(CloudRain, { size: 12 }) },
                                    { id: 'earnings', label: 'Earnings', icon: _jsx(LineChart, { size: 12 }) },
                                    { id: 'world', label: 'World', icon: _jsx(Globe2, { size: 12 }) },
                                    { id: 'bookmarks', label: 'Bookmarks', icon: _jsx(Star, { size: 12 }), count: moneyMarketOpps?.filter(o => o.isBookmarked).length }
                                ].map(cat => (_jsxs("button", { onClick: () => setActiveCategory(cat.id), className: `flex items-center gap-2 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all whitespace-nowrap ${activeCategory === cat.id ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/40' : 'bg-white/5 text-gray-500 border-white/5 hover:border-white/20'}`, children: [cat.icon, " ", cat.label, cat.count !== undefined && (_jsx("span", { className: `ml-1 px-1.5 py-0.5 rounded-full text-[10px] ${activeCategory === cat.id
                                                ? 'bg-white/20 text-white'
                                                : 'bg-black/10 dark:bg-white/10 text-gray-600 dark:text-gray-400'}`, children: cat.count }))] }, cat.id))) })] }), _jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6", children: [filteredOpps.map((opp) => (_jsx(EnhancedMarketCard, { opp: opp, onExecute: handleExecuteMM, onBookmark: handleBookmark, isAutoArb: isRunning, userId: userId, isBookmarking: isBookmarking[opp.marketId], holdings: activePositions.find(p => p.marketId === opp.marketId) }, opp.tokenId))), filteredOpps.length === 0 && (_jsxs("div", { className: "col-span-full py-40 text-center glass-panel rounded-[3rem] border-dashed border-gray-200 dark:border-white/10 flex flex-col items-center justify-center space-y-6 grayscale", children: [_jsx(Activity, { size: 80, className: "text-gray-400 dark:text-gray-800 animate-pulse" }), _jsx("h3", { className: "text-sm font-black text-gray-400 dark:text-gray-700 uppercase tracking-[0.3em]", children: "Awaiting Yield Signal Detection..." })] }))] })] }), _jsxs("div", { className: "col-span-12 lg:col-span-4 flex flex-col gap-8", children: [_jsxs("div", { className: "glass-panel p-6 lg:p-8 rounded-[2rem] border-white/5 flex flex-col shadow-2xl max-h-[600px]", children: [_jsxs("div", { className: "flex items-center justify-between mb-8", children: [_jsxs("div", { className: "space-y-1", children: [_jsxs("h3", { className: "text-base font-black text-gray-900 dark:text-white uppercase tracking-tight flex items-center gap-3", children: [_jsx(Scale, { size: 20, className: "text-blue-500" }), " Exposure Hub"] }), _jsx("p", { className: "text-[9px] text-gray-500 font-bold uppercase tracking-widest", children: "Active Inventory Distribution" })] }), _jsx("button", { onClick: handleSyncPositions, className: "p-2 hover:bg-gray-100 dark:hover:bg-white/5 rounded-full transition-all text-gray-500 hover:text-blue-600 dark:hover:text-white", children: _jsx(RefreshCw, { size: 16 }) })] }), _jsx("div", { className: "flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar", children: activePositions.length === 0 ? (_jsxs("div", { className: "h-full flex flex-col items-center justify-center text-gray-300 dark:text-gray-700 opacity-20 py-20", children: [_jsx(Lock, { size: 48 }), _jsx("p", { className: "uppercase tracking-[0.2em] font-black mt-6 text-[10px]", children: "Vault Empty" })] })) : (activePositions.map((pos, i) => (_jsx(PositionCard, { position: pos }, i)))) })] }), _jsxs("div", { className: "glass-panel p-6 lg:p-8 rounded-[2rem] border-white/5 dark:bg-gradient-to-br from-amber-600/5 to-transparent flex flex-col shadow-2xl h-[400px]", children: [_jsxs("div", { className: "flex items-center gap-3 mb-6", children: [_jsx(BarChart3, { size: 20, className: "text-amber-500" }), _jsx("h3", { className: "text-sm font-black text-gray-900 dark:text-white uppercase tracking-widest", children: "Active Quotes" })] }), _jsx("div", { className: "flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar font-mono", children: openOrders.length === 0 ? (_jsx("div", { className: "h-full flex items-center justify-center text-gray-400 dark:text-gray-700 text-[10px] italic font-sans", children: "No active resting orders..." })) : (openOrders.map((order, i) => (_jsxs("div", { className: "flex items-center justify-between p-3 bg-gray-50 dark:bg-black/40 rounded-xl border border-gray-100 dark:border-white/5", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: `w-1.5 h-1.5 rounded-full ${order.side === 'BUY' ? 'bg-emerald-500' : 'bg-rose-500'}` }), _jsxs("div", { children: [_jsxs("div", { className: "text-[9px] text-gray-900 dark:text-white font-black", children: [order.side, " ", order.size] }), _jsxs("div", { className: "text-[8px] text-gray-500", children: ["@", order.price, "\u00A2"] })] })] }), _jsx("button", { onClick: async () => {
                                                await axios.post('/api/orders/cancel', { userId, orderId: order.orderID });
                                                toast.success("Order Purged");
                                            }, className: "text-[8px] text-gray-500 hover:text-rose-500 uppercase font-black transition-colors", children: "Cancel" })] }, i)))) })] })] })] }));
};
export default ProTerminal;
