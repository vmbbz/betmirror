
import React, { useState } from 'react';
import { 
  Activity, Cpu, Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, BarChart3, Clock, 
  Target, AlertTriangle, Globe2, ChevronRight, Loader2, ArrowRightLeft
} from 'lucide-react';

interface SportsMatch {
    id: string;
    homeTeam: string;
    awayTeam: string;
    marketSlug: string;
    eventSlug: string;
    score: [number, number];
    inferredScore: [number, number];
    minute: number;
    status: string;
    correlation: string;
    image: string;
    triad: {
        homePrice: number;
        drawPrice: number;
        awayPrice: number;
    };
    priceEvidence?: string;
}

const convertOdds = (price: number, type: 'decimal' | 'american' | 'percent') => {
    if (price <= 0) return '--';
    if (type === 'percent') return `${(price * 100).toFixed(0)}%`;
    if (type === 'decimal') return (1 / price).toFixed(2);
    
    // American Odds
    if (price >= 0.5) {
        return `-${Math.round((price / (1 - price)) * 100)}`;
    } else {
        return `+${Math.round(((1 - price) / price) * 100)}`;
    }
};

const OddsCell = ({ label, price, color, oddsType }: { label: string, price: number, color: string, oddsType: any }) => (
    <div className="flex flex-col items-center p-3 bg-black/40 rounded-xl border border-white/[0.03] hover:bg-white/[0.02] transition-colors">
        <span className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">{label}</span>
        <span className={`text-sm font-mono font-black ${color}`}>
            {price > 0 ? convertOdds(price, oddsType) : '--'}
        </span>
        <span className="text-[7px] text-gray-600 font-bold">{convertOdds(price, 'percent')} Implied</span>
    </div>
);

