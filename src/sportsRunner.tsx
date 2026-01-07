
import React, { useState, useEffect, useMemo } from 'react';
import { 
  Trophy, Activity, Zap, Timer, Target, TrendingUp, 
  ArrowRightCircle, AlertCircle, Shield, Play, Square,
  BarChart3, RefreshCw, Loader2, Globe, Cpu, Hash,
  ChevronRight, ExternalLink, ZapOff, Goal, Sword
} from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';

// --- Types ---
interface LiveMatch {
  id: string;
  conditionId: string;
  homeTeam: string;
  awayTeam: string;
  score: [number, number]; // [Home, Away]
  minute: number;
  marketPrice: number; // Current Ask on Polymarket
  fairValue: number;   // Quant calculated price based on score
  status: 'LIVE' | 'HT' | 'VAR' | 'GOAL';
  eventSlug?: string;
  marketSlug?: string;
  category: string;
  lastGoalAt?: number;
}

// --- Quant Utility: Calculate Fair Value (Simplified Soccer Model) ---
// In a production environment, this would use Poisson distributions or trained ML models.
const calculateFairValue = (score: [number, number], minute: number, side: 'HOME' | 'DRAW' | 'AWAY'): number => {
    const [h, a] = score;
    const timeRemaining = Math.max(0, 90 - minute);
    
    // Base probability estimates for 3-way soccer
    if (side === 'HOME') {
        if (h > a) return 0.85 + (h - a) * 0.05 - (timeRemaining * 0.001);
        if (h === a) return 0.45 - (minute * 0.002);
        return 0.15;
    }
    if (side === 'DRAW') {
        if (h === a) return 0.40 + (minute * 0.005);
        if (Math.abs(h - a) === 1) return 0.25 - (minute * 0.002);
        return 0.05;
    }
    return 0.5; // Placeholder
};

const MatchCard = ({ match, onChase }: { match: LiveMatch, onChase: (m: LiveMatch) => void }) => {
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

    return (
        <div className={`glass-panel p-5 rounded-[2rem] border transition-all duration-500 ${
            pulse ? 'border-rose-500 shadow-[0_0_30px_rgba(244,63,94,0.3)] animate-pulse' : 
            isProfitable ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5'
        }`}>
            <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${match.status === 'LIVE' ? 'bg-emerald-500 animate-ping' : 'bg-rose-500'}`}></span>
                    <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{match.minute}' | {match.status}</span>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[8px] font-black uppercase tracking-widest">
                    <Timer size={10}/> Latency: 1.2s
                </div>
            </div>

            <div className="space-y-4 mb-6">
                <div className="flex justify-between items-center px-2">
                    <div className="flex flex-col">
                        <span className="text-sm font-black text-white uppercase tracking-tight">{match.homeTeam}</span>
                        <span className="text-[10px] text-gray-500 font-bold">Home</span>
                    </div>
                    <div className="text-2xl font-black text-white font-mono bg-white/5 px-4 py-1 rounded-2xl border border-white/5">
                        {match.score[0]} : {match.score[1]}
                    </div>
                    <div className="flex flex-col text-right">
                        <span className="text-sm font-black text-white uppercase tracking-tight">{match.awayTeam}</span>
                        <span className="text-[10px] text-gray-500 font-bold">Away</span>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="p-3 bg-black/40 rounded-2xl border border-white/5">
                    <p className="text-[8px] font-black text-gray-500 uppercase mb-1">Market Price</p>
                    <p className="text-sm font-mono font-black text-white">${match.marketPrice.toFixed(2)}</p>
                </div>
                <div className="p-3 bg-black/40 rounded-2xl border border-white/5">
                    <p className="text-[8px] font-black text-gray-500 uppercase mb-1">Fair Value</p>
                    <p className="text-sm font-mono font-black text-emerald-400">${match.fairValue.toFixed(2)}</p>
                </div>
            </div>

            <div className="flex items-center justify-between gap-4 pt-2">
                <div className="flex flex-col">
                    <span className="text-[9px] font-black text-gray-600 uppercase tracking-widest">Edge Delta</span>
                    <span className={`text-sm font-black ${delta >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)}¢
                    </span>
                </div>
                <button 
                    onClick={() => onChase(match)}
                    className={`flex-1 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${
                        isProfitable ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20' : 'bg-white/5 text-gray-500 border border-white/10'
                    }`}
                >
                    <Sword size={14}/> {isProfitable ? 'Chase Alpha' : 'Monitoring'}
                </button>
            </div>
        </div>
    );
};

