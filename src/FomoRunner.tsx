
// DO add comment above each fix.
import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  Target, Loader2, Radar, Flame, Info,
  TrendingDown, Timer, BarChart3, ChevronRight
} from 'lucide-react';

interface FlashMove {
    tokenId: string;
    conditionId: string;
    oldPrice: number;
    newPrice: number;
    velocity: number;
    timestamp: number;
    question?: string;
    image?: string;
    marketSlug?: string;
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
    const isUp = move.velocity > 0;
    const velocityPct = Math.abs(move.velocity * 100).toFixed(1);

    return (
        <div className="relative group animate-in fade-in slide-in-from-bottom-2 duration-500 w-full">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-rose-500 to-orange-500 rounded-[1.5rem] blur opacity-20 group-hover:opacity-40 transition-opacity"></div>
            <div className="glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/90 overflow-hidden relative flex flex-col h-full shadow-xl">
                <div className="p-4 flex items-center justify-between border-b border-white/5 bg-white/[0.02]">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-rose-500/20 flex items-center justify-center text-rose-500">
                            <Zap size={14} fill="currentColor" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[9px] font-black text-rose-400 uppercase tracking-widest leading-none">Flash Move</p>
                            <p className="text-[8px] text-slate-500 font-mono mt-0.5">{(new Date(move.timestamp)).toLocaleTimeString()}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-rose-500/10 rounded-full border border-rose-500/20">
                        <TrendingUp size={10} className="text-rose-400"/>
                        <span className="text-[10px] font-black text-rose-400">{velocityPct}%</span>
                    </div>
                </div>
                
                <div className="p-5 flex-1">
                    <h4 className="text-sm font-bold text-white mb-4 line-clamp-2 leading-snug h-10">{move.question || 'Unknown Market'}</h4>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="bg-black/30 p-3 rounded-xl border border-white/5">
                            <p className="text-[8px] font-bold text-slate-500 uppercase mb-1">Baseline</p>
                            <p className="text-lg font-mono font-bold text-slate-400">${move.oldPrice.toFixed(2)}</p>
                        </div>
                        <div className="bg-rose-500/10 p-3 rounded-xl border border-rose-500/20">
                            <p className="text-[8px] font-bold text-rose-500 uppercase mb-1">Spike</p>
                            <p className="text-lg font-mono font-bold text-white">${move.newPrice.toFixed(2)}</p>
                        </div>
                    </div>
                </div>
                <div className="px-5 pb-5">
                    <button className="w-full py-3 bg-white text-black rounded-xl font-black text-[10px] uppercase tracking-[0.2em] hover:scale-[1.02] transition-transform flex items-center justify-center gap-2 shadow-lg">
                        <Sword size={14}/> Execute Entry
                    </button>
                </div>
            </div>
        </div>
    );
};

