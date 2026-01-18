import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { 
    Activity, Zap, TrendingUp, Radar, Flame, 
    Target, Loader2, ShieldCheck, 
    Sword, Timer, X, Zap as ZapIcon, Info, ChevronRight, BarChart3, AlertTriangle, Cpu, Trophy
} from 'lucide-react';
import { toast } from 'react-toastify';

interface FlashMoveData {
    tokenId: string;
    conditionId: string;
    oldPrice: number;
    newPrice: number;
    velocity: number;
    confidence: number;
    timestamp: number;
    question?: string;
    image?: string;
    strategy: string;
    riskScore: number;
    // New telemetry
    liveScore?: string;
    matchMinute?: number;
}

// --- Sub-Component: Velocity Heat Bar ---
const SignalHeatBar = ({ value }: { value: number }) => {
    const intensity = Math.min(Math.abs(value * 1000), 100); 
    return (
        <div className="w-full h-1.5 bg-gray-200 dark:bg-white/5 rounded-full overflow-hidden">
            <div 
                className={`h-full transition-all duration-1000 ${intensity > 40 ? 'bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.8)]' : 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]'}`}
                style={{ width: `${intensity}%` }}
            />
        </div>
    );
};

// --- Sub-Component: Tactical Signal Trace Card ---
const TacticalSignalCard = ({ move }: { move: FlashMoveData }) => {
    const velocityPct = (move.velocity * 100).toFixed(1);
    const timeAgo = Math.max(0, Math.floor((Date.now() - move.timestamp) / 1000));
    const isHighConfidence = move.confidence > 0.75;
    const isSports = move.strategy === 'sports-frontrun';
    const isGlitching = Math.abs(move.velocity) > 0.1;

    return (
        <div className={`relative group animate-in fade-in zoom-in-95 duration-500 ${isGlitching ? 'animate-pulse' : ''}`}>
            {isHighConfidence && (
                <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-600 to-purple-600 rounded-[2rem] blur opacity-20 animate-pulse"></div>
            )}
            <div className={`relative glass-panel bg-white dark:bg-slate-900/80 border-gray-200 dark:border-white/5 rounded-[2rem] p-5 overflow-hidden transition-all hover:border-blue-500/50 ${isSports ? 'border-amber-500/30' : ''} ${isGlitching ? 'ring-2 ring-rose-500/50' : ''}`}>
                <div className="flex items-start justify-between gap-4 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-lg ${
                            move.velocity > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                        }`}>
                            {isSports ? <Trophy size={24} className="animate-bounce" /> : <ZapIcon size={24} fill="currentColor" className={Math.abs(move.velocity) > 0.05 ? 'animate-bounce' : ''} />}
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${
                                    isSports ? 'bg-amber-500/10 text-amber-500' : (move.strategy || 'Momentum') + ' Trace'
                                }`}>
                                    {isSports ? (move.matchMinute ? `${move.matchMinute}' In-Play` : 'Live Nexus') : (move.strategy || 'Momentum') + ' Trace'}
                                </span>
                                {move.riskScore < 30 && <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest bg-blue-500/10 px-2 py-0.5 rounded-full">Low Risk</span>}
                            </div>
                            <h4 className="text-xs font-black text-gray-900 dark:text-white leading-tight line-clamp-1 uppercase tracking-tighter">{move.question || 'New Network Pulse'}</h4>
                        </div>
                    </div>
                    <div className="text-right shrink-0">
                        <div className={`text-lg font-black font-mono leading-none ${move.velocity > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {isSports ? 'SNIPE' : `${move.velocity > 0 ? '+' : ''}${velocityPct}%`}
                        </div>
                        <div className="text-[8px] text-gray-500 font-bold uppercase tracking-tighter mt-1">{timeAgo}s Ago</div>
                    </div>
                </div>

                <div className="space-y-4">
                    {isSports && move.liveScore && (
                        <div className="flex justify-center py-2 bg-black/40 rounded-xl border border-white/5 font-mono font-black text-lg text-amber-500 tracking-widest">
                            {move.liveScore}
                        </div>
                    )}
                    <SignalHeatBar value={move.velocity} />
                    <div className="grid grid-cols-3 gap-2">
                        <div className="bg-gray-50 dark:bg-black/40 p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
                            <div className="text-[7px] text-gray-500 uppercase font-black mb-1">Price</div>
                            <div className="text-[11px] font-mono font-black text-gray-900 dark:text-white">${move.newPrice.toFixed(2)}</div>
                        </div>
                        <div className="bg-gray-50 dark:bg-black/40 p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
                            <div className="text-[7px] text-gray-500 uppercase font-black mb-1">Window</div>
                            <div className="text-[11px] font-mono font-black text-gray-400">500MS</div>
                        </div>
                        <div className="bg-gray-50 dark:bg-black/40 p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
                            <div className="text-[7px] text-gray-500 uppercase font-black mb-1">Signal</div>
                            <div className={`text-[11px] font-mono font-black ${isHighConfidence ? 'text-blue-500' : 'text-gray-500'}`}>
                                {(move.confidence * 100).toFixed(0)}%
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const FlashMoveDashboard = () => {
    const [signals, setSignals] = useState<FlashMoveData[]>([]);
    const [activeChases, setActiveChases] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [userId] = useState(() => localStorage.getItem('userAddress') || '');

    useEffect(() => {
        const socket = io();

        const fetchData = async () => {
            if (!userId) return;
            try {
                const res = await axios.get(`/api/bot/status/${userId}`);
                setSignals(res.data.flashMoves || []);
                const chases = (res.data.positions || []).filter((p: any) => p.serviceOrigin === 'FOMO');
                setActiveChases(chases);
            } catch (e) {
                console.error(e);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
        const poll = setInterval(fetchData, 10000);

        socket.on('flash_move_detected', (data) => {
            if (data.event) {
                setSignals(prev => {
                    const exists = prev.some(s => s.tokenId === data.event.tokenId && s.timestamp === data.event.timestamp);
                    if (exists) return prev;
                    return [data.event, ...prev].slice(0, 20);
                });
                
                if (data.event.confidence > 0.8) {
                    toast.info(`🔥 High Velocity Spike: ${data.event.question?.slice(0, 30)}...`, {
                        icon: <ZapIcon size={16} className="text-amber-500" />
                    });
                }
            }
        });

        // Listen for live score glitch updates
        socket.on('sports_score_update', (data) => {
             setSignals(prev => prev.map(s => {
                 if (s.tokenId === data.tokenId) {
                     return { ...s, liveScore: `${data.score[0]}-${data.score[1]}`, matchMinute: data.matchMinute };
                 }
                 return s;
             }));
        });

        return () => {
            clearInterval(poll);
            socket.disconnect();
        };
    }, [userId]);

    const handleAbort = async (marketId: string) => {
        try {
            await axios.post('/api/trade/exit', { userId, marketId, outcome: 'YES' });
            toast.success("Abort Sequence Initiated. Market Order Dispatched.");
        } catch (e) {
            toast.error("Abort sequence failed.");
        }
    };

    if (loading) return (
        <div className="flex flex-col items-center justify-center py-40 gap-4">
            <Loader2 className="animate-spin text-blue-500 shadow-blue-500/20" size={40} />
            <p className="text-[10px] font-black uppercase tracking-[0.4em] text-gray-500 animate-pulse">Syncing Tactical Grid...</p>
        </div>
    );

    const globalHeat = signals.length > 8 ? 'CRITICAL' : signals.length > 3 ? 'HIGH' : 'STABLE';
    const heatColor = globalHeat === 'CRITICAL' ? 'text-rose-500' : globalHeat === 'HIGH' ? 'text-amber-500' : 'text-blue-500';

    return (
        <div className="max-w-7xl mx-auto space-y-10 pb-20 px-4 md:px-0 animate-in fade-in duration-700">
            {/* TACTICAL COMMAND HEADER */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8">
                <div className="flex items-center gap-5">
                    <div className="w-16 h-16 bg-gradient-to-br from-rose-600 to-orange-500 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-rose-900/20">
                        <Radar size={36} className="animate-spin-slow" />
                    </div>
                    <div>
                        <h2 className="text-3xl font-black text-gray-900 dark:text-white uppercase tracking-tighter italic leading-none">Fomo Runner HUD</h2>
                        <div className="flex items-center gap-3 mt-2">
                            <span className="flex h-2 w-2 rounded-full bg-rose-500 animate-ping"></span>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.3em]">
                                500MS Micro-Tick Pulse • Sports Live-Feed Sniper
                            </p>
                        </div>
                    </div>
                </div>
                <div className="flex gap-4 w-full md:w-auto">
                    <div className="flex-1 md:flex-none glass-panel px-8 py-3 rounded-2xl border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-900/40">
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Radar Sensitivity</div>
                        <div className={`text-xl font-black font-mono tracking-tighter ${heatColor}`}>
                            0.50<span className="text-xs ml-1 text-gray-500">HZ</span>
                        </div>
                    </div>
                    <div className="flex-1 md:flex-none glass-panel px-8 py-3 rounded-2xl border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-900/40">
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Network Latency</div>
                        <div className="text-xl font-black text-gray-900 dark:text-white font-mono tracking-tighter">0.12<span className="text-xs text-gray-500 ml-1">MS</span></div>
                    </div>
                </div>
            </div>

            {/* COMBAT ZONE: SPORTS SNIPER (Priority UI) */}
            <section className="space-y-4">
                <div className="flex items-center justify-between border-b border-amber-500/20 pb-3">
                    <h3 className="text-[11px] font-black text-amber-500 uppercase tracking-[0.4em] flex items-center gap-3">
                        <Trophy size={16} /> Combat Zone: Sports Live-Feed
                    </h3>
                    <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest animate-pulse">Monitoring 240+ Active Events</span>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {signals.filter(s => s.strategy === 'sports-frontrun' || s.strategy === 'sports-nexus').map((sig, i) => (
                        <TacticalSignalCard key={sig.tokenId + i} move={sig} />
                    ))}
                    {signals.filter(s => s.strategy === 'sports-frontrun' || s.strategy === 'sports-nexus').length === 0 && (
                        <div className="col-span-full py-12 text-center bg-amber-500/[0.02] border border-dashed border-amber-500/20 rounded-[2.5rem] flex flex-col items-center gap-3 opacity-40">
                            <Trophy size={24} className="text-amber-500/50" />
                            <p className="text-[10px] font-black uppercase tracking-widest">Scanning Sports WebSocket for Live Score Triggers...</p>
                        </div>
                    )}
                </div>
            </section>

            {/* RADAR FEED & GLOBAL PULSE */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
                <div className="lg:col-span-8 space-y-6">
                    <div className="flex items-center gap-4 mb-2">
                        <h3 className="text-[11px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-[0.4em] flex items-center gap-3">
                            <ZapIcon size={16} className="text-rose-500" /> Global Momentum Feed
                        </h3>
                        <div className="h-px flex-1 bg-gray-200 dark:bg-white/5"></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {signals.filter(s => s.strategy !== 'sports-frontrun' && s.strategy !== 'sports-nexus').map((sig, i) => <TacticalSignalCard key={sig.tokenId + i} move={sig} />)}
                    </div>
                </div>

                {/* SIDEBAR TACTICAL ADVISORY */}
                <div className="lg:col-span-4 space-y-8">
                    {/* ACTIVE COMBAT SEQUENCES */}
                    <div className="glass-panel p-8 rounded-[2.5rem] border-rose-500/30 bg-rose-500/5">
                        <h4 className="text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mb-6 flex items-center gap-3">
                            <Sword size={16} /> Active Engagements ({activeChases.length})
                        </h4>
                        <div className="space-y-4">
                            {activeChases.map((chase, i) => (
                                <div key={i} className="bg-black/40 rounded-2xl p-4 border border-white/5 space-y-3">
                                    <div className="flex justify-between items-start">
                                        <p className="text-[10px] font-black text-white uppercase line-clamp-1">{chase.question}</p>
                                        <button onClick={() => handleAbort(chase.marketId)} className="text-rose-500 hover:text-rose-400"><X size={14}/></button>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <div>
                                            <p className="text-[8px] text-gray-500 uppercase mb-1">Unrealized PnL</p>
                                            <p className={`text-sm font-mono font-black ${chase.unrealizedPnL >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                                {chase.unrealizedPnL >= 0 ? '+' : ''}${chase.unrealizedPnL?.toFixed(2)}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-[8px] text-gray-500 uppercase mb-1">Exposure</p>
                                            <p className="text-sm font-mono font-black text-white">${chase.valueUsd?.toFixed(2)}</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {activeChases.length === 0 && <p className="text-center py-10 text-[9px] font-bold text-gray-600 uppercase tracking-widest">Sector Clear. No Active Snipes.</p>}
                        </div>
                    </div>

                    <div className="glass-panel p-8 rounded-[2.5rem] border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-900/40">
                        <h4 className="text-[10px] font-black text-gray-900 dark:text-slate-400 uppercase tracking-[0.3em] mb-8 flex items-center gap-3">
                            <ShieldCheck size={16} className="text-blue-500"/> Tactical constraints
                        </h4>
                        <div className="space-y-4">
                            {[
                                { label: 'Min Delta', val: '3% / 60s', desc: 'Velocity requirement for global signals' },
                                { label: 'HFT Window', val: '500 MS', desc: 'Analysis tick for micro-velocity engine' },
                                { label: 'Order Type', val: 'FAK', desc: 'Fill-And-Kill priority for rapid execution' }
                            ].map((item, i) => (
                                <div key={i} className="p-4 bg-white dark:bg-white/5 rounded-3xl border border-gray-100 dark:border-white/10 group hover:border-blue-500/30 transition-all">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-[10px] font-black text-gray-900 dark:text-white uppercase tracking-wider">{item.label}</span>
                                        <span className="text-xs font-mono font-black text-blue-600 dark:text-blue-400">{item.val}</span>
                                    </div>
                                    <p className="text-[9px] text-gray-500 dark:text-slate-600 font-bold uppercase tracking-tight">{item.desc}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FlashMoveDashboard;
