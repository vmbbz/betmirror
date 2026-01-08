
import React, { useState, useEffect, useMemo } from 'react';
import { 
  Trophy, Activity, Zap, Timer, Target, TrendingUp, 
  ArrowRightCircle, AlertCircle, Shield, Play, Square,
  BarChart3, RefreshCw, Loader2, Globe, Cpu, Hash,
  ChevronRight, ExternalLink, ZapOff, Goal, Sword,
  Terminal, Activity as PulseIcon
} from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';

// --- Types ---
interface LiveMatch {
  id: string;
  conditionId?: string;
  homeTeam: string;
  awayTeam: string;
  score: [number, number]; // [Home, Away]
  minute: number;
  marketPrice: number; 
  fairValue: number;   
  status: 'LIVE' | 'HT' | 'VAR' | 'GOAL' | 'FT' | 'SCOUTING';
  league?: string;
}

// --- Quant Utility: Power-Curve Decay Model ---
const calculateUIVector = (score: [number, number], minute: number): number => {
    // Defensive check: If score is missing, return neutral probability
    if (!score || score.length < 2) return 0.5;

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

const MatchCard = ({ match, onChase }: { match: LiveMatch, onChase: (m: LiveMatch) => void }) => {
    const delta = (match.fairValue || 0.5) - (match.marketPrice || 0);
    const isProfitable = delta > 0.12 && match.marketPrice > 0; 
    const [pulse, setPulse] = useState(false);

    useEffect(() => {
        if (match.status === 'GOAL') {
            setPulse(true);
            const t = setTimeout(() => setPulse(false), 5000);
            return () => clearTimeout(t);
        }
    }, [match.status]);

    return (
        <div className={`glass-panel p-4 rounded-[1.5rem] border transition-all duration-500 relative overflow-hidden ${
            pulse ? 'border-rose-500 shadow-[0_0_25px_rgba(244,63,94,0.25)]' : 
            isProfitable ? 'border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.08)]' : 'border-white/5'
        }`}>
            {/* Card Header */}
            <div className="flex justify-between items-center mb-3">
                <div className="flex items-center gap-2">
                    <div className="relative flex items-center justify-center">
                        <span className={`w-1.5 h-1.5 rounded-full ${match.status === 'LIVE' || match.status === 'GOAL' ? 'bg-emerald-500 animate-ping' : 'bg-gray-600'}`}></span>
                        <span className={`w-1.5 h-1.5 rounded-full absolute ${match.status === 'LIVE' || match.status === 'GOAL' ? 'bg-emerald-500' : 'bg-gray-600'}`}></span>
                    </div>
                    <span className="text-[9px] font-black text-gray-500 uppercase tracking-[0.2em]">{match.minute}' <span className="opacity-30">|</span> {match.status}</span>
                </div>
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/10 text-blue-400 text-[8px] font-black uppercase tracking-widest">
                    {match.league || 'LEAGUE FEED'}
                </div>
            </div>

            {/* Score Display */}
            <div className="flex justify-between items-center mb-5 px-1">
                <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-[11px] font-black text-white uppercase tracking-tight truncate leading-none mb-1">{match.homeTeam}</span>
                    <span className="text-[7px] text-gray-600 font-bold uppercase tracking-widest">HOME</span>
                </div>
                
                <div className="flex items-center justify-center bg-white/[0.03] border border-white/[0.05] px-3 py-1 rounded-xl mx-3 min-w-[60px]">
                    <span className="text-xl font-black text-white font-mono tracking-tighter">
                        {match.score ? match.score[0] : 0}<span className="opacity-20 mx-0.5">:</span>{match.score ? match.score[1] : 0}
                    </span>
                </div>

                <div className="flex flex-col flex-1 items-end min-w-0">
                    <span className="text-[11px] font-black text-white uppercase tracking-tight truncate leading-none mb-1 text-right">{match.awayTeam}</span>
                    <span className="text-[7px] text-gray-600 font-bold uppercase tracking-widest">AWAY</span>
                </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="p-2.5 bg-black/40 rounded-xl border border-white/[0.03] flex flex-col justify-center">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1">Mkt Price</p>
                    <p className="text-xs font-mono font-black text-white tracking-tighter">${match.marketPrice > 0 ? match.marketPrice.toFixed(2) : '0.00'}</p>
                </div>
                <div className={`p-2.5 bg-black/40 rounded-xl border flex flex-col justify-center transition-colors ${isProfitable ? 'border-emerald-500/20' : 'border-white/[0.03]'}`}>
                    <p className={`text-[7px] font-black uppercase tracking-widest mb-1 ${isProfitable ? 'text-emerald-500' : 'text-gray-600'}`}>Quant Fair</p>
                    <p className={`text-xs font-mono font-black tracking-tighter ${isProfitable ? 'text-emerald-500' : 'text-white'}`}>${(match.fairValue || 0.5).toFixed(2)}</p>
                </div>
            </div>

            {/* Action Row */}
            <div className="flex items-center gap-2">
                <div className="flex flex-col justify-center px-1">
                    <span className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-0.5">Alpha Edge</span>
                    <span className={`text-[11px] font-black font-mono leading-none ${delta > 0.05 ? 'text-emerald-500' : 'text-white/40'}`}>
                        {match.marketPrice > 0 ? `+${(delta * 100).toFixed(1)}¢` : '--'}
                    </span>
                </div>
                <button 
                    onClick={() => onChase(match)}
                    className={`flex-1 py-2.5 rounded-xl font-black text-[9px] uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2 ${
                        isProfitable 
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-900/20' 
                        : 'bg-white/[0.02] text-gray-600 border border-white/[0.05] cursor-not-allowed'
                    }`}
                >
                    <Sword size={12} className={isProfitable ? 'animate-bounce' : ''}/> 
                    {isProfitable ? 'Chase Goal Edge' : match.status === 'SCOUTING' ? 'Scouting...' : 'Live Monitoring'}
                </button>
            </div>
        </div>
    );
};

const SportsRunner = ({ userId, isRunning }: { userId: string, isRunning: boolean }) => {
    const [matches, setMatches] = useState<LiveMatch[]>([]);
    const [sportsLogs, setSportsLogs] = useState<any[]>([]);
    const [stats, setStats] = useState({ scouting: 0, edge: 'LIVE', realized: 0 });

    const addLog = (msg: string, type: 'info' | 'success' | 'warn') => {
        setSportsLogs(prev => [{ id: Math.random(), msg, type, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 50));
    };

    const handleChaseMatch = async (match: LiveMatch) => {
        addLog(`Initiating Taker Chase on ${match.homeTeam}...`, 'info');
        toast.info(`Manual Chase: Evaluating ${match.homeTeam} Edge...`);
        try {
            await axios.post('/api/bot/execute-arb', { userId, marketId: match.conditionId });
        } catch (e) {
            addLog(`Execution failed: Node communication error`, 'warn');
        }
    };

    useEffect(() => {
        const fetchLiveSports = async () => {
            try {
                const res = await axios.get(`/api/bot/sports/live/${userId}`);
                if (res.data.success && Array.isArray(res.data.matches)) {
                    const enriched = res.data.matches.map((m: any) => ({
                        ...m,
                        fairValue: calculateUIVector(m.score, m.minute),
                        marketPrice: m.marketPrice || 0
                    }));
                    setMatches(enriched);
                    setStats(prev => ({ ...prev, scouting: enriched.length }));
                }
            } catch (e) { console.error("Sports Poll Failed"); }
        };

        const interval = setInterval(fetchLiveSports, 3000);
        return () => clearInterval(interval);
    }, [userId]);

    return (
        <div className="grid grid-cols-12 gap-5 animate-in fade-in duration-700 max-w-[1600px] mx-auto pb-10">
            
            {/* Minimal Pro Header Stats */}
            <div className="col-span-12 grid grid-cols-1 md:grid-cols-4 gap-4 mb-2">
                <div className="glass-panel p-4 rounded-2xl border-white/5 bg-gradient-to-tr from-white/[0.01] to-transparent">
                    <p className="text-[8px] font-black text-gray-500 uppercase tracking-[0.3em] mb-1">Live Scouting</p>
                    <div className="flex items-baseline gap-2">
                        <span className="text-xl font-black text-white">{matches.length}</span>
                        <span className="text-[8px] text-emerald-500 font-bold uppercase tracking-tighter animate-pulse">Match Feeds Active</span>
                    </div>
                </div>
                <div className="glass-panel p-4 rounded-2xl border-white/5">
                    <p className="text-[8px] font-black text-gray-500 uppercase tracking-[0.3em] mb-1">Alpha Scanner</p>
                    <div className="flex items-baseline gap-2">
                        <span className="text-xl font-black text-emerald-500 uppercase tracking-tighter">Running</span>
                        <span className="text-[8px] text-gray-600 font-bold uppercase tracking-tighter">Latency: 1.2ms</span>
                    </div>
                </div>
                <div className="glass-panel p-4 rounded-2xl border-white/5">
                    <p className="text-[8px] font-black text-gray-500 uppercase tracking-[0.3em] mb-1">Chase Engine</p>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-600'}`}></div>
                        <span className="text-xl font-black text-white uppercase tracking-tighter">{isRunning ? 'Armed' : 'Standby'}</span>
                    </div>
                </div>
                <div className="glass-panel p-4 rounded-2xl border-emerald-500/20 bg-emerald-500/[0.02]">
                    <p className="text-[8px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-1">Realized Edge</p>
                    <div className="flex items-baseline gap-2">
                        <span className="text-xl font-black text-white font-mono">$0.00</span>
                        <span className="text-[8px] text-emerald-600 font-bold uppercase tracking-tighter">Goal Profits</span>
                    </div>
                </div>
            </div>

            {/* Main Information Layer */}
            <div className="col-span-12 lg:col-span-8 space-y-6">
                <div className="flex justify-between items-center px-2">
                    <h2 className="text-sm font-black text-white uppercase tracking-[0.4em] flex items-center gap-3">
                        <PulseIcon className="text-emerald-500" size={14}/> Pitch Intelligence Feed
                    </h2>
                    <div className="flex gap-2">
                        <span className="px-2 py-1 bg-white/[0.03] border border-white/[0.05] rounded text-[8px] font-black text-gray-500 uppercase tracking-widest">Sportmonks V3 API</span>
                        <span className="px-2 py-1 bg-white/[0.03] border border-white/[0.05] rounded text-[8px] font-black text-gray-500 uppercase tracking-widest">Polymarket CLOB</span>
                    </div>
                </div>

                {matches.length === 0 ? (
                    <div className="glass-panel p-20 rounded-[2rem] border-white/5 text-center flex flex-col items-center justify-center">
                        <Loader2 className="animate-spin text-blue-500/50 mb-4" size={32}/>
                        <p className="text-gray-600 uppercase font-black tracking-[0.3em] text-[10px]">Synchronizing Match Data...</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {matches.map(m => (
                            <MatchCard key={m.id} match={m} onChase={handleChaseMatch} />
                        ))}
                    </div>
                )}

                {/* Tighter Briefing Section */}
                <div className="p-5 glass-panel rounded-[1.5rem] border-white/5 bg-gradient-to-br from-blue-600/[0.04] to-transparent">
                    <div className="flex items-start gap-4">
                        <div className="p-2.5 bg-blue-600/20 border border-blue-600/20 rounded-xl text-blue-500">
                            <Cpu size={20}/>
                        </div>
                        <div className="space-y-1.5">
                            <h3 className="text-[11px] font-black text-white uppercase tracking-widest italic">Quant Model: Pitch Alpha</h3>
                            <p className="text-gray-500 text-[10px] leading-relaxed tracking-tight">
                                The engine monitors low-latency soccer feeds and cross-references Polymarket order books.
                                Goal detection typically occurs <span className="text-white font-bold">15-30s</span> before standard broadcasts. 
                                <br/>
                                <span className="text-emerald-500 font-bold">Protocol:</span> Execute FOK Taker orders to sweep stale pricing before market makers adjust spreads.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Sidebar Tape */}
            <div className="col-span-12 lg:col-span-4 flex flex-col h-full min-h-[500px]">
                <div className="glass-panel rounded-[1.5rem] border-white/5 overflow-hidden flex flex-col flex-1">
                    <div className="px-5 py-4 border-b border-white/[0.03] bg-white/[0.01] flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <Target size={14} className="text-rose-500"/>
                            <h3 className="text-[10px] font-black text-white uppercase tracking-[0.2em]">Execution Tape</h3>
                        </div>
                        <span className="text-[8px] font-bold text-gray-500">REAL-TIME</span>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto p-4 space-y-1.5 font-mono text-[9px] custom-scrollbar bg-black/10">
                        {sportsLogs.length === 0 && (
                            <div className="h-full flex flex-col items-center justify-center text-gray-700 opacity-20 text-center px-4">
                                <Activity size={32} className="mb-3"/>
                                <p className="uppercase tracking-[0.3em] font-black">Awaiting Goal Events...</p>
                            </div>
                        )}
                        {sportsLogs.map(log => (
                            <div key={log.id} className="flex gap-3 leading-tight">
                                <span className="text-gray-600 shrink-0">[{log.time}]</span>
                                <span className={`${
                                    log.type === 'success' ? 'text-emerald-500' :
                                    log.type === 'warn' ? 'text-rose-400' : 'text-blue-400'
                                }`}>
                                    {log.msg}
                                </span>
                            </div>
                        ))}
                    </div>

                    <div className="p-4 border-t border-white/[0.03] bg-white/[0.01]">
                        <div className="flex items-center justify-between p-3 bg-black/40 rounded-xl border border-white/[0.05]">
                            <span className="text-[8px] font-black text-white uppercase tracking-widest flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ENGINE ACTIVE
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SportsRunner;
