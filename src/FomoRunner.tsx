
import React, { useState, useMemo } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  Target, Loader2, Radar, Flame, Info,
  TrendingUp, BarChart3, ChevronRight, Globe
} from 'lucide-react';

interface FlashMove {
    tokenId: string;
    oldPrice: number;
    newPrice: number;
    velocity: number;
    timestamp: number;
    question?: string;
}

interface ActiveSnipe {
    tokenId: string;
    entryPrice: number;
    currentPrice: number;
    shares: number;
    timestamp: number;
    targetPrice: number;
    question?: string;
}

const FlashCard = ({ move }: { move: FlashMove }) => {
    const velocityPct = (move.velocity * 100).toFixed(1);
    return (
        <div className="glass-panel rounded-2xl border-white/5 bg-slate-900/60 p-5 space-y-4 hover:bg-slate-900/80 transition-all border-l-4 border-l-rose-500">
            <div className="flex justify-between items-start">
                <div className="space-y-1 min-w-0">
                    <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest flex items-center gap-2">
                        <Zap size={12} fill="currentColor"/> High Velocity
                    </p>
                    <h4 className="text-sm font-bold text-white truncate">{move.question || `Token ${move.tokenId.slice(0, 8)}`}</h4>
                </div>
                <div className="px-2 py-1 bg-rose-500/10 rounded-lg text-rose-400 font-mono font-black text-xs">
                    +{velocityPct}%
                </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
                <div className="bg-black/20 p-3 rounded-xl border border-white/5">
                    <p className="text-[8px] font-bold text-slate-500 uppercase mb-1">Baseline</p>
                    <p className="text-sm font-mono font-bold text-slate-400">${move.oldPrice.toFixed(2)}</p>
                </div>
                <div className="bg-rose-500/5 p-3 rounded-xl border border-rose-500/20">
                    <p className="text-[8px] font-bold text-rose-400 uppercase mb-1">Current Spike</p>
                    <p className="text-sm font-mono font-black text-white">${move.newPrice.toFixed(2)}</p>
                </div>
            </div>

            <button className="w-full py-2.5 bg-white hover:bg-slate-200 text-black rounded-xl font-black text-[9px] uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2">
                <Sword size={14}/> Execute Entry
            </button>
        </div>
    );
};

