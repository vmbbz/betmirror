import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  ArrowRightLeft, Target, Loader2, Radar, Flame, Info,
  TrendingDown, Timer, BarChart3, ChevronDown, ChevronUp
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
    const [selectedToken, setSelectedToken] = useState<number | null>(null);
    const isDivergent = match.correlation === 'DIVERGENT';
    const polyUrl = `https://polymarket.com/event/${match.eventSlug}/${match.slug}`;
    const [prevPrices, setPrevPrices] = useState<number[]>(match.outcomePrices);

    useEffect(() => {
        const timer = setTimeout(() => setPrevPrices(match.outcomePrices), 2500);
        return () => clearTimeout(timer);
    }, [match.outcomePrices]);

    const handleSelectOutcome = (idx: number) => {
        setSelectedToken(idx);
        setIsBookOpen(true);
    };

    return (
        <div className={`relative transition-all duration-500 w-full max-w-[420px] mx-auto ${isDivergent ? 'scale-[1.02] z-10' : ''}`}>
            {isDivergent && (
                <div className="absolute -inset-0.5 bg-gradient-to-r from-rose-500 to-orange-500 rounded-[2rem] blur opacity-30 animate-pulse"></div>
            )}

            <div className={`glass-panel rounded-[1.8rem] border transition-all duration-500 overflow-hidden relative flex flex-col h-full ${
                isDivergent ? 'border-rose-500/50 bg-slate-900/95 shadow-2xl shadow-rose-900/20' : 'border-white/5 bg-slate-950/60'
            }`}>
                {/* Header Image Area */}
                <div className="h-24 w-full relative overflow-hidden shrink-0">
                    <img src={match.image} alt="bg" className="w-full h-full object-cover opacity-10 grayscale brightness-50" />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent"></div>
                    
                    <div className="absolute top-4 left-5 flex items-center gap-2">
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full border border-white/10">
                            <div className={`w-1.5 h-1.5 rounded-full ${isDivergent ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`}></div>
                            <span className="text-[10px] font-black text-white uppercase tracking-wider">
                                {match.minute}' LIVE
                            </span>
                        </div>
                    </div>

                    <div className="absolute top-4 right-5">
                        <a href={polyUrl} target="_blank" rel="noreferrer" className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg transition-all">
                            <ExternalLink size={12} className="text-slate-400" />
                        </a>
                    </div>
                </div>

                <div className="px-6 -mt-6 relative z-10 flex-1 flex flex-col pb-5">
                    {/* Scoreboard */}
                    <div className="flex justify-between items-center mb-5 px-2">
                        <div className="text-center">
                            <h3 className="text-3xl font-black text-white font-mono leading-none">{match.homeScore}</h3>
                            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">HOME</p>
                        </div>
                        <div className="flex flex-col items-center opacity-20">
                            <span className="text-[9px] font-black italic">VS</span>
                        </div>
                        <div className="text-center">
                            <h3 className="text-3xl font-black text-white font-mono leading-none">{match.awayScore}</h3>
                            <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest mt-1">AWAY</p>
                        </div>
                    </div>

                    <h4 className="text-[11px] font-bold text-slate-300 uppercase tracking-tight line-clamp-1 mb-5 text-center">
                        {match.question}
                    </h4>

                    {/* Outcome Grid - Responsive 3-Way */}
                    <div className="grid grid-cols-3 gap-2 mb-5">
                        {match.outcomes.map((outcome, idx) => {
                            const price = match.outcomePrices[idx] || 0.5;
                            const prev = prevPrices[idx] || price;
                            const trend = price > prev ? 'up' : price < prev ? 'down' : null;
                            const isSelected = selectedToken === idx;

                            return (
                                <button 
                                    key={idx} 
                                    onClick={() => handleSelectOutcome(idx)}
                                    className={`flex flex-col items-center py-3 px-1 rounded-xl border transition-all group ${
                                        isSelected 
                                        ? 'bg-blue-600/30 border-blue-500' 
                                        : 'bg-white/[0.03] border-white/5 hover:bg-white/[0.06]'
                                    }`}
                                >
                                    <span className="text-[8px] font-black text-slate-500 uppercase tracking-tighter mb-1.5 truncate w-full text-center group-hover:text-slate-300 transition-colors">
                                        {outcome}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <span className={`text-sm font-mono font-black ${trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-rose-400' : 'text-white'}`}>
                                            ${price.toFixed(2)}
                                        </span>
                                        {trend && (
                                            trend === 'up' ? <TrendingUp size={10} className="text-emerald-500" /> : <TrendingDown size={10} className="text-rose-500" />
                                        )}
                                    </div>
                                    <span className="text-[8px] text-slate-600 mt-0.5 font-bold">{(1/price).toFixed(1)}x</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Order Book Section - Only shown when interaction occurs */}
                    {isBookOpen && selectedToken !== null && (
                        <div className="mb-5 bg-black/40 rounded-xl border border-white/5 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-300">
                            <div className="px-3 py-2 bg-white/5 flex justify-between items-center">
                                <span className="text-[9px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
                                    <BarChart3 size={10}/> Order Book: {match.outcomes[selectedToken]}
                                </span>
                                <button onClick={() => setIsBookOpen(false)} className="text-[9px] text-slate-500 hover:text-white">CLOSE</button>
                            </div>
                            <div className="p-3 grid grid-cols-2 gap-4">
                                <div>
                                    <p className="text-[8px] font-bold text-slate-500 mb-1">BEST BIDS</p>
                                    <div className="text-[10px] font-mono text-emerald-400 font-bold">${match.outcomePrices[selectedToken].toFixed(2)}</div>
                                </div>
                                <div className="text-right">
                                    <p className="text-[8px] font-bold text-slate-500 mb-1">BEST ASKS</p>
                                    <div className="text-[10px] font-mono text-rose-400 font-bold">${(match.outcomePrices[selectedToken] + 0.01).toFixed(2)}</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Alpha Badge */}
                    <div className={`mt-auto rounded-xl p-3 flex items-center gap-3 transition-all ${
                        isDivergent ? 'bg-rose-500/10 border border-rose-500/20' : 'bg-black/20 border border-white/5'
                    }`}>
                        <div className={`p-1.5 rounded-lg ${isDivergent ? 'bg-rose-500 text-white animate-pulse' : 'bg-slate-800 text-slate-500'}`}>
                            {isDivergent ? <Flame size={14} /> : <Radar size={14} />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-[8px] font-black uppercase tracking-widest ${isDivergent ? 'text-rose-400' : 'text-slate-500'}`}>
                                {isDivergent ? 'ALPHA EDGE' : 'MARKET SCAN'}
                            </p>
                            <p className="text-[8px] font-mono text-slate-400 truncate italic leading-none">
                                {match.priceEvidence || "Scanning global book velocity..."}
                            </p>
                        </div>
                        {isDivergent && (
                            <div className="text-right shrink-0">
                                <span className="text-[10px] font-mono font-black text-white">+{match.edgeWindow}s</span>
                                <p className="text-[6px] font-bold text-rose-500 uppercase leading-none">LEAD</p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-6 pb-5 shrink-0">
                    <button className={`w-full py-3 font-black text-[9px] uppercase tracking-[0.2em] rounded-xl transition-all flex items-center justify-center gap-2 ${
                        isDivergent 
                        ? 'bg-gradient-to-r from-rose-600 to-orange-600 text-white shadow-lg' 
                        : 'bg-white hover:bg-slate-200 text-black'
                    }`}>
                        <Sword size={14}/> {isDivergent ? 'EXECUTE SNIPE' : 'PLACE ORDER'}
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
        <div className="max-w-[1600px] mx-auto pb-20 px-4 md:px-8 animate-in fade-in duration-1000">
            {/* Filter Navigation Bar */}
            <div className="flex flex-col md:flex-row justify-between items-center gap-6 mb-12">
                <div className="text-center md:text-left">
                    <h2 className="text-3xl font-black text-white uppercase tracking-tighter flex items-center justify-center md:justify-start gap-3 italic">
                        <Activity className="text-rose-500" size={32}/> Pitch Intel
                    </h2>
                    <p className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.3em] mt-1">
                        Latency Arbitrage v5.2
                    </p>
                </div>

                <div className="flex bg-slate-900/60 p-1.5 rounded-xl border border-white/5 backdrop-blur-xl">
                    {(['LIVE', 'UPCOMING', 'ALL'] as const).map(f => (
                        <button 
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-6 py-2.5 rounded-lg text-[9px] font-black transition-all uppercase tracking-widest ${
                                filter === f ? 'bg-white text-black shadow-lg' : 'text-slate-400 hover:text-white'
                            }`}>
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-12 gap-8">
                {/* Main Content Area */}
                <div className="col-span-12 xl:col-span-9">
                    {filteredMatches.length === 0 ? (
                        <div className="glass-panel p-20 rounded-[2rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20 min-h-[400px]">
                            <Loader2 className="animate-spin text-rose-500/20 mb-6" size={48}/>
                            <p className="text-slate-600 uppercase font-black tracking-[0.6em] text-[10px]">Scanning active matches...</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {filteredMatches.map(m => <MatchCard key={m.id} match={m} />)}
                        </div>
                    )}
                </div>

                {/* Intelligence Tape Sidebar */}
                <div className="col-span-12 xl:col-span-3">
                    <div className="glass-panel rounded-[1.8rem] border-white/5 sticky top-24 bg-black/40 overflow-hidden flex flex-col h-[650px] shadow-2xl">
                        <div className="px-6 py-6 border-b border-white/[0.03] flex justify-between items-center bg-white/[0.01]">
                            <h3 className="text-[9px] font-black text-white uppercase tracking-[0.3em] flex items-center gap-2">
                                <Target size={14} className="text-rose-500"/> Intelligence Tape
                            </h3>
                            {divergentCount > 0 && (
                                <div className="px-2 py-0.5 bg-rose-600 text-white text-[7px] font-black rounded animate-pulse">
                                    {divergentCount} SIGNAL
                                </div>
                            )}
                        </div>
                        
                        <div className="flex-1 overflow-y-auto p-5 space-y-3">
                            {sportsMatches.filter(m => m.correlation === 'DIVERGENT').length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center opacity-10 text-center px-6">
                                    <Radar size={40} className="mb-4 text-slate-500" />
                                    <p className="text-[9px] font-black uppercase tracking-widest leading-relaxed">Awaiting divergence...</p>
                                </div>
                            ) : (
                                sportsMatches.filter(m => m.correlation === 'DIVERGENT').map(m => (
                                    <div key={m.id} className="p-4 bg-rose-500/[0.05] border border-rose-500/20 rounded-2xl animate-in slide-in-from-right duration-500">
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-[9px] font-black text-rose-400 uppercase flex items-center gap-2"><Zap size={12} fill="currentColor"/> Snipe Alert</span>
                                            <span className="text-[8px] text-slate-600 font-mono">{(new Date()).toLocaleTimeString()}</span>
                                        </div>
                                        <p className="text-[10px] text-white font-bold leading-tight mb-3">{m.priceEvidence}</p>
                                        <div className="flex items-center gap-2 pt-3 border-t border-white/5">
                                            <Timer size={10} className="text-slate-500" />
                                            <span className="text-[8px] font-bold text-slate-500 uppercase">Edge: {m.edgeWindow}s Lead</span>
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