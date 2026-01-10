
import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  ArrowRightLeft, Target, Loader2, Radar, Flame, Info,
  TrendingDown, Timer
} from 'lucide-react';

interface SportsMatch {
    id: string;
    conditionId: string;
    question: string;
    outcomes: string[];
    outcomePrices: number[];
    tokenIds: string[];
    image: string;
    slug: string;
    eventSlug: string;
    startTime: string;
    minute: number;
    homeScore: number;
    awayScore: number;
    status: 'LIVE' | 'UPCOMING' | 'HALFTIME' | 'FINISHED';
    correlation: 'ALIGNED' | 'DIVERGENT' | 'UNVERIFIED';
    edgeWindow: number;
    priceEvidence?: string;
    confidence: number;
}

const MatchCard = ({ match }: { match: SportsMatch }) => {
    const isDivergent = match.correlation === 'DIVERGENT';
    const polyUrl = `https://polymarket.com/event/${match.eventSlug}/${match.slug}`;
    const [prevPrices, setPrevPrices] = useState<number[]>(match.outcomePrices);

    useEffect(() => {
        const timer = setTimeout(() => setPrevPrices(match.outcomePrices), 2500);
        return () => clearTimeout(timer);
    }, [match.outcomePrices]);

    return (
        <div className={`relative group transition-all duration-700 ${isDivergent ? 'scale-[1.01] z-20' : ''}`}>
            {isDivergent && (
                <div className="absolute -inset-1 bg-gradient-to-r from-rose-600 to-amber-600 rounded-[2.5rem] blur opacity-25 animate-pulse"></div>
            )}

            <div className={`glass-panel rounded-[2.2rem] border transition-all duration-500 overflow-hidden relative ${
                isDivergent ? 'border-rose-500 bg-slate-900/90' : 'border-white/5 bg-slate-950/40'
            }`}>
                <div className="h-32 w-full relative overflow-hidden">
                    <img src={match.image} alt="bg" className="w-full h-full object-cover opacity-20 blur-[1px] scale-105" />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 to-transparent"></div>
                    
                    <div className="absolute top-5 left-6 flex items-center gap-3">
                        <div className="flex items-center gap-2 px-3 py-1 bg-black/40 backdrop-blur-md rounded-full border border-white/10">
                            <div className={`w-1.5 h-1.5 rounded-full ${isDivergent ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`}></div>
                            <span className="text-[9px] font-black text-white uppercase tracking-[0.2em]">
                                {match.minute}' LIVE
                            </span>
                        </div>
                    </div>

                    <div className="absolute top-5 right-6">
                        <a href={polyUrl} target="_blank" rel="noreferrer" className="p-2 bg-white/5 hover:bg-white/10 rounded-xl transition-all">
                            <ExternalLink size={14} className="text-slate-400" />
                        </a>
                    </div>
                </div>

                <div className="px-8 -mt-8 relative z-10 pb-8">
                    <div className="flex justify-between items-center mb-8">
                        <div className="text-center flex-1">
                            <h3 className="text-4xl font-black text-white font-mono tracking-tighter">{match.homeScore}</h3>
                            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">HOME</p>
                        </div>
                        <div className="px-4 flex flex-col items-center opacity-30">
                            <div className="w-px h-8 bg-white mb-1"></div>
                            <span className="text-[8px] font-bold">VS</span>
                            <div className="w-px h-8 bg-white mt-1"></div>
                        </div>
                        <div className="text-center flex-1">
                            <h3 className="text-4xl font-black text-white font-mono tracking-tighter">{match.awayScore}</h3>
                            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">AWAY</p>
                        </div>
                    </div>

                    <h4 className="text-sm font-black text-white uppercase tracking-tight line-clamp-1 mb-8 text-center px-4">
                        {match.question}
                    </h4>

                    {/* Prominent Outcome Buttons */}
                    <div className={`grid gap-3 mb-8 ${match.outcomes.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                        {match.outcomes.map((outcome, idx) => {
                            const price = match.outcomePrices[idx];
                            const prev = prevPrices[idx];
                            const trend = price > prev ? 'up' : price < prev ? 'down' : null;

                            return (
                                <button key={idx} className="flex flex-col items-center p-4 bg-white/[0.03] rounded-[1.5rem] border border-white/[0.05] hover:bg-blue-600/20 hover:border-blue-500/50 transition-all group/btn">
                                    <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-2 truncate w-full text-center group-hover/btn:text-blue-400">
                                        {outcome}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <span className={`text-xl font-mono font-black ${trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-rose-400' : 'text-white'}`}>
                                            ${price.toFixed(2)}
                                        </span>
                                        {trend === 'up' && <TrendingUp size={12} className="text-emerald-500" />}
                                        {trend === 'down' && <TrendingDown size={12} className="text-rose-500" />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    <div className={`rounded-2xl p-4 flex items-center gap-4 transition-all ${
                        isDivergent ? 'bg-rose-500/10 border border-rose-500/20' : 'bg-black/40 border border-white/5'
                    }`}>
                        <div className={`p-2 rounded-xl ${isDivergent ? 'bg-rose-500 text-white' : 'bg-slate-800 text-slate-500'}`}>
                            {isDivergent ? <Flame size={16} /> : <Radar size={16} />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-[9px] font-black uppercase tracking-widest ${isDivergent ? 'text-rose-400' : 'text-slate-500'}`}>
                                {isDivergent ? 'ALPHA EDGE DETECTED' : 'MARKET PARITY'}
                            </p>
                            <p className="text-[8px] font-mono text-slate-400 truncate italic">
                                {match.priceEvidence || "Scanning global pitch velocity..."}
                            </p>
                        </div>
                        {isDivergent && (
                            <div className="text-right">
                                <span className="text-xs font-mono font-black text-white">+{match.edgeWindow}s</span>
                                <p className="text-[7px] font-bold text-rose-500 uppercase">LEAD</p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-8 pb-8">
                    <button className={`w-full py-4 font-black text-[10px] uppercase tracking-[0.3em] rounded-2xl transition-all flex items-center justify-center gap-3 ${
                        isDivergent 
                        ? 'bg-gradient-to-r from-rose-600 to-amber-600 text-white shadow-xl shadow-rose-900/40' 
                        : 'bg-white hover:bg-slate-200 text-black shadow-lg'
                    }`}>
                        <Sword size={16}/> {isDivergent ? 'EXECUTE SNIPE' : 'OPEN ORDER TICKET'}
                    </button>
                </div>
            </div>
        </div>
    );
};

const SportsRunner = ({ sportsMatches = [] }: { sportsMatches?: SportsMatch[] }) => {
    const [filter, setFilter] = useState<'ALL' | 'LIVE' | 'UPCOMING'>('LIVE');
    
    const filteredMatches = useMemo(() => {
        if (filter === 'ALL') return sportsMatches;
        return sportsMatches.filter(m => m.status === filter);
    }, [sportsMatches, filter]);

    const divergentCount = sportsMatches.filter(m => m.correlation === 'DIVERGENT').length;

    return (
        <div className="max-w-[1700px] mx-auto pb-20 px-10 animate-in fade-in duration-1000">
            <div className="flex justify-between items-end mb-16">
                <div>
                    <h2 className="text-4xl font-black text-white uppercase tracking-tighter flex items-center gap-4 italic">
                        <Activity className="text-rose-500" size={36}/> Pitch Intel Terminal
                    </h2>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.4em] mt-3">
                        Institutional Latency Arbitrage Engine v5.2
                    </p>
                </div>

                <div className="flex bg-slate-900/50 p-2 rounded-2xl border border-white/5">
                    {(['LIVE', 'UPCOMING', 'ALL'] as const).map(f => (
                        <button 
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-8 py-3 rounded-xl text-[10px] font-black transition-all ${
                                filter === f ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-white'
                            }`}>
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-12 gap-10">
                <div className="col-span-12 xl:col-span-9">
                    {filteredMatches.length === 0 ? (
                        <div className="glass-panel p-40 rounded-[3rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20">
                            <Loader2 className="animate-spin text-rose-500/20 mb-10" size={80}/>
                            <p className="text-slate-600 uppercase font-black tracking-[0.8em] text-xs">Scanning Pitch Momentum...</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                            {filteredMatches.map(m => <MatchCard key={m.id} match={m} />)}
                        </div>
                    )}
                </div>

                <div className="col-span-12 xl:col-span-3">
                    <div className="glass-panel rounded-[2.5rem] border-white/5 sticky top-24 bg-black/40 overflow-hidden flex flex-col h-[750px] shadow-2xl">
                        <div className="px-8 py-8 border-b border-white/[0.03] flex justify-between items-center bg-white/[0.01]">
                            <h3 className="text-[10px] font-black text-white uppercase tracking-[0.4em] flex items-center gap-3">
                                <Target size={16} className="text-rose-500"/> Intelligence Tape
                            </h3>
                            {divergentCount > 0 && (
                                <div className="px-2 py-0.5 bg-rose-600 text-white text-[8px] font-black rounded animate-pulse">
                                    {divergentCount} SIGNAL
                                </div>
                            )}
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            {sportsMatches.filter(m => m.correlation === 'DIVERGENT').length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center opacity-20 text-center px-10">
                                    <Radar size={48} className="mb-6 text-slate-500" />
                                    <p className="text-[10px] font-black uppercase tracking-widest leading-relaxed">Watching pitch feeds for score divergence...</p>
                                </div>
                            ) : (
                                sportsMatches.filter(m => m.correlation === 'DIVERGENT').map(m => (
                                    <div key={m.id} className="p-6 bg-rose-500/[0.05] border border-rose-500/20 rounded-[2rem] animate-in slide-in-from-right duration-500">
                                        <div className="flex justify-between items-center mb-4">
                                            <span className="text-[10px] font-black text-rose-400 uppercase flex items-center gap-2"><Zap size={14} fill="currentColor"/> Snipe Alert</span>
                                            <span className="text-[9px] text-slate-600 font-mono">{(new Date()).toLocaleTimeString()}</span>
                                        </div>
                                        <p className="text-[11px] text-white font-bold leading-relaxed mb-4">{m.priceEvidence}</p>
                                        <div className="flex items-center gap-3 pt-4 border-t border-white/5">
                                            <Timer size={12} className="text-slate-500" />
                                            <span className="text-[9px] font-bold text-slate-500 uppercase">Edge: {m.edgeWindow}s Lead</span>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SportsRunner;