const SnipeCard = ({ snipe }: { snipe: ActiveSnipe }) => {
    const roi = (((snipe.currentPrice || snipe.entryPrice) - snipe.entryPrice) / snipe.entryPrice) * 100;
    const isProfit = roi >= 0;

    return (
        <div className="glass-panel rounded-2xl border-white/5 bg-slate-900/60 p-5 space-y-4 border-l-4 border-l-emerald-500">
            <div className="flex justify-between items-start gap-4">
                <h4 className="text-xs font-bold text-white truncate">{snipe.question || `Position ${snipe.tokenId.slice(0,8)}`}</h4>
                <div className={`px-2 py-0.5 rounded-lg font-mono font-black text-[10px] ${isProfit ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                    {isProfit ? '+' : ''}{roi.toFixed(2)}%
                </div>
            </div>
            
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-black/20 p-2 rounded-xl text-center">
                    <p className="text-[7px] font-bold text-slate-500 uppercase">Entry</p>
                    <p className="text-[10px] font-mono font-bold text-white">${snipe.entryPrice.toFixed(2)}</p>
                </div>
                <div className="bg-black/20 p-2 rounded-xl text-center">
                    <p className="text-[7px] font-bold text-slate-500 uppercase">Current</p>
                    <p className="text-[10px] font-mono font-bold text-white">${(snipe.currentPrice || snipe.entryPrice).toFixed(2)}</p>
                </div>
                <div className="bg-emerald-500/5 p-2 rounded-xl text-center border border-emerald-500/10">
                    <p className="text-[7px] font-bold text-emerald-500 uppercase">Target</p>
                    <p className="text-[10px] font-mono font-bold text-emerald-400">${(snipe.targetPrice || 0).toFixed(2)}</p>
                </div>
            </div>

            <button className="w-full py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 text-[8px] font-black uppercase rounded-lg transition-colors border border-rose-500/20">
                Liquidate Position
            </button>
        </div>
    );
};

const FomoRunner = ({ fomoMoves = [], fomoSnipes = [] }: any) => {
    const [activeTab, setActiveTab] = useState<'radar' | 'my-snipes'>('radar');
    const heatLevel = fomoMoves.length > 5 ? 'CRITICAL' : fomoMoves.length > 0 ? 'HIGH' : 'STABLE';

    return (
        <div className="max-w-[1400px] mx-auto space-y-6 md:space-y-10 animate-in fade-in duration-700">
            {/* Minimal High-Fidelity Hero */}
            <div className="flex flex-col md:flex-row justify-between items-center gap-6 px-4 md:px-0">
                <div className="space-y-1 text-center md:text-left">
                    <div className="flex items-center justify-center md:justify-start gap-3">
                        <div className="p-2 bg-rose-600 rounded-xl shadow-lg">
                            <Flame className="text-white" size={20}/>
                        </div>
                        <h2 className="text-2xl md:text-4xl font-black text-white uppercase tracking-tighter italic">
                            FOMO <span className="text-rose-600">RUNNER</span>
                        </h2>
                    </div>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.4em]">Global Velocity Terminal v2.1</p>
                </div>

                <div className="flex gap-4 w-full md:w-auto">
                    <div className="flex-1 md:flex-none bg-slate-900/60 p-4 rounded-2xl border border-white/10 flex items-center gap-4 backdrop-blur-md">
                        <div className="space-y-0.5">
                            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Global Heat</p>
                            <p className={`text-sm font-black font-mono ${heatLevel === 'CRITICAL' ? 'text-rose-500 animate-pulse' : 'text-orange-400'}`}>{heatLevel}</p>
                        </div>
                        <div className="w-px h-8 bg-white/10"></div>
                        <div className="space-y-0.5">
                            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Active Streams</p>
                            <p className="text-sm font-black text-white font-mono">1,472</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Tabbed Navigation */}
            <div className="flex border-b border-white/5 px-4 md:px-0">
                <button 
                    onClick={() => setActiveTab('radar')}
                    className={`px-8 py-4 text-[10px] font-black uppercase tracking-widest transition-all relative ${activeTab === 'radar' ? 'text-white' : 'text-slate-500'}`}
                >
                    <Radar size={14} className="inline mr-2 mb-1"/> Global Radar
                    {activeTab === 'radar' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-rose-500"></div>}
                </button>
                <button 
                    onClick={() => setActiveTab('my-snipes')}
                    className={`px-8 py-4 text-[10px] font-black uppercase tracking-widest transition-all relative ${activeTab === 'my-snipes' ? 'text-white' : 'text-slate-500'}`}
                >
                    <Target size={14} className="inline mr-2 mb-1"/> My Snipes ({fomoSnipes.length})
                    {activeTab === 'my-snipes' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500"></div>}
                </button>
            </div>

            <main className="px-4 md:px-0">
                {activeTab === 'radar' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {fomoMoves.length === 0 ? (
                            <div className="col-span-full py-24 text-center space-y-4 glass-panel rounded-3xl border-white/5">
                                <Loader2 className="animate-spin text-rose-500/20 mx-auto" size={48}/>
                                <p className="text-slate-600 uppercase font-black tracking-[0.4em] text-[10px]">Scanning global feeds for alpha velocity...</p>
                            </div>
                        ) : (
                            fomoMoves.map((m: any, i: number) => <FlashCard key={m.tokenId + i} move={m}/>)
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {fomoSnipes.length === 0 ? (
                            <div className="col-span-full py-24 text-center space-y-4 glass-panel rounded-3xl border-white/5">
                                <Target className="text-slate-800 mx-auto" size={48}/>
                                <p className="text-slate-600 uppercase font-black tracking-[0.4em] text-[10px]">No active sniper positions</p>
                            </div>
                        ) : (
                            fomoSnipes.map((s: any, i: number) => <SnipeCard key={s.tokenId + i} snipe={s}/>)
                        )}
                    </div>
                )}
            </main>

            {/* Tactical Footer Overlay */}
            <div className="mx-4 md:mx-0 p-6 glass-panel rounded-3xl border-white/5 bg-blue-600/[0.03] flex flex-col md:flex-row items-center gap-6">
                <div className="w-12 h-12 bg-blue-600/20 rounded-2xl flex items-center justify-center text-blue-500 shrink-0">
                    <Info size={24}/>
                </div>
                <div className="text-center md:text-left">
                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Autonomous Strategy Active</p>
                    <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
                        The FOMO Runner enters trades based on high-velocity price movements. To mitigate risk, it uses Fill-or-Kill orders and immediately parks a GTC take-profit sell order on the book. Stop-loss is hardcoded to 10%.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default FomoRunner;
