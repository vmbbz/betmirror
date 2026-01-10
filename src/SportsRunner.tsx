
import React, { useState, useMemo } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  ArrowRightLeft, Target, Loader2, Radar, Flame, Info
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
    status: 'LIVE' | 'UPCOMING' | 'RESOLVED';
    correlation: 'ALIGNED' | 'DIVERGENT';
    priceEvidence?: string;
}

type OddsFormat = 'price' | 'decimal' | 'american';

const formatOdds = (val: number, format: OddsFormat) => {
    if (val <= 0) return '--';
    if (format === 'price') return `$${val.toFixed(2)}`;
    if (format === 'decimal') return (1 / val).toFixed(2);
    // American Odds calculation
    if (val >= 0.5) return `-${Math.round((val / (1 - val)) * 100)}`;
    return `+${Math.round(((1 - val) / val) * 100)}`;
};

const MatchCard = ({ match, oddsFormat }: { match: SportsMatch, oddsFormat: OddsFormat }) => {
    const isDivergent = match.correlation === 'DIVERGENT';
    const polyUrl = `https://polymarket.com/event/${match.eventSlug}/${match.slug}`;

    return (
        <div className={`glass-panel rounded-[2rem] border transition-all duration-500 overflow-hidden relative group ${
            isDivergent ? 'border-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.15)]' : 'border-white/5'
        }`}>
            {/* Rich Header Banner */}
            <div className="h-28 w-full relative overflow-hidden bg-slate-950">
                <img 
                    src={match.image} 
                    alt="banner" 
                    className="w-full h-full object-cover opacity-30 blur-[2px] scale-105 group-hover:scale-110 transition-transform duration-700"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-[#050505]/40 to-transparent"></div>
                
                {/* Mobile-Responsive Status Badge */}
                <div className="absolute top-4 left-5 flex items-center gap-2.5">
                    <div className="relative flex items-center justify-center">
                        <div className={`w-2 h-2 rounded-full ${isDivergent ? 'bg-rose-500' : 'bg-emerald-500'} animate-ping opacity-75`}></div>
                        <div className={`w-2 h-2 rounded-full absolute ${isDivergent ? 'bg-rose-500' : 'bg-emerald-500'}`}></div>
                    </div>
                    <span className="text-[10px] font-black text-white uppercase tracking-[0.2em] drop-shadow-md">
                        {match.status === 'LIVE' ? `${match.minute}' LIVE` : 'UPCOMING'}
                    </span>
                </div>

                <div className="absolute top-4 right-5">
                    <a href={polyUrl} target="_blank" rel="noreferrer" 
                       className="p-2 bg-white/5 hover:bg-white/10 rounded-xl text-white transition-all backdrop-blur-md border border-white/10">
                        <ExternalLink size={14}/>
                    </a>
                </div>
            </div>

            <div className="p-6 -mt-4 relative z-10">
                <h4 className="text-base font-black text-white uppercase tracking-tight line-clamp-2 mb-6 min-h-[3rem]">
                    {match.question}
                </h4>

                {/* Dynamic Outcome Grid (Handles 2 or 3 options) */}
                <div className={`grid gap-3 mb-6 ${match.outcomes.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    {match.outcomes.map((outcome, idx) => (
                        <div key={idx} className="flex flex-col items-center p-3 bg-white/[0.02] rounded-2xl border border-white/[0.03] group/item hover:border-blue-500/40 transition-all">
                            <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mb-1.5 truncate w-full text-center">
                                {outcome}
                            </span>
                            <span className="text-sm font-mono font-black text-white group-hover/item:text-blue-400 transition-colors">
                                {formatOdds(match.outcomePrices[idx], oddsFormat)}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Inferred Intelligence Evidence */}
                <div className={`rounded-2xl p-3 flex items-center gap-3 transition-all ${
                    isDivergent ? 'bg-rose-500/10 border border-rose-500/20' : 'bg-black/40 border border-white/5'
                }`}>
                    {isDivergent ? <Flame size={14} className="text-rose-500 animate-pulse" /> : <Radar size={14} className="text-emerald-500" />}
                    <span className={`text-[9px] font-mono font-bold uppercase truncate italic flex-1 ${isDivergent ? 'text-rose-400' : 'text-gray-500'}`}>
                        {match.priceEvidence || "Parity confirmed by pitch feeds..."}
                    </span>
                </div>
            </div>

            <div className="px-6 pb-6 pt-2">
                <button className={`w-full py-3.5 font-black text-[10px] uppercase tracking-[0.2em] rounded-2xl transition-all flex items-center justify-center gap-2.5 ${
                    isDivergent 
                    ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/20' 
                    : 'bg-white hover:bg-gray-200 text-black shadow-lg shadow-black/40'
                }`}>
                    <Sword size={14}/> {isDivergent ? 'FRONT RUN EDGE' : 'OPEN ORDER TICKET'}
                </button>
            </div>
        </div>
    );
};

const SportsRunner = ({ sportsMatches = [] }: { sportsMatches?: SportsMatch[] }) => {
    const [oddsFormat, setOddsFormat] = useState<OddsFormat>('price');
    const [filter, setFilter] = useState<'ALL' | 'LIVE' | 'UPCOMING'>('LIVE');

    const filteredMatches = useMemo(() => {
        if (filter === 'ALL') return sportsMatches;
        return sportsMatches.filter(m => m.status === filter);
    }, [sportsMatches, filter]);

    return (
        <div className="max-w-[1600px] mx-auto pb-20 px-4 md:px-8 animate-in fade-in duration-700">
            {/* Header / Controls */}
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end gap-6 mb-12 px-2">
                <div>
                    <h2 className="text-3xl md:text-4xl font-black text-white uppercase tracking-tighter flex items-center gap-4 italic">
                        <Activity className="text-rose-500" size={32}/> Pitch Intel Terminal
                    </h2>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.4em] mt-3">
                        Institutional Latency Arbitrage Engine v5.2
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-4 w-full lg:w-auto">
                    {/* Status Filter */}
                    <div className="flex bg-white/5 p-1 rounded-2xl border border-white/10">
                        {(['LIVE', 'UPCOMING', 'ALL'] as const).map(f => (
                            <button 
                                key={f}
                                onClick={() => setFilter(f)}
                                className={`px-4 py-2 rounded-xl text-[9px] font-black transition-all ${
                                    filter === f ? 'bg-white text-black' : 'text-gray-400 hover:text-white'
                                }`}>
                                {f}
                            </button>
                        ))}
                    </div>

                    {/* Odds Format Toggle */}
                    <button onClick={() => {
                        const cycle: OddsFormat[] = ['price', 'decimal', 'american'];
                        setOddsFormat(cycle[(cycle.indexOf(oddsFormat) + 1) % 3]);
                    }}
                        className="px-5 py-2.5 bg-white/5 border border-white/10 rounded-2xl text-[9px] font-black text-white uppercase tracking-widest flex items-center gap-3 hover:bg-white/10 ml-auto lg:ml-0">
                        <ArrowRightLeft size={14} className="text-blue-400"/> {oddsFormat.toUpperCase()}
                    </button>
                </div>
            </div>

            {/* Main Grid */}
            <div className="grid grid-cols-12 gap-8">
                <div className="col-span-12 xl:col-span-9">
                    {filteredMatches.length === 0 ? (
                        <div className="glass-panel p-32 rounded-[3rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20">
                            <Loader2 className="animate-spin text-blue-500/20 mb-8" size={64}/>
                            <p className="text-gray-600 uppercase font-black tracking-[0.5em] text-[10px]">Awaiting Market Parity...</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {filteredMatches.map(m => <MatchCard key={m.id} match={m} oddsFormat={oddsFormat} />)}
                        </div>
                    )}
                </div>

                {/* Sidebar: Alpha Tape */}
                <div className="col-span-12 xl:col-span-3">
                    <div className="glass-panel rounded-[2.5rem] border-white/5 sticky top-24 bg-black/40 overflow-hidden flex flex-col h-[700px] shadow-2xl">
                        <div className="px-8 py-7 border-b border-white/[0.03] flex justify-between items-center bg-white/[0.01]">
                            <h3 className="text-[10px] font-black text-white uppercase tracking-[0.3em] flex items-center gap-2">
                                <Target size={14} className="text-rose-500"/> Intelligence Tape
                            </h3>
                            <div className="px-2 py-0.5 bg-rose-500 text-white text-[7px] font-black rounded animate-pulse">LIVE</div>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                            {sportsMatches.filter(m => m.correlation === 'DIVERGENT').length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center opacity-20">
                                    <Radar size={40} className="mb-4 animate-spin-slow text-gray-500" />
                                    <p className="text-[9px] font-black uppercase tracking-widest">Scanning Pitch Velocity</p>
                                </div>
                            ) : (
                                sportsMatches.filter(m => m.correlation === 'DIVERGENT').map(m => (
                                    <div key={m.id} className="p-5 bg-rose-500/[0.03] border border-rose-500/20 rounded-[1.5rem] animate-in slide-in-from-right duration-500">
                                        <div className="flex justify-between items-center mb-3">
                                            <span className="text-[9px] font-black text-rose-400 uppercase flex items-center gap-1.5"><Flame size={12}/> Surge Logged</span>
                                            <span className="text-[8px] text-gray-600 font-mono">{(new Date()).toLocaleTimeString()}</span>
                                        </div>
                                        <p className="text-[10px] text-white font-bold leading-relaxed">{m.priceEvidence}</p>
                                        <div className="mt-3 flex items-center gap-2 text-[8px] font-bold text-gray-500 uppercase">
                                            <Info size={10} /> Edge Window: ~15.4s
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
