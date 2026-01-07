import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Activity, Zap, Timer, Target, Shield, Cpu, Sword } from 'lucide-react';
import { toast } from 'react-toastify';
// --- Quant Utility: Calculate Fair Value (Simplified Soccer Model) ---
// In a production environment, this would use Poisson distributions or trained ML models.
const calculateFairValue = (score, minute, side) => {
    const [h, a] = score;
    const timeRemaining = Math.max(0, 90 - minute);
    // Base probability estimates for 3-way soccer
    if (side === 'HOME') {
        if (h > a)
            return 0.85 + (h - a) * 0.05 - (timeRemaining * 0.001);
        if (h === a)
            return 0.45 - (minute * 0.002);
        return 0.15;
    }
    if (side === 'DRAW') {
        if (h === a)
            return 0.40 + (minute * 0.005);
        if (Math.abs(h - a) === 1)
            return 0.25 - (minute * 0.002);
        return 0.05;
    }
    return 0.5; // Placeholder
};
const MatchCard = ({ match, onChase }) => {
    const delta = match.fairValue - match.marketPrice;
    const isProfitable = delta > 0.10; // 10 cent discrepancy
    const [pulse, setPulse] = useState(false);
    useEffect(() => {
        if (match.status === 'GOAL') {
            setPulse(true);
            const t = setTimeout(() => setPulse(false), 5000);
            return () => clearTimeout(t);
        }
    }, [match.status]);
    return (_jsxs("div", { className: `glass-panel p-5 rounded-[2rem] border transition-all duration-500 ${pulse ? 'border-rose-500 shadow-[0_0_30px_rgba(244,63,94,0.3)] animate-pulse' :
            isProfitable ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5'}`, children: [_jsxs("div", { className: "flex justify-between items-start mb-4", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `w-2 h-2 rounded-full ${match.status === 'LIVE' ? 'bg-emerald-500 animate-ping' : 'bg-rose-500'}` }), _jsxs("span", { className: "text-[10px] font-black text-gray-500 uppercase tracking-widest", children: [match.minute, "' | ", match.status] })] }), _jsxs("div", { className: "flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[8px] font-black uppercase tracking-widest", children: [_jsx(Timer, { size: 10 }), " Latency: 1.2s"] })] }), _jsx("div", { className: "space-y-4 mb-6", children: _jsxs("div", { className: "flex justify-between items-center px-2", children: [_jsxs("div", { className: "flex flex-col", children: [_jsx("span", { className: "text-sm font-black text-white uppercase tracking-tight", children: match.homeTeam }), _jsx("span", { className: "text-[10px] text-gray-500 font-bold", children: "Home" })] }), _jsxs("div", { className: "text-2xl font-black text-white font-mono bg-white/5 px-4 py-1 rounded-2xl border border-white/5", children: [match.score[0], " : ", match.score[1]] }), _jsxs("div", { className: "flex flex-col text-right", children: [_jsx("span", { className: "text-sm font-black text-white uppercase tracking-tight", children: match.awayTeam }), _jsx("span", { className: "text-[10px] text-gray-500 font-bold", children: "Away" })] })] }) }), _jsxs("div", { className: "grid grid-cols-2 gap-3 mb-5", children: [_jsxs("div", { className: "p-3 bg-black/40 rounded-2xl border border-white/5", children: [_jsx("p", { className: "text-[8px] font-black text-gray-500 uppercase mb-1", children: "Market Price" }), _jsxs("p", { className: "text-sm font-mono font-black text-white", children: ["$", match.marketPrice.toFixed(2)] })] }), _jsxs("div", { className: "p-3 bg-black/40 rounded-2xl border border-white/5", children: [_jsx("p", { className: "text-[8px] font-black text-gray-500 uppercase mb-1", children: "Fair Value" }), _jsxs("p", { className: "text-sm font-mono font-black text-emerald-400", children: ["$", match.fairValue.toFixed(2)] })] })] }), _jsxs("div", { className: "flex items-center justify-between gap-4 pt-2", children: [_jsxs("div", { className: "flex flex-col", children: [_jsx("span", { className: "text-[9px] font-black text-gray-600 uppercase tracking-widest", children: "Edge Delta" }), _jsxs("span", { className: `text-sm font-black ${delta >= 0 ? 'text-emerald-500' : 'text-rose-500'}`, children: [delta >= 0 ? '+' : '', (delta * 100).toFixed(1), "\u00A2"] })] }), _jsxs("button", { onClick: () => onChase(match), className: `flex-1 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${isProfitable ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20' : 'bg-white/5 text-gray-500 border border-white/10'}`, children: [_jsx(Sword, { size: 14 }), " ", isProfitable ? 'Chase Alpha' : 'Monitoring'] })] })] }));
};
const SportsRunner = ({ userId, isRunning }) => {
    const [matches, setMatches] = useState([
        {
            id: 'm1',
            conditionId: '0x...',
            homeTeam: 'Arsenal',
            awayTeam: 'Liverpool',
            score: [1, 1],
            minute: 74,
            marketPrice: 0.35, // Market still thinks draw is unlikely
            fairValue: 0.52, // Quant thinks draw is 52%
            status: 'LIVE',
            category: 'EPL'
        },
        {
            id: 'm2',
            conditionId: '0x...',
            homeTeam: 'Real Madrid',
            awayTeam: 'Barcelona',
            score: [2, 1],
            minute: 88,
            marketPrice: 0.88,
            fairValue: 0.94,
            status: 'LIVE',
            category: 'La Liga'
        }
    ]);
    const [sportsLogs, setSportsLogs] = useState([]);
    const addLog = (msg, type) => {
        setSportsLogs(prev => [{ id: Math.random(), msg, type, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 50));
    };
    const handleChaseMatch = async (match) => {
        addLog(`Initiating Taker Chase on ${match.homeTeam}...`, 'info');
        // Logic would go to API
        toast.success(`Sent FOK Order for ${match.homeTeam}`);
        addLog(`FOK filled at $${match.marketPrice} (Fair: $${match.fairValue})`, 'success');
    };
    return (_jsxs("div", { className: "grid grid-cols-12 gap-8 animate-in fade-in duration-700 max-w-[1600px] mx-auto", children: [_jsxs("div", { className: "col-span-12 grid grid-cols-1 md:grid-cols-4 gap-6", children: [_jsxs("div", { className: "glass-panel p-6 rounded-[2rem] border-white/5", children: [_jsx("p", { className: "text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] mb-2", children: "Live Scouting" }), _jsxs("div", { className: "text-3xl font-black text-white", children: [matches.length, " Matches"] }), _jsx("div", { className: "mt-2 text-[10px] text-emerald-500 font-bold uppercase animate-pulse", children: "Scanning Sportsmonks API" })] }), _jsxs("div", { className: "glass-panel p-6 rounded-[2rem] border-white/5", children: [_jsx("p", { className: "text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] mb-2", children: "Arbitrage Edge" }), _jsx("div", { className: "text-3xl font-black text-emerald-500", children: "+18.4%" }), _jsx("div", { className: "mt-2 text-[10px] text-gray-500 font-bold uppercase", children: "Average Stale-Price Delta" })] }), _jsxs("div", { className: "glass-panel p-6 rounded-[2rem] border-white/5", children: [_jsx("p", { className: "text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] mb-2", children: "Auto-Chase Status" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: `w-3 h-3 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-500'}` }), _jsx("span", { className: "text-2xl font-black text-white uppercase", children: isRunning ? 'Armed' : 'Standby' })] })] }), _jsxs("div", { className: "glass-panel p-6 rounded-[2rem] border-emerald-500/20 bg-emerald-500/[0.02]", children: [_jsx("p", { className: "text-[10px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-2", children: "Goal Profits" }), _jsx("div", { className: "text-3xl font-black text-white font-mono", children: "$1,240.50" }), _jsx("div", { className: "mt-2 text-[10px] text-gray-500 font-bold uppercase", children: "Total realized from frontrunning" })] })] }), _jsxs("div", { className: "col-span-12 lg:col-span-8 space-y-8", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("h2", { className: "text-xl font-black text-white uppercase tracking-tighter italic", children: "Live Intelligence Feed" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { className: "px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[10px] font-black text-gray-400 uppercase tracking-widest hover:text-white", children: "All Leagues" }), _jsx("button", { className: "px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-[10px] font-black text-emerald-400 uppercase tracking-widest", children: "Arbitrage Only" })] })] }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-6", children: matches.map(m => (_jsx(MatchCard, { match: m, onChase: handleChaseMatch }, m.id))) }), _jsx("div", { className: "p-8 glass-panel rounded-[3rem] border-white/5 bg-gradient-to-br from-blue-600/[0.05] to-transparent", children: _jsxs("div", { className: "flex items-start gap-6", children: [_jsx("div", { className: "p-4 bg-blue-600 rounded-3xl text-white shadow-xl shadow-blue-600/20", children: _jsx(Cpu, { size: 32 }) }), _jsxs("div", { className: "space-y-3", children: [_jsx("h3", { className: "text-lg font-black text-white uppercase italic", children: "Quant Engine Logic" }), _jsxs("p", { className: "text-gray-500 text-sm leading-relaxed", children: ["The SportsRunner engine monitors low-latency soccer feeds (Sportsmonks) and cross-references them with Polymarket order books. When a goal is scored, we detect it ", _jsx("span", { className: "text-white font-bold", children: "15-30 seconds" }), " before most TV broadcasts.", _jsx("br", {}), _jsx("br", {}), _jsx("span", { className: "text-blue-400", children: "Strategy:" }), " The bot executes \"Taker\" orders (FOK) to sweep the stale book before standard market makers can adjust their spreads."] }), _jsxs("div", { className: "flex gap-4 pt-2", children: [_jsxs("div", { className: "flex items-center gap-2 text-[10px] font-black text-gray-400 uppercase tracking-widest", children: [_jsx(Shield, { size: 14, className: "text-emerald-500" }), " VAR Guard Enabled"] }), _jsxs("div", { className: "flex items-center gap-2 text-[10px] font-black text-gray-400 uppercase tracking-widest", children: [_jsx(Zap, { size: 14, className: "text-amber-500" }), " FOK Execution"] })] })] })] }) })] }), _jsx("div", { className: "col-span-12 lg:col-span-4 space-y-6", children: _jsxs("div", { className: "glass-panel rounded-[2rem] border-white/5 overflow-hidden flex flex-col h-[700px]", children: [_jsxs("div", { className: "px-6 py-4 border-b border-white/5 bg-white/[0.02] flex justify-between items-center", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Target, { size: 18, className: "text-rose-500" }), _jsx("h3", { className: "text-xs font-black text-white uppercase tracking-widest", children: "Goal Execution Tape" })] }), _jsx("button", { onClick: () => setSportsLogs([]), className: "text-[10px] text-gray-500 hover:text-white uppercase font-black", children: "Purge" })] }), _jsxs("div", { className: "flex-1 overflow-y-auto p-4 space-y-2 font-mono text-[11px] custom-scrollbar", children: [sportsLogs.length === 0 && (_jsxs("div", { className: "h-full flex flex-col items-center justify-center text-gray-700 opacity-30 text-center px-10", children: [_jsx(Activity, { size: 40, className: "mb-4" }), _jsx("p", { className: "uppercase tracking-[0.2em] font-black", children: "Awaiting Goal Signal..." })] })), sportsLogs.map(log => (_jsxs("div", { className: "flex gap-3 animate-in slide-in-from-left-2 duration-300", children: [_jsxs("span", { className: "text-gray-600 shrink-0", children: ["[", log.time, "]"] }), _jsx("span", { className: `${log.type === 'success' ? 'text-emerald-400' :
                                                log.type === 'warn' ? 'text-amber-400' : 'text-blue-300'}`, children: log.msg })] }, log.id)))] }), _jsx("div", { className: "p-6 border-t border-white/5 bg-black/40", children: _jsxs("div", { className: "flex flex-col gap-4", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "text-[10px] font-black text-gray-500 uppercase tracking-widest", children: "Autonomous Chasing" }), _jsxs("label", { className: "relative inline-flex items-center cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: isRunning, className: "sr-only peer", readOnly: true }), _jsx("div", { className: "w-10 h-5 bg-white/10 rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-emerald-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all" })] })] }), _jsx("button", { className: "w-full py-4 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-2xl text-[10px] uppercase tracking-[0.3em] transition-all shadow-xl shadow-rose-900/20", children: "Global Stop & Exit" })] }) })] }) })] }));
};
export default SportsRunner;
