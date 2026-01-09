
import React, { useState, useEffect } from 'react';
import { 
  Trophy, Activity, Zap, Timer, Target, TrendingUp, 
  RefreshCw, Loader2, Globe, Cpu, Sword, Link, Activity as PulseIcon,
  ZapOff, Goal, BarChart3, ChevronRight, ExternalLink, ShieldAlert
} from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';

interface LiveMatch {
  id: string;
  conditionId: string;
  homeTeam: string;
  awayTeam: string;
  score: [number, number]; 
  inferredScore: [number, number]; 
  minute: number;
  marketPrice: number; 
  fairValue: number;   
  status: 'LIVE' | 'HT' | 'VAR' | 'GOAL' | 'FT' | 'SCOUTING';
  confidence: number;
  correlation: 'ALIGNED' | 'DIVERGENT' | 'UNVERIFIED';
  priceEvidence?: string;
}

const MatchCard = ({ match, userId, onChase }: { match: LiveMatch, userId: string, onChase: (m: LiveMatch) => void }) => {
    const delta = match.fairValue - (match.marketPrice || 0);
    const isAlphaWindow = delta >= 0.12 && match.marketPrice > 0; 
    const isDivergent = match.correlation === 'DIVERGENT';

    return (
        <div className={`glass-panel p-5 rounded-[1.5rem] border transition-all duration-500 relative overflow-hidden ${
            isDivergent ? 'border-rose-500 shadow-[0_0_30px_rgba(244,63,94,0.3)]' : 
            isAlphaWindow ? 'border-emerald-500/60 shadow-[0_0_20px_rgba(16,185,129,0.15)]' : 'border-white/5'
        }`}>
            {/* Header */}
            <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <span className={`w-1.5 h-1.5 rounded-full ${match.status === 'LIVE' ? 'bg-emerald-500 animate-ping' : 'bg-gray-600'}`}></span>
                        <span className={`w-1.5 h-1.5 rounded-full absolute top-0 ${match.status === 'LIVE' ? 'bg-emerald-500' : 'bg-gray-600'}`}></span>
                    </div>
                    <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{match.minute}' <span className="opacity-20 mx-1">|</span> {match.status}</span>
                </div>
                <div className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest ${
                    isAlphaWindow ? 'bg-emerald-500/20 text-emerald-400' : isDivergent ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/10 text-blue-400'
                }`}>
                    {isAlphaWindow ? 'ALPHA WINDOW OPEN' : isDivergent ? 'ALPHA DIVERGENCE' : match.correlation}
                </div>
            </div>

            {/* Score HUD - Dual Splitting */}
            <div className="grid grid-cols-3 items-center mb-6">
                <div className="text-left">
                    <span className="text-[12px] font-black text-white uppercase truncate block mb-0.5">{match.homeTeam}</span>
                    <span className="text-[7px] text-emerald-500 font-bold uppercase tracking-widest">VERIFIED: {match.score[0]}</span>
                </div>
                <div className="text-center">
                    <div className="text-3xl font-black text-white font-mono tracking-tighter">
                        {match.inferredScore[0]}<span className="opacity-20 mx-0.5">:</span>{match.inferredScore[1]}
                    </div>
                    <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest">INFERRED</div>
                </div>
                <div className="text-right">
                    <span className="text-[12px] font-black text-white uppercase truncate block mb-0.5">{match.awayTeam}</span>
                    <span className="text-[7px] text-emerald-500 font-bold uppercase tracking-widest">VERIFIED: {match.score[1]}</span>
                </div>
            </div>

            {/* Evidence Tape */}
            {match.priceEvidence && (
                <div className="mb-4 bg-black/60 border border-emerald-500/20 rounded-xl p-2.5 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                    <span className="text-[9px] font-mono font-bold text-emerald-400 uppercase tracking-tighter truncate italic">{match.priceEvidence}</span>
                </div>
            )}

            {/* Metrics */}
            <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="p-3 bg-black/40 rounded-2xl border border-white/[0.03]">
                    <div className="flex justify-between mb-1.5">
                        <p className="text-[7px] font-black text-gray-600 uppercase">Confidence</p>
                        <p className="text-[7px] font-black text-blue-500">{(match.confidence * 100).toFixed(0)}%</p>
                    </div>
                    <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 transition-all duration-1000" style={{ width: `${match.confidence * 100}%` }}></div>
                    </div>
                </div>
                <div className={`p-3 bg-black/40 rounded-2xl border transition-colors ${isAlphaWindow ? 'border-emerald-500/30' : 'border-white/[0.03]'}`}>
                    <p className={`text-[7px] font-black uppercase mb-1 ${isAlphaWindow ? 'text-emerald-500' : 'text-gray-600'}`}>Quant Fair Val</p>
                    <p className={`text-sm font-mono font-black tracking-tighter ${isAlphaWindow ? 'text-emerald-400' : 'text-white'}`}>${match.fairValue.toFixed(2)}</p>
                </div>
            </div>

            {/* Action */}
            <div className="flex items-center gap-3">
                 <div className="text-left px-1">
                    <span className="text-[7px] font-black text-gray-600 uppercase block mb-0.5">Alpha Edge</span>
                    <span className={`text-[13px] font-black font-mono leading-none ${delta >= 0.10 ? 'text-emerald-500' : 'text-white/40'}`}>
                        {match.marketPrice > 0 ? `+${(delta * 100).toFixed(1)}¢` : '--'}
                    </span>
                </div>
                <button 
                    onClick={() => onChase(match)}
                    className={`flex-1 py-3.5 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2 ${
                        isAlphaWindow 
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40' 
                        : isDivergent
                            ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/40'
                            : 'bg-white/[0.02] text-gray-600 border border-white/[0.05]'
                    }`}
                >
                    <Sword size={14} className={isAlphaWindow || isDivergent ? 'animate-bounce' : ''}/> 
                    {isAlphaWindow ? 'SWEEP STALE BOOK' : isDivergent ? 'FRONT RUN GOAL' : 'SCOUTING...'}
                </button>
            </div>
        </div>
    );
};

const SportsRunner = ({ userId, isRunning, sportsMatches = [] }: { userId: string, isRunning: boolean, sportsMatches?: any[] }) => {
    return (
        <div className="grid grid-cols-12 gap-6 animate-in fade-in duration-700 max-w-[1600px] mx-auto pb-10">
            <div className="col-span-12 lg:col-span-8 space-y-6">
                <div className="flex justify-between items-center px-2">
                    <h2 className="text-sm font-black text-white uppercase tracking-[0.4em] flex items-center gap-3">
                        <PulseIcon className="text-emerald-500" size={16}/> Institutional Pitch Intelligence
                    </h2>
                    <span className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-[9px] font-black text-emerald-500 uppercase tracking-widest animate-pulse">Live Alpha Capture</span>
                </div>

                {sportsMatches.length === 0 ? (
                    <div className="glass-panel p-24 rounded-[3rem] border-white/5 text-center flex flex-col items-center justify-center bg-white/[0.01]">
                        <Loader2 className="animate-spin text-blue-500/50 mb-4" size={48}/>
                        <p className="text-gray-600 uppercase font-black tracking-[0.5em] text-[11px]">Synchronizing Pitch Feeds...</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {sportsMatches.map(m => (
                            <MatchCard key={m.id} match={m} userId={userId} onChase={() => {}} />
                        ))}
                    </div>
                )}

                <div className="p-6 glass-panel rounded-[1.5rem] border-white/5 bg-gradient-to-br from-emerald-600/[0.04] to-transparent">
                    <div className="flex items-start gap-5">
                        <div className="p-3 bg-emerald-600/20 border border-emerald-600/20 rounded-2xl text-emerald-500"><Cpu size={24}/></div>
                        <div className="space-y-2">
                            <h3 className="text-[12px] font-black text-white uppercase tracking-widest italic">Engine: Inferred Velocity v3</h3>
                            <p className="text-gray-500 text-[10px] leading-relaxed tracking-tight">
                                This HUD operates in <span className="text-emerald-400 font-bold">Predictive Mode</span>. It treats orderbook velocity as a primary sensor for events, allowing for frontrunning of slow centralized score providers.
                                <br/><br/>
                                <span className="text-rose-400 font-bold">POWER-CURVE DECAY:</span> Win probabilities accelerate exponentially during the "Kill Zone" (70m+). Fair values are calculated using dynamic soccer modeling to identify mispriced outcome tokens.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="col-span-12 lg:col-span-4 flex flex-col">
                <div className="glass-panel rounded-[2rem] border-white/5 overflow-hidden flex flex-col flex-1 bg-black/40">
                    <div className="px-6 py-5 border-b border-white/[0.03] bg-white/[0.01] flex justify-between items-center">
                        <h3 className="text-[10px] font-black text-white uppercase tracking-[0.3em]">Institutional Evidence</h3>
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></div>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-[10px] custom-scrollbar">
                        {sportsMatches.filter(m => m.priceEvidence).length === 0 ? (
                             <div className="h-full flex items-center justify-center text-gray-700 opacity-20 uppercase tracking-[0.2em]">Awaiting Velocity...</div>
                        ) : (
                            sportsMatches.filter(m => m.priceEvidence).map(match => (
                                <div key={match.id} className="p-3 bg-white/[0.02] border border-white/[0.03] rounded-xl flex gap-3 leading-tight animate-in slide-in-from-right-4">
                                    <span className="text-gray-600 shrink-0">[{new Date().toLocaleTimeString()}]</span>
                                    <span className="text-emerald-400 font-bold">{match.priceEvidence}</span>
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