const SnipeCard = ({ snipe }: { snipe: ActiveSnipe }) => {
    const roi = ((snipe.currentPrice - snipe.entryPrice) / snipe.entryPrice) * 100;
    const isProfit = roi >= 0;

    return (
        <div className="glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/60 p-5 space-y-4 border-l-4 border-l-emerald-500">
            <div className="flex justify-between items-start gap-4">
                <h4 className="text-xs font-bold text-white leading-snug line-clamp-1">{snipe.question || 'FOMO Snipe'}</h4>
                <div className={`px-2 py-0.5 rounded-lg font-mono font-black text-[10px] ${isProfit ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                    {isProfit ? '+' : ''}{roi.toFixed(2)}%
                </div>
            </div>
            
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-black/20 p-2 rounded-xl text-center">
                    <p className="text-[7px] font-bold text-slate-500 uppercase mb-1">Entry</p>
                    <p className="text-xs font-mono font-bold text-white">${snipe.entryPrice.toFixed(2)}</p>
                </div>
                <div className="bg-black/20 p-2 rounded-xl text-center">
                    <p className="text-[7px] font-bold text-slate-500 uppercase mb-1">Current</p>
                    <p className="text-xs font-mono font-bold text-white">${snipe.currentPrice.toFixed(2)}</p>
                </div>
                <div className="bg-emerald-500/5 p-2 rounded-xl text-center border border-emerald-500/10">
                    <p className="text-[7px] font-bold text-emerald-500 uppercase mb-1">Target</p>
                    <p className="text-xs font-mono font-bold text-emerald-400">${snipe.targetPrice.toFixed(2)}</p>
                </div>
            </div>

            <div className="flex items-center gap-2">
                <button className="flex-1 py-2 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 text-[9px] font-black uppercase rounded-lg transition-colors border border-rose-500/20">
                    Emergency Exit
                </button>
            </div>
        </div>
    );
};

const FomoRunner = ({ flashMoves = [], activeSnipes = [] }: { flashMoves: FlashMove[], activeSnipes: ActiveSnipe[] }) => {
    const [activeTab, setActiveTab] = useState<'scanner' | 'snipes'>('scanner');
    const heat = flashMoves.length > 5 ? 'EXTREME' : flashMoves.length > 0 ? 'HIGH' : 'STABLE';

    return (
        <div className="space-y-6 md:space-y-10 animate-in fade-in duration-700 px-0 md:px-4">
            {/* Real-time Hero Section */}
            <div className="flex flex-col md:flex-row justify-between items-center gap-6 px-4 md:px-0">
                <div className="space-y-2 text-center md:text-left">
                    <div className="flex items-center justify-center md:justify-start gap-3">
                        <div className="p-2 bg-rose-600 rounded-xl shadow-lg shadow-rose-900/30">
                            {/* Removed non-existent md:size prop to resolve TypeScript error */}
                            <Flame className="text-white" size={24}/>
                        </div>
                        <h2 className="text-2xl md:text-5xl font-black text-white uppercase tracking-tighter italic leading-none">
                            FOMO <span className="text-rose-600">RUNNER</span>
                        </h2>
                    </div>
                    <p className="text-[8px] md:text-xs text-slate-500 font-bold uppercase tracking-[0.4em] ml-1">Velocity Liquidity Sniper v2.1</p>
                </div>

                <div className="w-full md:w-auto bg-slate-900/60 p-4 rounded-2xl border border-white/10 flex items-center justify-between md:justify-start gap-6 md:gap-8 backdrop-blur-md">
                    <div className="text-center md:text-left">
                        <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-1">Global Heat</p>
                        <p className={`text-sm md:text-xl font-black font-mono ${heat === 'EXTREME' ? 'text-rose-500 animate-pulse' : 'text-orange-400'}`}>{heat}</p>
                    </div>
                    <div className="w-px h-8 md:h-10 bg-white/10"></div>
                    <div className="text-center md:text-left">
                        <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-1">Active Snipes</p>
                        <p className="text-sm md:text-xl font-black text-white font-mono">{activeSnipes.length}</p>
                    </div>
                </div>
            </div>

            {/* View Selection Tabs */}
            <div className="flex gap-2 px-4 md:px-0">
                <button 
                    onClick={() => setActiveTab('scanner')}
                    className={`flex-1 md:flex-none px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === 'scanner' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-900 text-slate-500'}`}
                >
                    <Radar size={14}/> Live Scanner
                </button>
                <button 
                    onClick={() => setActiveTab('snipes')}
                    className={`flex-1 md:flex-none px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === 'snipes' ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-900 text-slate-500'}`}
                >
                    <Target size={14}/> My Snipes
                </button>
            </div>

            {/* Content Area */}
            <div className="px-4 md:px-0">
                {activeTab === 'scanner' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {flashMoves.length === 0 ? (
                            <div className="col-span-full glass-panel py-24 rounded-[2rem] border-white/5 text-center space-y-6">
                                <div className="relative mx-auto w-20 h-20">
                                    <div className="absolute inset-0 bg-rose-500/20 blur-2xl rounded-full animate-pulse"></div>
                                    <Loader2 className="animate-spin text-rose-500 mx-auto relative z-10" size={48}/>
                                </div>
                                <div className="space-y-2">
                                    <p className="text-white font-black uppercase tracking-[0.4em] text-xs">Awaiting Alpha</p>
                                    <p className="text-slate-500 text-[10px] uppercase font-bold tracking-widest">Scanning 1,472 Markets for Pitch Velocity...</p>
                                </div>
                            </div>
                        ) : (
                            flashMoves.map((move, idx) => <FlashCard key={move.tokenId + idx} move={move} />)
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {activeSnipes.length === 0 ? (
                            <div className="col-span-full glass-panel py-20 rounded-[2rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20">
                                <Target size={40} className="text-slate-800 mb-4"/>
                                <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">No active snipes in orbit</p>
                            </div>
                        ) : (
                            activeSnipes.map((snipe, idx) => <SnipeCard key={snipe.tokenId + idx} snipe={snipe} />)
                        )}
                    </div>
                )}
            </div>

            {/* Educational / System Footer */}
            <div className="mx-4 md:mx-0 p-6 glass-panel rounded-3xl border-white/5 bg-blue-600/[0.03] flex flex-col md:flex-row items-center gap-6">
                <div className="w-12 h-12 bg-blue-600/20 rounded-2xl flex items-center justify-center text-blue-500 shrink-0">
                    <Info size={24}/>
                </div>
                <div className="text-center md:text-left space-y-1">
                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Autonomous Guard Strategy</p>
                    <p className="text-xs text-slate-400 leading-relaxed">
                        The FOMO Runner monitors global price velocity via the raw CLOB WebSocket. It enters only when upward momentum is confirmed and liquidity depth exceeds $1,000 to prevent slippage traps.
                    </p>
                </div>
                <div className="flex gap-4 shrink-0">
                    <div className="text-center">
                        <p className="text-[8px] font-bold text-slate-500 uppercase mb-1">Safety Cap</p>
                        <div className="px-3 py-1 bg-black/40 rounded-lg text-[10px] font-mono font-bold text-white">$100/trade</div>
                    </div>
                    <div className="text-center">
                        <p className="text-[8px] font-bold text-slate-500 uppercase mb-1">Stop Loss</p>
                        <div className="px-3 py-1 bg-rose-500/20 rounded-lg text-[10px] font-mono font-bold text-rose-400">-10%</div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FomoRunner;
