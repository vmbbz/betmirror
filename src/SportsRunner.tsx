
import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  Target, Loader2, Radar, Flame,
  TrendingDown, Timer, BarChart3, ChevronRight,
  Globe, Trophy, ImageIcon
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
    const [isBookOpen, setIsBookOpen] = useState(false);
    const [selectedTokenIdx, setSelectedTokenIdx] = useState<number | null>(null);
    const isDivergent = match.correlation === 'DIVERGENT';
    const polyUrl = `https://polymarket.com/event/${match.eventSlug}/${match.slug}`;
    const [prevPrices, setPrevPrices] = useState<number[]>(match.outcomePrices);

    useEffect(() => {
        const timer = setTimeout(() => setPrevPrices(match.outcomePrices), 2500);
        return () => clearTimeout(timer);
    }, [match.outcomePrices]);

    const handleSelectOutcome = (idx: number) => {
        setSelectedTokenIdx(idx === selectedTokenIdx ? null : idx);
        setIsBookOpen(idx !== selectedTokenIdx);
    };

    return (
        <div className={`relative transition-all duration-500 w-full mx-auto ${isDivergent ? 'scale-[1.01] z-10' : ''}`}>
            {isDivergent && (
                <div className="absolute -inset-1 bg-gradient-to-r from-rose-600 via-orange-500 to-rose-600 rounded-[1.5rem] blur opacity-40 animate-pulse"></div>
            )}

            <div className={`glass-panel rounded-[1.5rem] border transition-all duration-500 overflow-hidden relative flex flex-col h-full ${
                isDivergent ? 'border-rose-500/50 bg-slate-900/95 shadow-2xl' : 'border-white/5 bg-slate-950/60'
            }`}>
                {/* Visual Header - High Quality Image */}
                <div className="h-28 w-full relative overflow-hidden shrink-0">
                    {match.image ? (
                        <img 
                            src={match.image} 
                            alt={match.question} 
                            className="w-full h-full object-cover transition-transform duration-700 hover:scale-110" 
                        />
                    ) : (
                        <div className="w-full h-full bg-slate-800 flex items-center justify-center">
                            <ImageIcon size={32} className="text-slate-700" />
                        </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent"></div>
                    
                    <div className="absolute top-3 left-4 flex items-center gap-2">
                        {match.status === 'LIVE' && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full border border-white/20">
                                <div className={`w-1.5 h-1.5 rounded-full ${isDivergent ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`}></div>
                                <span className="text-[10px] font-black text-white uppercase tracking-widest">
                                    {match.minute}' LIVE
                                </span>
                            </div>
                        )}
                    </div>

                    <div className="absolute top-3 right-4">
                        <a 
                            href={polyUrl} 
                            target="_blank" 
                            rel="noreferrer" 
                            className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-all shadow-lg flex items-center gap-1.5"
                        >
                            <span className="text-[9px] font-black uppercase tracking-tighter">Market</span>
                            <ExternalLink size={12} />
                        </a>
                    </div>
                </div>

                <div className="px-5 -mt-6 relative z-10 flex-1 flex flex-col pb-5">
                    {/* Scoreboard */}
                    <div className="flex justify-between items-center mb-5 bg-black/40 backdrop-blur-md rounded-2xl p-3 border border-white/5">
                        <div className="text-center flex-1">
                            <h3 className="text-3xl font-black text-white font-mono leading-none tracking-tighter">{match.homeScore}</h3>
                            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">HOME</p>
                        </div>
                        <div className="px-4">
                            <div className="text-[10px] font-black italic text-slate-700 bg-white/5 rounded px-2">VS</div>
                        </div>
                        <div className="text-center flex-1">
                            <h3 className="text-3xl font-black text-white font-mono leading-none tracking-tighter">{match.awayScore}</h3>
                            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">AWAY</p>
                        </div>
                    </div>

                    <h4 className="text-[11px] font-bold text-slate-100 uppercase tracking-tight line-clamp-2 mb-5 text-center min-h-[32px] leading-tight">
                        {match.question}
                    </h4>

                    {/* Outcome Grid */}
                    <div className="grid grid-cols-3 gap-2 mb-5">
                        {match.outcomes.slice(0, 3).map((outcome, idx) => {
                            const price = match.outcomePrices[idx] || 0.5;
                            const prev = prevPrices[idx] || price;
                            const trend = price > prev ? 'up' : price < prev ? 'down' : null;
                            const isSelected = selectedTokenIdx === idx;

                            return (
                                <button 
                                    key={idx} 
                                    onClick={() => handleSelectOutcome(idx)}
                                    className={`flex flex-col items-center py-3 px-1 rounded-xl border transition-all ${
                                        isSelected 
                                        ? 'bg-blue-600 border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.3)]' 
                                        : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08] hover:border-white/20'
                                    }`}
                                >
                                    <span className={`text-[8px] font-black uppercase tracking-tighter mb-1.5 truncate w-full text-center ${isSelected ? 'text-blue-100' : 'text-slate-400'}`}>
                                        {outcome}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <span className={`text-sm font-mono font-black ${isSelected ? 'text-white' : trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-rose-400' : 'text-white'}`}>
                                            ${price.toFixed(2)}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Alpha Badge */}
                    <div className={`mt-auto rounded-xl p-3 flex items-center gap-3 transition-all ${
                        isDivergent ? 'bg-rose-500/20 border border-rose-500/30' : 'bg-black/30 border border-white/5'
                    }`}>
                        <div className={`p-2 rounded-lg ${isDivergent ? 'bg-rose-500 text-white animate-pulse shadow-lg' : 'bg-slate-800 text-slate-500'}`}>
                            {isDivergent ? <Flame size={14} /> : <Radar size={14} />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-[8px] font-black uppercase tracking-widest ${isDivergent ? 'text-rose-400' : 'text-slate-500'}`}>
                                {isDivergent ? 'ALPHA EDGE SIGNAL' : 'MARKET MONITOR'}
                            </p>
                            <p className={`text-[9px] font-mono truncate italic leading-none mt-1 ${isDivergent ? 'text-rose-100' : 'text-slate-400'}`}>
                                {match.priceEvidence || "Awaiting score divergence..."}
                            </p>
                        </div>
                    </div>
                </div>

                <div className="px-5 pb-5">
                    <button className={`w-full py-3 font-black text-[10px] uppercase tracking-[0.2em] rounded-xl transition-all flex items-center justify-center gap-2 ${
                        isDivergent 
                        ? 'bg-gradient-to-r from-rose-600 to-orange-600 text-white shadow-xl shadow-rose-900/40 hover:scale-[1.02]' 
                        : 'bg-white hover:bg-slate-200 text-black'
                    }`}>
                        <Sword size={14}/> {isDivergent ? 'EXECUTE SNIPE' : 'OPEN ORDER TICKET'}
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
        <div className="w-full max-w-7xl mx-auto pb-20 px-4 md:px-8 animate-in fade-in duration-1000">
            {/* Hero Section */}
            <div className="flex flex-col md:flex-row justify-between items-center gap-6 mb-12 text-center md:text-left">
                <div className="w-full md:w-auto">
                    <div className="flex items-center justify-center md:justify-start gap-3 mb-1">
                        <Activity className="text-rose-500" size={32}/>
                        <h2 className="text-2xl md:text-4xl font-black text-white uppercase tracking-tighter italic">
                            SportsRunner
                        </h2>
                    </div>
                    <p className="text-[10px] md:text-xs text-slate-500 font-bold uppercase tracking-[0.4em] ml-1">
                        Real-Time Pitch Inference Engine
                    </p>
                </div>

                <div className="flex bg-slate-900/80 p-1.5 rounded-2xl border border-white/10 backdrop-blur-2xl shadow-2xl">
                    {(['LIVE', 'UPCOMING', 'ALL'] as const).map(f => (
                        <button 
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-6 md:px-10 py-3 rounded-xl text-[10px] font-black transition-all uppercase tracking-widest ${
                                filter === f ? 'bg-white text-black shadow-xl scale-105' : 'text-slate-400 hover:text-white'
                            }`}>
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-12 gap-8 lg:gap-12">
                {/* Main Match Container */}
                <div className="col-span-12 xl:col-span-9 order-2 xl:order-1">
                    {filteredMatches.length === 0 ? (
                        <div className="glass-panel p-16 md:p-32 rounded-[2rem] border-white/10 text-center flex flex-col items-center justify-center bg-black/40 min-h-[400px] shadow-2xl">
                            <Loader2 className="animate-spin text-rose-500/40 mb-6" size={48}/>
                            <p className="text-slate-500 uppercase font-black tracking-[0.6em] text-[10px] md:text-xs">Scanning Pitch Momentum...</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
                            {filteredMatches.map(m => <MatchCard key={m.id} match={m} />)}
                        </div>
                    )}
                </div>

                {/* Intelligence Tape Sidebar */}
                <div className="col-span-12 xl:col-span-3 order-1 xl:order-2">
                    <div className="glass-panel rounded-[2rem] border-white/10 xl:sticky xl:top-24 bg-black/60 overflow-hidden flex flex-col h-auto md:h-[500px] xl:h-[750px] shadow-2xl">
                        <div className="px-6 py-6 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                            <h3 className="text-[10px] font-black text-white uppercase tracking-[0.4em] flex items-center gap-3">
                                <Target size={16} className="text-rose-500"/> Intel Feed
                            </h3>
                            {divergentCount > 0 && (
                                <div className="px-2.5 py-1 bg-rose-600 text-white text-[8px] font-black rounded-lg animate-pulse shadow-lg shadow-rose-900/50">
                                    {divergentCount} SIGNAL
                                </div>
                            )}
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-5 space-y-4">
                            {sportsMatches.filter(m => m.correlation === 'DIVERGENT').length === 0 ? (
                                <div className="py-12 xl:h-full flex flex-col items-center justify-center opacity-20 text-center px-6">
                                    <Radar size={48} className="mb-4 text-slate-500" />
                                    <p className="text-[10px] font-black uppercase tracking-widest leading-relaxed">Monitoring Global Score Data...</p>
                                </div>
                            ) : (
                                sportsMatches.filter(m => m.correlation === 'DIVERGENT').map(m => (
                                    <div key={m.id} className="p-4 bg-rose-500/[0.08] border border-rose-500/30 rounded-2xl animate-in slide-in-from-right duration-500 shadow-lg group">
                                        <div className="flex justify-between items-center mb-3">
                                            <span className="text-[9px] font-black text-rose-400 uppercase flex items-center gap-2"><Zap size={12} fill="currentColor"/> Inferred Goal</span>
                                            <span className="text-[8px] text-slate-500 font-mono">{(new Date()).toLocaleTimeString()}</span>
                                        </div>
                                        <p className="text-[11px] text-white font-bold leading-tight mb-3 group-hover:text-rose-200 transition-colors">{m.priceEvidence}</p>
                                        <div className="flex items-center gap-2 pt-3 border-t border-white/10">
                                            <Timer size={12} className="text-slate-500" />
                                            <span className="text-[9px] font-bold text-slate-400 uppercase">Latency Edge: {m.edgeWindow}s</span>
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
