
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  ArrowRightLeft, Target, Loader2, Radar, Flame, Info,
  TrendingDown, ShieldAlert, Timer
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

    // Track price movements for visual feedback
    useEffect(() => {
        const timer = setTimeout(() => setPrevPrices(match.outcomePrices), 3000);
        return () => clearTimeout(timer);
    }, [match.outcomePrices]);

    return (
        <div className={`relative group transition-all duration-700 ${
            isDivergent ? 'scale-[1.02] z-20' : 'scale-100'
        }`}>
            {/* Divergence Glow Effect */}
            {isDivergent && (
                <div className="absolute -inset-1 bg-gradient-to-r from-rose-600 to-blue-600 rounded-[2.5rem] blur opacity-25 animate-pulse"></div>
            )}

            <div className={`glass-panel rounded-[2.2rem] border transition-all duration-500 overflow-hidden relative ${
                isDivergent ? 'border-rose-500 shadow-[0_0_50px_rgba(244,63,94,0.2)] bg-rose-950/10' : 'border-white/5 bg-slate-900/40'
            }`}>
                {/* Header Section */}
                <div className="h-32 w-full relative overflow-hidden">
                    <img 
                        src={match.image} 
                        alt="banner" 
                        className="w-full h-full object-cover opacity-20 blur-[1px] grayscale group-hover:grayscale-0 transition-all duration-1000"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-transparent to-transparent"></div>
                    
                    {/* Status & Confidence */}
                    <div className="absolute top-5 left-6 flex items-center gap-3">
                        <div className="flex items-center gap-2 px-3 py-1 bg-black/50 backdrop-blur-md rounded-full border border-white/10">
                            <div className={`w-2 h-2 rounded-full ${isDivergent ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`}></div>
                            <span className="text-[10px] font-black text-white uppercase tracking-widest">
                                {match.status === 'LIVE' ? `${match.minute}' LIVE` : 'PRE-MATCH'}
                            </span>
                        </div>
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-tighter">
                            CONFIDENCE: {(match.confidence * 100).toFixed(0)}%
                        </div>
                    </div>

                    <div className="absolute top-5 right-6">
                        <a href={polyUrl} target="_blank" rel="noreferrer" 
                           className="p-2.5 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-all backdrop-blur-xl border border-white/10 group/link">
                            <ExternalLink size={14} className="group-hover/link:scale-110 transition-transform"/>
                        </a>
                    </div>
                </div>

                {/* Scoreboard Area */}
                <div className="px-8 -mt-10 relative z-10 pb-6">
                    <div className="flex justify-between items-center mb-8">
                        <div className="text-center flex-1">
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">HOME</p>
                            <h3 className="text-4xl font-black text-white font-mono">{match.homeScore}</h3>
                        </div>
                        <div className="px-6 flex flex-col items-center">
                            <div className="w-px h-8 bg-white/10 mb-2"></div>
                            <span className="text-[10px] font-bold text-slate-600">VS</span>
                            <div className="w-px h-8 bg-white/10 mt-2"></div>
                        </div>
                        <div className="text-center flex-1">
                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">AWAY</p>
                            <h3 className="text-4xl font-black text-white font-mono">{match.awayScore}</h3>
                        </div>
                    </div>

                    <h4 className="text-sm font-bold text-white uppercase tracking-tight line-clamp-1 mb-6 text-center opacity-80 group-hover:opacity-100 transition-opacity">
                        {match.question}
                    </h4>

                    {/* Odds Grid with Trend Indicators */}
                    <div className={`grid gap-3 mb-8 ${match.outcomes.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                        {match.outcomes.map((outcome, idx) => {
                            const price = match.outcomePrices[idx];
                            const prevPrice = prevPrices[idx];
                            const trend = price > prevPrice ? 'up' : price < prevPrice ? 'down' : null;

                            return (
                                <div key={idx} className={`flex flex-col items-center p-4 rounded-3xl border transition-all duration-500 ${
                                    trend === 'up' ? 'bg-emerald-500/5 border-emerald-500/20' : 
                                    trend === 'down' ? 'bg-rose-500/5 border-rose-500/20' : 
                                    'bg-white/[0.02] border-white/[0.05]'
                                }`}>
                                    <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-2 truncate w-full text-center">
                                        {outcome}
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                        <span className={`text-lg font-mono font-black ${
                                            trend === 'up' ? 'text-emerald-400' : 
                                            trend === 'down' ? 'text-rose-400' : 
                                            'text-white'
                                        }`}>
                                            ${price.toFixed(2)}
                                        </span>
                                        {trend === 'up' && <ArrowRightLeft size={10} className="text-emerald-500 rotate-[-45deg]" />}
                                        {trend === 'down' && <ArrowRightLeft size={10} className="text-rose-500 rotate-[45deg]" />}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Edge/Intelligence Tape */}
                    <div className={`rounded-[1.5rem] p-4 flex items-center gap-4 transition-all duration-500 ${
                        isDivergent ? 'bg-rose-500/20 border border-rose-500/30' : 'bg-black/40 border border-white/5'
                    }`}>
                        <div className={`p-2 rounded-xl ${isDivergent ? 'bg-rose-500 text-white' : 'bg-slate-800 text-slate-400'}`}>
                            {isDivergent ? <Zap size={16} fill="currentColor"/> : <Radar size={16} />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-[10px] font-black uppercase tracking-widest ${isDivergent ? 'text-rose-400' : 'text-slate-500'}`}>
                                {isDivergent ? 'EDGE WINDOW ACTIVE' : 'MARKET PARITY'}
                            </p>
                            <p className="text-[9px] font-mono text-slate-400 truncate italic">
                                {match.priceEvidence || "System cross-verifying pitch streams..."}
                            </p>
                        </div>
                        {isDivergent && (
                            <div className="flex flex-col items-end">
                                <span className="text-[14px] font-mono font-black text-white">+{match.edgeWindow}s</span>
                                <span className="text-[7px] font-bold text-rose-500 uppercase">Latency Lead</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-8 pb-8">
                    <button className={`w-full py-4 font-black text-[11px] uppercase tracking-[0.3em] rounded-2xl transition-all flex items-center justify-center gap-3 active:scale-95 ${
                        isDivergent 
                        ? 'bg-gradient-to-r from-rose-600 to-rose-500 text-white shadow-xl shadow-rose-900/40' 
                        : 'bg-white hover:bg-slate-200 text-black shadow-xl shadow-black/20'
                    }`}>
                        <Sword size={16}/> {isDivergent ? 'EXECUTE SNIPE' : 'MANUAL POSITION'}
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

    const divergentCount = useMemo(() => sportsMatches.filter(m => m.correlation === 'DIVERGENT').length, [sportsMatches]);

    return (
        <div className="max-w-[1700px] mx-auto pb-20 px-4 md:px-10 animate-in fade-in duration-1000">
            {/* Tactical Header */}
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end gap-8 mb-16">
                <div className="space-y-4">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-rose-600 rounded-2xl shadow-lg shadow-rose-600/20">
                            <Radar className="text-white animate-spin-slow" size={28}/>
                        </div>
                        <h2 className="text-4xl font-black text-white uppercase tracking-tighter italic">
                            SportsRunner <span className="text-rose-600">PRO</span>
                        </h2>
                    </div>
                    <div className="flex gap-6 items-center">
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.5em]">
                            LATENCY ARBITRAGE ENGINE v5.2
                        </p>
                        <div className="h-px w-20 bg-white/10"></div>
                        <div className="flex items-center gap-2">
                            <Activity size={12} className="text-emerald-500" />
                            <span className="text-[9px] font-black text-emerald-500 uppercase">Feed: 140ms Latency</span>
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 bg-slate-900/50 p-2 rounded-[1.5rem] border border-white/5">
                    {(['LIVE', 'UPCOMING', 'ALL'] as const).map(f => (
                        <button 
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-8 py-3 rounded-2xl text-[10px] font-black transition-all tracking-widest ${
                                filter === f ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-white'
                            }`}>
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-12 gap-10">
                {/* Main Battle Map */}
                <div className="col-span-12 xl:col-span-9">
                    {filteredMatches.length === 0 ? (
                        <div className="glass-panel p-40 rounded-[3rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20">
                            <Loader2 className="animate-spin text-rose-500/20 mb-10" size={80}/>
                            <p className="text-slate-600 uppercase font-black tracking-[0.8em] text-xs">Scanning Pitch Momentum...</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            {filteredMatches.map(m => <MatchCard key={m.id} match={m} />)}
                        </div>
                    )}
                </div>

                {/* Tactical Sidebar: Alpha Feed */}
                <div className="col-span-12 xl:col-span-3">
                    <div className="glass-panel rounded-[2.5rem] border-white/5 sticky top-24 bg-black/40 overflow-hidden flex flex-col h-[750px] shadow-2xl">
                        <div className="px-8 py-8 border-b border-white/[0.03] flex justify-between items-center bg-white/[0.01]">
                            <div>
                                <h3 className="text-[11px] font-black text-white uppercase tracking-[0.4em] flex items-center gap-3">
                                    <Flame size={16} className="text-rose-500"/> Alpha Tape
                                </h3>
                                <p className="text-[8px] font-bold text-slate-500 mt-1 uppercase tracking-widest">Real-time Surge Logging</p>
                            </div>
                            {divergentCount > 0 && (
                                <div className="px-3 py-1 bg-rose-600 text-white text-[9px] font-black rounded-lg animate-pulse shadow-lg shadow-rose-600/30">
                                    {divergentCount} SIGNAL
                                </div>
                            )}
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                            {sportsMatches.filter(m => m.correlation === 'DIVERGENT').length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center opacity-20 text-center px-10">
                                    <Radar size={48} className="mb-6 animate-spin-slow text-slate-500" />
                                    <p className="text-[10px] font-black uppercase tracking-[0.3em] leading-relaxed">
                                        Watching global pitch feeds for score divergence...
                                    </p>
                                </div>
                            ) : (
                                sportsMatches.filter(m => m.correlation === 'DIVERGENT').map(m => (
                                    <div key={m.id} className="group p-6 bg-rose-500/[0.03] border border-rose-500/20 rounded-[2rem] hover:bg-rose-500/[0.06] transition-all animate-in slide-in-from-right duration-500">
                                        <div className="flex justify-between items-center mb-4">
                                            <span className="text-[10px] font-black text-rose-400 uppercase flex items-center gap-2">
                                                <Zap size={14} fill="currentColor"/> SURGE LOGGED
                                            </span>
                                            <span className="text-[9px] text-slate-600 font-mono">{(new Date()).toLocaleTimeString()}</span>
                                        </div>
                                        <p className="text-[11px] text-white font-bold leading-relaxed mb-4">{m.priceEvidence}</p>
                                        <div className="flex items-center justify-between border-t border-white/5 pt-4">
                                            <div className="flex items-center gap-2">
                                                <Timer size={12} className="text-slate-500" />
                                                <span className="text-[9px] font-bold text-slate-500 uppercase">EDGE: {m.edgeWindow}s</span>
                                            </div>
                                            <button className="text-[9px] font-black text-rose-500 uppercase hover:text-rose-400 transition-colors">
                                                AUTO-SNIPE
                                            </button>
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
