import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Activity, Target, Loader2, Cpu, Sword, Activity as PulseIcon } from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
// --- Quant Utility: Power-Curve Decay Model ---
const calculateUIVector = (score, minute) => {
    const [h, a] = score;
    const absoluteDiff = Math.abs(h - a);
    const timeFactor = Math.min(minute / 95, 0.99);
    if (absoluteDiff > 0) {
        const baseProb = absoluteDiff === 1 ? 0.65 : 0.88;
        const decaySensitivity = 2.5;
        const fairValue = baseProb + (1 - baseProb) * Math.pow(timeFactor, decaySensitivity);
        return Math.min(fairValue, 0.99);
    }
    if (absoluteDiff === 0) {
        const baseDraw = 0.33;
        const drawFairValue = baseDraw + (1 - baseDraw) * Math.pow(timeFactor, 3.0);
        return Math.min(drawFairValue, 0.99);
    }
    return 0.5;
};
const MatchCard = ({ match, onChase }) => {
    const delta = match.fairValue - match.marketPrice;
    const isProfitable = delta > 0.12 && match.marketPrice > 0;
    const [pulse, setPulse] = useState(false);
    useEffect(() => {
        if (match.status === 'GOAL') {
            setPulse(true);
            const t = setTimeout(() => setPulse(false), 5000);
            return () => clearTimeout(t);
        }
    }, [match.status]);
    return (_jsxs("div", { className: `glass-panel p-4 rounded-[1.5rem] border transition-all duration-500 relative overflow-hidden ${pulse ? 'border-rose-500 shadow-[0_0_25px_rgba(244,63,94,0.25)]' :
            isProfitable ? 'border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.08)]' : 'border-white/5'}`, children: [_jsxs("div", { className: "flex justify-between items-center mb-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("div", { className: "relative flex items-center justify-center", children: [_jsx("span", { className: `w-1.5 h-1.5 rounded-full ${match.status === 'LIVE' || match.status === 'GOAL' ? 'bg-emerald-500 animate-ping' : 'bg-gray-600'}` }), _jsx("span", { className: `w-1.5 h-1.5 rounded-full absolute ${match.status === 'LIVE' || match.status === 'GOAL' ? 'bg-emerald-500' : 'bg-gray-600'}` })] }), _jsxs("span", { className: "text-[9px] font-black text-gray-500 uppercase tracking-[0.2em]", children: [match.minute, "' ", _jsx("span", { className: "opacity-30", children: "|" }), " ", match.status] })] }), _jsx("div", { className: "flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/10 text-blue-400 text-[8px] font-black uppercase tracking-widest", children: match.league || 'LEAGUE FEED' })] }), _jsxs("div", { className: "flex justify-between items-center mb-5 px-1", children: [_jsxs("div", { className: "flex flex-col flex-1 min-w-0", children: [_jsx("span", { className: "text-[11px] font-black text-white uppercase tracking-tight truncate leading-none mb-1", children: match.homeTeam }), _jsx("span", { className: "text-[7px] text-gray-600 font-bold uppercase tracking-widest", children: "HOME" })] }), _jsx("div", { className: "flex items-center justify-center bg-white/[0.03] border border-white/[0.05] px-3 py-1 rounded-xl mx-3 min-w-[60px]", children: _jsxs("span", { className: "text-xl font-black text-white font-mono tracking-tighter", children: [match.score[0], _jsx("span", { className: "opacity-20 mx-0.5", children: ":" }), match.score[1]] }) }), _jsxs("div", { className: "flex flex-col flex-1 items-end min-w-0", children: [_jsx("span", { className: "text-[11px] font-black text-white uppercase tracking-tight truncate leading-none mb-1 text-right", children: match.awayTeam }), _jsx("span", { className: "text-[7px] text-gray-600 font-bold uppercase tracking-widest", children: "AWAY" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-2 mb-4", children: [_jsxs("div", { className: "p-2.5 bg-black/40 rounded-xl border border-white/[0.03] flex flex-col justify-center", children: [_jsx("p", { className: "text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1", children: "Mkt Price" }), _jsxs("p", { className: "text-xs font-mono font-black text-white tracking-tighter", children: ["$", match.marketPrice > 0 ? match.marketPrice.toFixed(2) : '0.00'] })] }), _jsxs("div", { className: `p-2.5 bg-black/40 rounded-xl border flex flex-col justify-center transition-colors ${isProfitable ? 'border-emerald-500/20' : 'border-white/[0.03]'}`, children: [_jsx("p", { className: `text-[7px] font-black uppercase tracking-widest mb-1 ${isProfitable ? 'text-emerald-500' : 'text-gray-600'}`, children: "Quant Fair" }), _jsxs("p", { className: `text-xs font-mono font-black tracking-tighter ${isProfitable ? 'text-emerald-500' : 'text-white'}`, children: ["$", match.fairValue.toFixed(2)] })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("div", { className: "flex flex-col justify-center px-1", children: [_jsx("span", { className: "text-[7px] font-black text-gray-600 uppercase tracking-widest mb-0.5", children: "Alpha Edge" }), _jsx("span", { className: `text-[11px] font-black font-mono leading-none ${delta > 0.05 ? 'text-emerald-500' : 'text-white/40'}`, children: match.marketPrice > 0 ? `+${(delta * 100).toFixed(1)}¢` : '--' })] }), _jsxs("button", { onClick: () => onChase(match), className: `flex-1 py-2.5 rounded-xl font-black text-[9px] uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2 ${isProfitable
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-900/20'
                            : 'bg-white/[0.02] text-gray-600 border border-white/[0.05] cursor-not-allowed'}`, children: [_jsx(Sword, { size: 12, className: isProfitable ? 'animate-bounce' : '' }), isProfitable ? 'Chase Goal Edge' : 'Scouting...'] })] })] }));
};
const SportsRunner = ({ userId, isRunning }) => {
    const [matches, setMatches] = useState([]);
    const [sportsLogs, setSportsLogs] = useState([]);
    const [stats, setStats] = useState({ scouting: 0, edge: 'LIVE', realized: 0 });
    const addLog = (msg, type) => {
        setSportsLogs(prev => [{ id: Math.random(), msg, type, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 50));
    };
    const handleChaseMatch = async (match) => {
        addLog(`Initiating Taker Chase on ${match.homeTeam}...`, 'info');
        toast.info(`Manual Chase: Evaluating ${match.homeTeam} Edge...`);
        try {
            await axios.post('/api/bot/execute-arb', { userId, marketId: match.conditionId });
        }
        catch (e) {
            addLog(`Execution failed: Node communication error`, 'warn');
        }
    };
    useEffect(() => {
        const fetchLiveSports = async () => {
            try {
                const res = await axios.get(`/api/bot/sports/live/${userId}`);
                if (res.data.success && Array.isArray(res.data.matches)) {
                    const enriched = res.data.matches.map((m) => ({
                        ...m,
                        fairValue: calculateUIVector(m.score, m.minute),
                        marketPrice: m.marketPrice || 0
                    }));
                    setMatches(enriched);
                    setStats(prev => ({ ...prev, scouting: enriched.length }));
                }
            }
            catch (e) {
                console.error("Sports Poll Failed");
            }
        };
        const interval = setInterval(fetchLiveSports, 3000);
        return () => clearInterval(interval);
    }, [userId]);
    return (_jsxs("div", { className: "grid grid-cols-12 gap-5 animate-in fade-in duration-700 max-w-[1600px] mx-auto pb-10", children: [_jsxs("div", { className: "col-span-12 grid grid-cols-1 md:grid-cols-4 gap-4 mb-2", children: [_jsxs("div", { className: "glass-panel p-4 rounded-2xl border-white/5 bg-gradient-to-tr from-white/[0.01] to-transparent", children: [_jsx("p", { className: "text-[8px] font-black text-gray-500 uppercase tracking-[0.3em] mb-1", children: "Live Scouting" }), _jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("span", { className: "text-xl font-black text-white", children: matches.length }), _jsx("span", { className: "text-[8px] text-emerald-500 font-bold uppercase tracking-tighter animate-pulse", children: "Match Feeds Active" })] })] }), _jsxs("div", { className: "glass-panel p-4 rounded-2xl border-white/5", children: [_jsx("p", { className: "text-[8px] font-black text-gray-500 uppercase tracking-[0.3em] mb-1", children: "Alpha Scanner" }), _jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("span", { className: "text-xl font-black text-emerald-500 uppercase tracking-tighter", children: "Running" }), _jsx("span", { className: "text-[8px] text-gray-600 font-bold uppercase tracking-tighter", children: "Latency: 1.2ms" })] })] }), _jsxs("div", { className: "glass-panel p-4 rounded-2xl border-white/5", children: [_jsx("p", { className: "text-[8px] font-black text-gray-500 uppercase tracking-[0.3em] mb-1", children: "Chase Engine" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: `w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-600'}` }), _jsx("span", { className: "text-xl font-black text-white uppercase tracking-tighter", children: isRunning ? 'Armed' : 'Standby' })] })] }), _jsxs("div", { className: "glass-panel p-4 rounded-2xl border-emerald-500/20 bg-emerald-500/[0.02]", children: [_jsx("p", { className: "text-[8px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-1", children: "Realized Edge" }), _jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("span", { className: "text-xl font-black text-white font-mono", children: "$0.00" }), _jsx("span", { className: "text-[8px] text-emerald-600 font-bold uppercase tracking-tighter", children: "Goal Profits" })] })] })] }), _jsxs("div", { className: "col-span-12 lg:col-span-8 space-y-6", children: [_jsxs("div", { className: "flex justify-between items-center px-2", children: [_jsxs("h2", { className: "text-sm font-black text-white uppercase tracking-[0.4em] flex items-center gap-3", children: [_jsx(PulseIcon, { className: "text-emerald-500", size: 14 }), " Pitch Intelligence Feed"] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "px-2 py-1 bg-white/[0.03] border border-white/[0.05] rounded text-[8px] font-black text-gray-500 uppercase tracking-widest", children: "Sportmonks V3 API" }), _jsx("span", { className: "px-2 py-1 bg-white/[0.03] border border-white/[0.05] rounded text-[8px] font-black text-gray-500 uppercase tracking-widest", children: "Polymarket CLOB" })] })] }), matches.length === 0 ? (_jsxs("div", { className: "glass-panel p-20 rounded-[2rem] border-white/5 text-center flex flex-col items-center justify-center", children: [_jsx(Loader2, { className: "animate-spin text-blue-500/50 mb-4", size: 32 }), _jsx("p", { className: "text-gray-600 uppercase font-black tracking-[0.3em] text-[10px]", children: "Synchronizing Match Data..." })] })) : (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: matches.map(m => (_jsx(MatchCard, { match: m, onChase: handleChaseMatch }, m.id))) })), _jsx("div", { className: "p-5 glass-panel rounded-[1.5rem] border-white/5 bg-gradient-to-br from-blue-600/[0.04] to-transparent", children: _jsxs("div", { className: "flex items-start gap-4", children: [_jsx("div", { className: "p-2.5 bg-blue-600/20 border border-blue-600/20 rounded-xl text-blue-500", children: _jsx(Cpu, { size: 20 }) }), _jsxs("div", { className: "space-y-1.5", children: [_jsx("h3", { className: "text-[11px] font-black text-white uppercase tracking-widest italic", children: "Quant Model: Pitch Alpha" }), _jsxs("p", { className: "text-gray-500 text-[10px] leading-relaxed tracking-tight", children: ["The engine monitors low-latency soccer feeds and cross-references Polymarket order books. Goal detection typically occurs ", _jsx("span", { className: "text-white font-bold", children: "15-30s" }), " before standard broadcasts.", _jsx("br", {}), _jsx("span", { className: "text-emerald-500 font-bold", children: "Protocol:" }), " Execute FOK Taker orders to sweep stale pricing before market makers adjust spreads."] })] })] }) })] }), _jsx("div", { className: "col-span-12 lg:col-span-4 flex flex-col h-full min-h-[500px]", children: _jsxs("div", { className: "glass-panel rounded-[1.5rem] border-white/5 overflow-hidden flex flex-col flex-1", children: [_jsxs("div", { className: "px-5 py-4 border-b border-white/[0.03] bg-white/[0.01] flex justify-between items-center", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Target, { size: 14, className: "text-rose-500" }), _jsx("h3", { className: "text-[10px] font-black text-white uppercase tracking-[0.2em]", children: "Execution Tape" })] }), _jsx("span", { className: "text-[8px] font-bold text-gray-500", children: "REAL-TIME" })] }), _jsxs("div", { className: "flex-1 overflow-y-auto p-4 space-y-1.5 font-mono text-[9px] custom-scrollbar bg-black/10", children: [sportsLogs.length === 0 && (_jsxs("div", { className: "h-full flex flex-col items-center justify-center text-gray-700 opacity-20 text-center px-4", children: [_jsx(Activity, { size: 32, className: "mb-3" }), _jsx("p", { className: "uppercase tracking-[0.3em] font-black", children: "Awaiting Goal Events..." })] })), sportsLogs.map(log => (_jsxs("div", { className: "flex gap-3 leading-tight", children: [_jsxs("span", { className: "text-gray-600 shrink-0", children: ["[", log.time, "]"] }), _jsx("span", { className: `${log.type === 'success' ? 'text-emerald-500' :
                                                log.type === 'warn' ? 'text-rose-400' : 'text-blue-400'}`, children: log.msg })] }, log.id)))] }), _jsx("div", { className: "p-4 border-t border-white/[0.03] bg-white/[0.01]", children: _jsx("div", { className: "flex items-center justify-between p-3 bg-black/40 rounded-xl border border-white/[0.05]", children: _jsxs("span", { className: "text-[8px] font-black text-white uppercase tracking-widest flex items-center gap-2", children: [_jsx("span", { className: "w-1.5 h-1.5 rounded-full bg-emerald-500" }), " ENGINE ACTIVE"] }) }) })] }) })] }));
};
export default SportsRunner;
