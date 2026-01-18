import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Activity, Zap, Radar, Flame, Target, Loader2, Sword, ShieldCheck } from 'lucide-react';
import { toast } from 'react-toastify';
const SignalHeatBar = ({ value }) => {
    const intensity = Math.min(Math.abs(value * 100), 100);
    return (_jsx("div", { className: "w-full h-1 bg-white/5 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full transition-all duration-1000 ${intensity > 15 ? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.8)]' : 'bg-orange-400'}`, style: { width: `${intensity}%` } }) }));
};
const TacticalSignalCard = ({ move }) => {
    const velocityPct = (move.velocity * 100).toFixed(1);
    const timeAgo = Math.floor((Date.now() - move.timestamp) / 1000);
    return (_jsxs("div", { className: "relative group animate-in fade-in zoom-in-95 duration-500", children: [_jsx("div", { className: "absolute -inset-0.5 bg-gradient-to-r from-rose-600 to-amber-500 rounded-2xl blur opacity-10 group-hover:opacity-30 transition-opacity" }), _jsxs("div", { className: "relative glass-panel bg-slate-900/80 border-white/5 rounded-2xl p-4 overflow-hidden", children: [_jsxs("div", { className: "flex items-start justify-between gap-4 mb-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-500", children: _jsx(Zap, { size: 20, fill: "currentColor", className: "animate-pulse" }) }), _jsxs("div", { children: [_jsx("div", { className: "text-[10px] font-black text-rose-400 uppercase tracking-widest leading-none mb-1", children: "High Velocity Detected" }), _jsx("h4", { className: "text-sm font-bold text-white leading-tight line-clamp-1", children: move.question || 'New Spike' })] })] }), _jsxs("div", { className: "text-right", children: [_jsxs("div", { className: `text-lg font-black font-mono ${move.velocity > 0 ? 'text-emerald-400' : 'text-rose-400'}`, children: [move.velocity > 0 ? '+' : '', velocityPct, "%"] }), _jsxs("div", { className: "text-[8px] text-slate-500 font-bold uppercase tracking-tighter", children: [timeAgo, "s Ago"] })] })] }), _jsxs("div", { className: "space-y-3", children: [_jsx(SignalHeatBar, { value: move.velocity }), _jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsxs("div", { className: "bg-black/40 p-2 rounded-lg border border-white/5", children: [_jsx("div", { className: "text-[8px] text-slate-500 uppercase font-black mb-0.5", children: "Entry" }), _jsxs("div", { className: "text-xs font-mono text-white", children: ["$", move.oldPrice.toFixed(2)] })] }), _jsxs("div", { className: "bg-black/40 p-2 rounded-lg border border-white/5", children: [_jsx("div", { className: "text-[8px] text-slate-500 uppercase font-black mb-0.5", children: "Peak" }), _jsxs("div", { className: "text-xs font-mono text-white", children: ["$", move.newPrice.toFixed(2)] })] }), _jsxs("div", { className: "bg-black/40 p-2 rounded-lg border border-white/5", children: [_jsx("div", { className: "text-[8px] text-slate-500 uppercase font-black mb-0.5", children: "Conf." }), _jsxs("div", { className: "text-xs font-mono text-emerald-400", children: [(move.confidence * 100).toFixed(0), "%"] })] })] })] })] })] }));
};
export const FlashMoveDashboard = () => {
    const [signals, setSignals] = useState([]);
    const [activeChases, setActiveChases] = useState([]);
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState({ totalChased: 0, winRate: 0, totalProfit: 0 });
    useEffect(() => {
        const userId = localStorage.getItem('userAddress') || '';
        const socket = io();
        const fetchData = async () => {
            try {
                const res = await axios.get(`/api/bot/status/${userId}`);
                setSignals(res.data.flashMoves || []);
                // Filter active positions for FOMO origin
                const chases = (res.data.positions || []).filter((p) => p.serviceOrigin === 'FOMO');
                setActiveChases(chases);
            }
            catch (e) {
                console.error(e);
            }
            finally {
                setLoading(false);
            }
        };
        fetchData();
        const poll = setInterval(fetchData, 5000);
        socket.on('flash_move_detected', (data) => {
            setSignals(prev => [data.event, ...prev].slice(0, 20));
            if (data.event.confidence > 0.8)
                toast.info(`🔥 High Conf Spike: ${data.event.question}`);
        });
        return () => { clearInterval(poll); socket.disconnect(); };
    }, []);
    const handleAbort = async (marketId) => {
        const userId = localStorage.getItem('userAddress') || '';
        try {
            await axios.post('/api/trade/exit', { userId, marketId, outcome: 'YES' });
            toast.success("Chase Aborted. Market Order Sent.");
        }
        catch (e) {
            toast.error("Abort Failed");
        }
    };
    if (loading)
        return (_jsxs("div", { className: "flex flex-col items-center justify-center py-40 gap-4", children: [_jsx(Loader2, { className: "animate-spin text-blue-500", size: 40 }), _jsx("p", { className: "text-xs font-black uppercase tracking-[0.4em] text-slate-500", children: "Initializing Radar HUD..." })] }));
    return (_jsxs("div", { className: "max-w-7xl mx-auto space-y-8 pb-20 p-4", children: [_jsxs("div", { className: "flex flex-col md:flex-row justify-between items-start md:items-center gap-6", children: [_jsxs("div", { className: "flex items-center gap-4", children: [_jsx("div", { className: "w-14 h-14 bg-gradient-to-br from-rose-600 to-orange-500 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-rose-900/20", children: _jsx(Radar, { size: 32 }) }), _jsxs("div", { children: [_jsx("h2", { className: "text-3xl font-black text-white uppercase tracking-tighter italic", children: "Fomo Runner HUD" }), _jsxs("p", { className: "text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em] flex items-center gap-2", children: [_jsx(Activity, { size: 12, className: "text-rose-500" }), " Real-Time Momentum Pulse \u2022 Cloud Execution v3"] })] })] }), _jsx("div", { className: "flex gap-4", children: _jsxs("div", { className: "glass-panel px-6 py-3 rounded-2xl border-emerald-500/20 bg-emerald-500/5", children: [_jsx("div", { className: "text-[8px] font-black text-emerald-500 uppercase tracking-widest mb-1", children: "HFT Precision" }), _jsxs("div", { className: "text-xl font-black text-white font-mono", children: ["0.42s ", _jsx("span", { className: "text-[10px] font-normal text-slate-500", children: "Latency" })] })] }) })] }), _jsxs("section", { className: "space-y-4", children: [_jsxs("h3", { className: "text-xs font-black text-slate-400 uppercase tracking-[0.4em] flex items-center gap-2", children: [_jsx(Sword, { size: 14, className: "text-rose-500" }), " Active Chases (", activeChases.length, ")"] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6", children: [activeChases.map((chase, idx) => (_jsxs("div", { className: "glass-panel p-6 rounded-[2rem] border-rose-500/30 bg-rose-500/5 relative overflow-hidden group", children: [_jsx("div", { className: "absolute top-0 right-0 p-4 opacity-10 group-hover:scale-110 transition-transform", children: _jsx(Flame, { size: 100, className: "text-rose-500" }) }), _jsxs("div", { className: "relative z-10 space-y-4", children: [_jsx("h4", { className: "text-sm font-black text-white uppercase leading-tight", children: chase.question }), _jsxs("div", { className: "flex justify-between items-end", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[9px] font-black text-slate-500 uppercase mb-1", children: "Live Profit" }), _jsxs("p", { className: `text-2xl font-black font-mono ${(chase.currentPrice - chase.entryPrice) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`, children: [((chase.currentPrice - chase.entryPrice) * chase.shares).toFixed(2), " USDC"] })] }), _jsx("button", { onClick: () => handleAbort(chase.marketId), className: "px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-xl text-[10px] uppercase tracking-widest shadow-lg shadow-rose-900/40 active:scale-95 transition-all", children: "Abort Chase" })] }), _jsx("div", { className: "h-1 w-full bg-white/5 rounded-full overflow-hidden", children: _jsx("div", { className: "h-full bg-rose-500 animate-pulse", style: { width: '60%' } }) })] })] }, idx))), activeChases.length === 0 && (_jsxs("div", { className: "col-span-full py-12 text-center border-2 border-dashed border-white/5 rounded-[2rem] flex flex-col items-center gap-3 opacity-30", children: [_jsx(Target, { size: 32 }), _jsx("p", { className: "text-[10px] font-black uppercase tracking-widest", children: "No Active Combat Sequences" })] }))] })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-12 gap-10", children: [_jsxs("div", { className: "lg:col-span-8 space-y-6", children: [_jsxs("div", { className: "flex items-center gap-4 mb-4", children: [_jsxs("h3", { className: "text-xs font-black text-slate-400 uppercase tracking-[0.4em] flex items-center gap-2", children: [_jsx(Zap, { size: 14, className: "text-amber-500" }), " Momentum Radar"] }), _jsx("span", { className: "text-[10px] font-black text-amber-500 animate-pulse uppercase tracking-widest", children: "Scanning Global Feed..." })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [signals.map((sig, i) => _jsx(TacticalSignalCard, { move: sig }, i)), signals.length === 0 && (_jsxs("div", { className: "col-span-full py-32 flex flex-col items-center gap-4 text-slate-700", children: [_jsx(Radar, { size: 64, className: "animate-spin-slow" }), _jsx("p", { className: "text-sm font-black uppercase tracking-widest", children: "Waiting for Volatility Spike..." })] }))] })] }), _jsxs("div", { className: "lg:col-span-4 space-y-6", children: [_jsxs("div", { className: "glass-panel p-8 rounded-[2.5rem] border-white/5", children: [_jsxs("h4", { className: "text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-6 flex items-center gap-2", children: [_jsx(ShieldCheck, { size: 14, className: "text-blue-500" }), " Engagement Logic"] }), _jsx("div", { className: "space-y-4", children: [
                                            { label: 'Min Velocity', val: '3%', desc: 'Price move required within 60s' },
                                            { label: 'Confidence Floor', val: '70%', desc: 'Combined signal accuracy threshold' },
                                            { label: 'Max Exposure', val: '500 USDC', desc: 'Total cap per fomo event' }
                                        ].map((item, i) => (_jsxs("div", { className: "p-4 bg-white/5 rounded-2xl border border-white/5 group hover:border-blue-500/20 transition-all", children: [_jsxs("div", { className: "flex justify-between items-center mb-1", children: [_jsx("span", { className: "text-[10px] font-black text-white uppercase", children: item.label }), _jsx("span", { className: "text-xs font-mono font-black text-blue-400", children: item.val })] }), _jsx("p", { className: "text-[9px] text-slate-600 font-bold", children: item.desc })] }, i))) })] }), _jsxs("div", { className: "glass-panel p-8 rounded-[2.5rem] border-rose-500/20 bg-rose-500/[0.02]", children: [_jsx("h4", { className: "text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mb-4", children: "Radar Advisory" }), _jsxs("p", { className: "text-[11px] text-slate-400 leading-relaxed font-medium", children: ["Fomo Runner engages markets with rapid price movements. High velocity implies lower liquidity. Always maintain a ", _jsx("strong", { children: "Max Trade Size" }), " in the Vault to prevent slippage on low-depth spikes."] })] })] })] })] }));
};