const MatchCard = ({ match, oddsType }: { match: SportsMatch, oddsType: any }) => {
    const isDivergent = match.correlation === 'DIVERGENT';
    const polyUrl = `https://polymarket.com/event/${match.eventSlug}/${match.marketSlug}`;

    return (
        <div className={`glass-panel rounded-[2rem] border transition-all duration-700 overflow-hidden relative ${
            isDivergent ? 'border-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.25)]' : 'border-white/5'
        }`}>
            {/* HUD Header */}
            <div className="px-6 py-4 border-b border-white/[0.03] bg-white/[0.01] flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <span className={`w-2 h-2 rounded-full ${isDivergent ? 'bg-rose-500' : 'bg-emerald-500'} animate-ping`}></span>
                        <span className={`w-2 h-2 rounded-full absolute top-0 ${isDivergent ? 'bg-rose-500' : 'bg-emerald-500'}`}></span>
                    </div>
                    <span className="text-[10px] font-black text-white uppercase tracking-widest">{match.minute}' <span className="opacity-20 mx-1">|</span> {match.status}</span>
                </div>
                <div className="flex gap-2">
                    <a href={polyUrl} target="_blank" rel="noreferrer" className="p-2 bg-white/5 rounded-xl hover:bg-white/10 transition-colors text-gray-400 group">
                        <ExternalLink size={14} className="group-hover:text-blue-400 transition-colors"/>
                    </a>
                </div>
            </div>

            {/* Main HUD Body */}
            <div className="p-6">
                <div className="grid grid-cols-3 items-center mb-8">
                    <div className="text-left space-y-1">
                        <h4 className="text-[13px] font-black text-white uppercase truncate tracking-tight">{match.homeTeam}</h4>
                        <p className="text-[8px] text-emerald-500 font-black tracking-widest uppercase">OFFICIAL: {match.score[0]}</p>
                    </div>
                    
                    <div className="text-center relative">
                        <div className={`text-4xl font-black font-mono tracking-tighter transition-all duration-500 ${isDivergent ? 'text-rose-500 scale-110 drop-shadow-[0_0_10px_rgba(244,63,94,0.5)]' : 'text-white'}`}>
                            {match.inferredScore[0]}<span className="opacity-20 mx-1">:</span>{match.inferredScore[1]}
                        </div>
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-[0.4em] mt-1.5">INFERRED</div>
                        
                        {isDivergent && (
                            <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap bg-rose-500 text-white text-[7px] font-black px-2.5 py-0.5 rounded-full animate-bounce uppercase tracking-tighter">
                                Pulse Spike Detected
                            </div>
                        )}
                    </div>

                    <div className="text-right space-y-1">
                        <h4 className="text-[13px] font-black text-white uppercase truncate tracking-tight">{match.awayTeam}</h4>
                        <p className="text-[8px] text-emerald-500 font-black tracking-widest uppercase">OFFICIAL: {match.score[1]}</p>
                    </div>
                </div>

                {/* Market Triad Grid */}
                <div className="grid grid-cols-3 gap-3 mb-6">
                    <OddsCell label="Home Win" price={match.triad.homePrice} color="text-white" oddsType={oddsType} />
                    <OddsCell label="Draw" price={match.triad.drawPrice} color="text-blue-400" oddsType={oddsType} />
                    <OddsCell label="Away Win" price={match.triad.awayPrice} color="text-white" oddsType={oddsType} />
                </div>

                {/* Evidence Velocity Tape */}
                <div className={`border rounded-2xl p-3.5 flex items-center gap-3.5 transition-colors duration-500 ${
                    isDivergent ? 'bg-rose-500/10 border-rose-500/30' : 'bg-black/60 border-white/5'
                }`}>
                    <Zap size={14} className={isDivergent ? 'text-rose-500 animate-pulse' : 'text-emerald-500'} />
                    <span className={`text-[9px] font-mono font-bold uppercase tracking-tighter truncate italic ${isDivergent ? 'text-rose-400' : 'text-gray-400'}`}>
                        {match.priceEvidence || "Scanning orderbook velocity correlation..."}
                    </span>
                </div>
            </div>

            {/* HUD Action Footer */}
            <div className="p-4 bg-white/[0.02] border-t border-white/[0.03] flex items-center justify-between">
                 <div className="text-left px-1">
                    <span className="text-[7px] font-black text-gray-600 uppercase block">Alpha Expansion</span>
                    <span className={`text-xs font-black font-mono leading-none ${isDivergent ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {isDivergent ? 'HIGH' : 'STABLE'}
                    </span>
                </div>
                <button className={`px-6 py-3 font-black text-[9px] uppercase tracking-[0.2em] rounded-xl transition-all flex items-center gap-2 ${
                    isDivergent 
                    ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/40 scale-[1.02]' 
                    : 'bg-white text-black hover:bg-gray-200'
                }`}>
                    <Sword size={14} className={isDivergent ? 'animate-bounce' : ''}/> {isDivergent ? 'FRONT RUN SPIKE' : 'SWEEP STALE BOOK'}
                </button>
            </div>
        </div>
    );
};

const SportsRunner = ({ isRunning, sportsMatches = [] }: { isRunning: boolean, sportsMatches?: SportsMatch[] }) => {
    const [oddsType, setOddsType] = useState<'decimal' | 'american'>('decimal');

    return (
        <div className="grid grid-cols-12 gap-8 animate-in fade-in duration-700 max-w-[1600px] mx-auto pb-20 px-4">
            {/* Primary Terminal View */}
            <div className="col-span-12 lg:col-span-9 space-y-8">
                <div className="flex justify-between items-end px-2">
                    <div>
                        <h2 className="text-2xl font-black text-white uppercase tracking-tight flex items-center gap-4 italic">
                            <Activity className="text-rose-500" size={28}/> Pitch Intelligence Terminal
                        </h2>
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.4em] mt-2">
                            Cross-Correlated <span className="text-emerald-500">Market Triad</span> Monitoring System v4.0
                        </p>
                    </div>
                    <div className="flex gap-4">
                        <button 
                            onClick={() => setOddsType(prev => prev === 'decimal' ? 'american' : 'decimal')}
                            className="px-5 py-2.5 bg-white/5 border border-white/10 rounded-2xl text-[9px] font-black text-white uppercase tracking-widest flex items-center gap-2 hover:bg-white/10 transition-colors"
                        >
                            <ArrowRightLeft size={14} className="text-blue-400"/>
                            Display: {oddsType.toUpperCase()}
                        </button>
                        <div className="px-5 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-[9px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                            Triad Engine: ONLINE
                        </div>
                    </div>
                </div>

                {sportsMatches.length === 0 ? (
                    <div className="glass-panel p-40 rounded-[3.5rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20">
                        <Loader2 className="animate-spin text-emerald-500/30 mb-8" size={64}/>
                        <p className="text-gray-600 uppercase font-black tracking-[0.6em] text-[11px]">Synchronizing Multi-Sided Feeds...</p>
                        <p className="text-gray-700 text-[9px] mt-4 max-w-xs mx-auto">Waiting for active markets to populate Triad Correlation Data</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        {sportsMatches.map(m => (
                            <MatchCard key={m.id} match={m} oddsType={oddsType} />
                        ))}
                    </div>
                )}
            </div>

            {/* Sidebar Tape */}
            <div className="col-span-12 lg:col-span-3">
                <div className="glass-panel rounded-[2.5rem] border-white/5 sticky top-24 bg-black/40 overflow-hidden flex flex-col h-[750px] shadow-2xl">
                    <div className="px-7 py-6 border-b border-white/[0.03] flex justify-between items-center bg-white/[0.01]">
                        <h3 className="text-[10px] font-black text-white uppercase tracking-[0.3em]">Intelligence Tape</h3>
                        <div className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-5 space-y-3 font-mono text-[9px] custom-scrollbar">
                        {sportsMatches.length > 0 ? sportsMatches.map(m => (
                            m.priceEvidence && (
                                <div key={m.id} className="p-4 bg-white/[0.02] border border-white/[0.03] rounded-2xl flex flex-col gap-2 animate-in slide-in-from-right-4 hover:bg-white/[0.04] transition-colors">
                                    <div className="flex justify-between items-center text-gray-500">
                                        <span className="font-black text-white uppercase">{m.homeTeam.slice(0,10)}...</span>
                                        <span className="opacity-50">{new Date().toLocaleTimeString()}</span>
                                    </div>
                                    <span className="text-emerald-400 font-bold uppercase leading-tight">{m.priceEvidence}</span>
                                </div>
                            )
                        )) : (
                            <div className="h-full flex items-center justify-center text-gray-700 uppercase tracking-widest text-[8px] italic">Awaiting Evidence Surge...</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SportsRunner;
