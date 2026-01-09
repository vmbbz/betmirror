
import React, { useState } from 'react';
import { 
  Activity, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, Clock, 
  ArrowRightLeft, Target, Loader2, Radar, Flame
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
    startTime?: string;
    volume?: string;
    liquidity?: string;
    minute: number;
    status: string;
    correlation: string;
    priceEvidence?: string;
}

const formatValue = (val: number, type: 'price' | 'decimal' | 'american') => {
    if (val <= 0) return '--';
    if (type === 'price') return `$${val.toFixed(2)}`;
    if (type === 'decimal') return (1 / val).toFixed(2);
    if (val >= 0.5) return `-${Math.round((val / (1 - val)) * 100)}`;
    return `+${Math.round(((1 - val) / val) * 100)}`;
};

const MatchCard = ({ match, displayType }: { match: SportsMatch, displayType: 'price' | 'decimal' | 'american' }) => {
    const isDivergent = match.correlation === 'DIVERGENT';
    const polyUrl = `https://polymarket.com/event/${match.eventSlug}/${match.slug}`;

    return (
        <div className={`glass-panel rounded-[2rem] border transition-all duration-500 overflow-hidden relative ${
            isDivergent ? 'border-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.2)]' : 'border-white/5'
        }`}>
            <div className="h-24 w-full relative overflow-hidden bg-slate-900">
                <img 
                    src={match.image} 
                    alt="match banner" 
                    className="w-full h-full object-cover opacity-40 blur-sm scale-105"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent"></div>
                <div className="absolute top-4 left-6 flex items-center gap-3">
                    <div className="relative">
                        <div className={`w-2 h-2 rounded-full ${isDivergent ? 'bg-rose-500' : 'bg-emerald-500'} animate-ping`}></div>
                        <div className={`w-2 h-2 rounded-full absolute top-0 ${isDivergent ? 'bg-rose-500' : 'bg-emerald-500'}`}></div>
                    </div>
                    <span className="text-[10px] font-black text-white uppercase tracking-widest">{match.minute}' | {match.status}</span>
                </div>
                <div className="absolute top-4 right-6">
                    <a href={polyUrl} target="_blank" rel="noreferrer" className="p-2 bg-white/10 rounded-xl hover:bg-white/20 text-white transition-all backdrop-blur-md border border-white/10">
                        <ExternalLink size={14}/>
                    </a>
                </div>
            </div>

            <div className="p-6">
                <div className="mb-6">
                    <h4 className="text-lg font-black text-white uppercase tracking-tight line-clamp-2">{match.question}</h4>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                    {match.outcomes.map((outcome, idx) => (
                        <div key={idx} className="flex flex-col items-center p-3 bg-black/40 rounded-2xl border border-white/[0.03] group hover:border-blue-500/30 transition-all">
                            <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1.5 truncate w-full text-center">{outcome}</span>
                            <span className="text-sm font-mono font-black text-white">
                                {formatValue(match.outcomePrices[idx], displayType)}
                            </span>
                        </div>
                    ))}
                </div>

                <div className={`border rounded-2xl p-3 flex items-center gap-3 transition-colors ${
                    isDivergent ? 'bg-rose-500/10 border-rose-500/30' : 'bg-black/60 border-white/5'
                }`}>
                    <Radar size={14} className={isDivergent ? 'text-rose-500' : 'text-emerald-500'} />
                    <span className={`text-[9px] font-mono font-bold uppercase truncate italic ${isDivergent ? 'text-rose-400' : 'text-gray-400'}`}>
                        {match.priceEvidence || "Awaiting pitch intelligence parity..."}
                    </span>
                </div>
            </div>

            <div className="px-6 py-4 bg-white/[0.02] border-t border-white/[0.03] flex items-center justify-between">
                <button className={`w-full py-3 font-black text-[9px] uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-2 ${
                    isDivergent ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/40' : 'bg-white text-black'
                }`}>
                    <Sword size={14}/> {isDivergent ? 'FRONT RUN EDGE' : 'SWEEP BOOK'}
                </button>
            </div>
        </div>
    );
};

const SportsRunner = ({ isRunning, sportsMatches = [] }: { isRunning: boolean, sportsMatches?: SportsMatch[] }) => {
    const [displayType, setDisplayType] = useState<'price' | 'decimal' | 'american'>('price');

    return (
        <div className="grid grid-cols-12 gap-8 max-w-[1600px] mx-auto pb-20 px-6">
            <div className="col-span-12 lg:col-span-9 space-y-10">
                <div className="flex justify-between items-end px-4">
                    <div>
                        <h2 className="text-3xl font-black text-white uppercase tracking-tight flex items-center gap-4 italic">
                            <Activity className="text-rose-500" size={32}/> Pitch Intelligence Terminal
                        </h2>
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.4em] mt-2">Institutional Latency Frontrunning Engine v5.0</p>
                    </div>
                    <div className="flex gap-4">
                        <button onClick={() => {
                            const cycle: ('price'|'decimal'|'american')[] = ['price', 'decimal', 'american'];
                            const next = cycle[(cycle.indexOf(displayType) + 1) % 3];
                            setDisplayType(next);
                        }}
                            className="px-6 py-2.5 bg-white/5 border border-white/10 rounded-2xl text-[9px] font-black text-white uppercase tracking-widest flex items-center gap-3 hover:bg-white/10">
                            <ArrowRightLeft size={16} className="text-blue-400"/> {displayType.toUpperCase()}
                        </button>
                    </div>
                </div>

                {sportsMatches.length === 0 ? (
                    <div className="glass-panel p-40 rounded-[3.5rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20">
                        <Loader2 className="animate-spin text-emerald-500/30 mb-8" size={64}/>
                        <p className="text-gray-600 uppercase font-black tracking-[0.6em] text-[11px]">Synchronizing Pitch Intelligence Feeds...</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {sportsMatches.map(m => <MatchCard key={m.id} match={m} displayType={displayType} />)}
                    </div>
                )}
            </div>

            <div className="col-span-12 lg:col-span-3">
                <div className="glass-panel rounded-[2.5rem] border-white/5 sticky top-24 bg-black/40 overflow-hidden flex flex-col h-[750px] shadow-2xl">
                    <div className="px-8 py-7 border-b border-white/[0.03] flex justify-between items-center bg-white/[0.01]">
                        <h3 className="text-[10px] font-black text-white uppercase tracking-[0.3em] flex items-center gap-2"><Target size={14} className="text-rose-500"/> Alpha Tape</h3>
                        <div className="px-2 py-0.5 bg-rose-500 text-white text-[7px] font-black rounded">LIVE</div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                        {sportsMatches.filter(m => m.correlation === 'DIVERGENT').length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center opacity-20 grayscale">
                                <Radar size={40} className="mb-4 animate-spin-slow" />
                                <p className="text-[9px] font-black uppercase">Scanning for Stale Quotes</p>
                            </div>
                        ) : (
                            sportsMatches.filter(m => m.correlation === 'DIVERGENT').map(m => (
                                <div key={m.id} className="p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl animate-in slide-in-from-right duration-500">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-[10px] font-black text-rose-400 uppercase flex items-center gap-1.5"><Flame size={12}/> Spike Logged</span>
                                        <span className="text-[8px] text-gray-600 font-mono">{new Date().toLocaleTimeString()}</span>
                                    </div>
                                    <p className="text-[10px] text-white font-bold leading-tight">{m.priceEvidence}</p>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SportsRunner;