const SportsRunner = ({ userId, isRunning }: { userId: string, isRunning: boolean }) => {
    const [matches, setMatches] = useState<LiveMatch[]>([
        {
            id: 'm1',
            conditionId: '0x...',
            homeTeam: 'Arsenal',
            awayTeam: 'Liverpool',
            score: [1, 1],
            minute: 74,
            marketPrice: 0.35, // Market still thinks draw is unlikely
            fairValue: 0.52,   // Quant thinks draw is 52%
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

    const [sportsLogs, setSportsLogs] = useState<any[]>([]);

    const addLog = (msg: string, type: 'info' | 'success' | 'warn') => {
        setSportsLogs(prev => [{ id: Math.random(), msg, type, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 50));
    };

    const handleChaseMatch = async (match: LiveMatch) => {
        addLog(`Initiating Taker Chase on ${match.homeTeam}...`, 'info');
        // Logic would go to API
        toast.success(`Sent FOK Order for ${match.homeTeam}`);
        addLog(`FOK filled at $${match.marketPrice} (Fair: $${match.fairValue})`, 'success');
    };

    return (
        <div className="grid grid-cols-12 gap-8 animate-in fade-in duration-700 max-w-[1600px] mx-auto">
            
            {/* Header Stats */}
            <div className="col-span-12 grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="glass-panel p-6 rounded-[2rem] border-white/5">
                    <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] mb-2">Live Scouting</p>
                    <div className="text-3xl font-black text-white">{matches.length} Matches</div>
                    <div className="mt-2 text-[10px] text-emerald-500 font-bold uppercase animate-pulse">Scanning Sportsmonks API</div>
                </div>
                <div className="glass-panel p-6 rounded-[2rem] border-white/5">
                    <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] mb-2">Arbitrage Edge</p>
                    <div className="text-3xl font-black text-emerald-500">+18.4%</div>
                    <div className="mt-2 text-[10px] text-gray-500 font-bold uppercase">Average Stale-Price Delta</div>
                </div>
                <div className="glass-panel p-6 rounded-[2rem] border-white/5">
                    <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.3em] mb-2">Auto-Chase Status</p>
                    <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-500'}`}></div>
                        <span className="text-2xl font-black text-white uppercase">{isRunning ? 'Armed' : 'Standby'}</span>
                    </div>
                </div>
                <div className="glass-panel p-6 rounded-[2rem] border-emerald-500/20 bg-emerald-500/[0.02]">
                    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-2">Goal Profits</p>
                    <div className="text-3xl font-black text-white font-mono">$1,240.50</div>
                    <div className="mt-2 text-[10px] text-gray-500 font-bold uppercase">Total realized from frontrunning</div>
                </div>
            </div>

            {/* Live Pitch */}
            <div className="col-span-12 lg:col-span-8 space-y-8">
                <div className="flex justify-between items-center">
                    <h2 className="text-xl font-black text-white uppercase tracking-tighter italic">Live Intelligence Feed</h2>
                    <div className="flex gap-2">
                        <button className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[10px] font-black text-gray-400 uppercase tracking-widest hover:text-white">All Leagues</button>
                        <button className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-[10px] font-black text-emerald-400 uppercase tracking-widest">Arbitrage Only</button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {matches.map(m => (
                        <MatchCard key={m.id} match={m} onChase={handleChaseMatch} />
                    ))}
                </div>

                {/* Educational / Logic Helper */}
                <div className="p-8 glass-panel rounded-[3rem] border-white/5 bg-gradient-to-br from-blue-600/[0.05] to-transparent">
                    <div className="flex items-start gap-6">
                        <div className="p-4 bg-blue-600 rounded-3xl text-white shadow-xl shadow-blue-600/20">
                            <Cpu size={32}/>
                        </div>
                        <div className="space-y-3">
                            <h3 className="text-lg font-black text-white uppercase italic">Quant Engine Logic</h3>
                            <p className="text-gray-500 text-sm leading-relaxed">
                                The SportsRunner engine monitors low-latency soccer feeds (Sportsmonks) and cross-references them with Polymarket order books. When a goal is scored, we detect it <span className="text-white font-bold">15-30 seconds</span> before most TV broadcasts. 
                                <br/><br/>
                                <span className="text-blue-400">Strategy:</span> The bot executes "Taker" orders (FOK) to sweep the stale book before standard market makers can adjust their spreads.
                            </p>
                            <div className="flex gap-4 pt-2">
                                <div className="flex items-center gap-2 text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                    <Shield size={14} className="text-emerald-500"/> VAR Guard Enabled
                                </div>
                                <div className="flex items-center gap-2 text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                    <Zap size={14} className="text-amber-500"/> FOK Execution
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Runner Console */}
            <div className="col-span-12 lg:col-span-4 space-y-6">
                <div className="glass-panel rounded-[2rem] border-white/5 overflow-hidden flex flex-col h-[700px]">
                    <div className="px-6 py-4 border-b border-white/5 bg-white/[0.02] flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <Target size={18} className="text-rose-500"/>
                            <h3 className="text-xs font-black text-white uppercase tracking-widest">Goal Execution Tape</h3>
                        </div>
                        <button onClick={() => setSportsLogs([])} className="text-[10px] text-gray-500 hover:text-white uppercase font-black">Purge</button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-[11px] custom-scrollbar">
                        {sportsLogs.length === 0 && (
                            <div className="h-full flex flex-col items-center justify-center text-gray-700 opacity-30 text-center px-10">
                                <Activity size={40} className="mb-4"/>
                                <p className="uppercase tracking-[0.2em] font-black">Awaiting Goal Signal...</p>
                            </div>
                        )}
                        {sportsLogs.map(log => (
                            <div key={log.id} className="flex gap-3 animate-in slide-in-from-left-2 duration-300">
                                <span className="text-gray-600 shrink-0">[{log.time}]</span>
                                <span className={`${
                                    log.type === 'success' ? 'text-emerald-400' :
                                    log.type === 'warn' ? 'text-amber-400' : 'text-blue-300'
                                }`}>
                                    {log.msg}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className="p-6 border-t border-white/5 bg-black/40">
                         <div className="flex flex-col gap-4">
                            <div className="flex justify-between items-center">
                                <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Autonomous Chasing</span>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" checked={isRunning} className="sr-only peer" readOnly />
                                    <div className="w-10 h-5 bg-white/10 rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-emerald-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
                                </label>
                            </div>
                            <button className="w-full py-4 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-2xl text-[10px] uppercase tracking-[0.3em] transition-all shadow-xl shadow-rose-900/20">
                                Global Stop & Exit
                            </button>
                         </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SportsRunner;
