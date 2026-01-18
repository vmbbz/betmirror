import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { 
    Activity, Zap, TrendingUp, Radar, Flame, 
    Target, Loader2, ShieldCheck, 
    Sword, Timer, X, Zap as ZapIcon, Info, ChevronRight, BarChart3, AlertTriangle, Cpu
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
}

// --- Sub-Component: Velocity Heat Bar ---
const SignalHeatBar = ({ value }: { value: number }) => {
    // Scaled for visual impact: 3% move = ~30% bar width
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

    return (
        <div className={`relative group animate-in fade-in zoom-in-95 duration-500`}>
            {isHighConfidence && (
                <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-600 to-purple-600 rounded-[2rem] blur opacity-20 animate-pulse"></div>
            )}
            <div className="relative glass-panel bg-white dark:bg-slate-900/80 border-gray-200 dark:border-white/5 rounded-[2rem] p-5 overflow-hidden transition-all hover:border-blue-500/50">
                <div className="flex items-start justify-between gap-4 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-lg ${
                            move.velocity > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                        }`}>
                            <ZapIcon size={24} fill="currentColor" className={Math.abs(move.velocity) > 0.05 ? 'animate-bounce' : ''} />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${
                                    move.velocity > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                                }`}>
                                    {move.strategy || 'Momentum'} Trace
                                </span>
                                {move.riskScore < 30 && <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest bg-blue-500/10 px-2 py-0.5 rounded-full">Low Risk</span>}
                            </div>
                            <h4 className="text-xs font-black text-gray-900 dark:text-white leading-tight line-clamp-1 uppercase tracking-tighter">{move.question || 'New Network Pulse'}</h4>
                        </div>
                    </div>
                    <div className="text-right shrink-0">
                        <div className={`text-lg font-black font-mono leading-none ${move.velocity > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {move.velocity > 0 ? '+' : ''}{velocityPct}%
                        </div>
                        <div className="text-[8px] text-gray-500 font-bold uppercase tracking-tighter mt-1">{timeAgo}s Ago</div>
                    </div>
                </div>

                <div className="space-y-4">
                    <SignalHeatBar value={move.velocity} />
                    <div className="grid grid-cols-3 gap-2">
                        <div className="bg-gray-50 dark:bg-black/40 p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
                            <div className="text-[7px] text-gray-500 uppercase font-black mb-1">Base</div>
                            <div className="text-[11px] font-mono font-black text-gray-400">${move.oldPrice.toFixed(2)}</div>
                        </div>
                        <div className="bg-gray-50 dark:bg-black/40 p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
                            <div className="text-[7px] text-gray-500 uppercase font-black mb-1">Spike</div>
                            <div className="text-[11px] font-mono font-black text-gray-900 dark:text-white">${move.newPrice.toFixed(2)}</div>
                        </div>
                        <div className="bg-gray-50 dark:bg-black/40 p-2.5 rounded-xl border border-gray-100 dark:border-white/5">
                            <div className="text-[7px] text-gray-500 uppercase font-black mb-1">Conf</div>
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
                // Combine persistent signal history
                setSignals(res.data.flashMoves || []);
                // Filter specifically for trades originating from the FOMO engine
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
        <div className="max-w-7xl mx-auto space-y-10 pb-20 animate-in fade-in duration-700">
            {/* TACTICAL COMMAND HEADER */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8 px-4 md:px-0">
                <div className="flex items-center gap-5">
                    <div className="w-16 h-16 bg-gradient-to-br from-rose-600 to-orange-500 rounded-3xl flex items-center justify-center text-white shadow-xl shadow-rose-900/20">
                        <Radar size={36} className="animate-spin-slow" />
                    </div>
                    <div>
                        <h2 className="text-3xl font-black text-gray-900 dark:text-white uppercase tracking-tighter italic leading-none">Fomo Runner HUD</h2>
                        <div className="flex items-center gap-3 mt-2">
                            <span className="flex h-2 w-2 rounded-full bg-rose-500 animate-ping"></span>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.3em]">
                                High Frequency Momentum Pulse • Autonomous v3
                            </p>
                        </div>
                    </div>
                </div>
                <div className="flex gap-4 w-full md:w-auto">
                    <div className="flex-1 md:flex-none glass-panel px-8 py-3 rounded-2xl border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-900/40">
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Network Heat</div>
                        <div className={`text-xl font-black font-mono tracking-tighter ${heatColor}`}>
                            {globalHeat}
                        </div>
                    </div>
                    <div className="flex-1 md:flex-none glass-panel px-8 py-3 rounded-2xl border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-900/40">
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Engine Latency</div>
                        <div className="text-xl font-black text-gray-900 dark:text-white font-mono tracking-tighter">0.24<span className="text-xs text-gray-500 ml-1">MS</span></div>
                    </div>
                </div>
            </div>

            {/* LIVE COMBAT SEQUENCES (ACTIVE POSITIONS) */}
            <section className="space-y-4 px-4 md:px-0">
                <div className="flex items-center justify-between">
                    <h3 className="text-[11px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-[0.4em] flex items-center gap-3">
                        <Sword size={16} className="text-rose-500" /> Active Combat Sequences ({activeChases.length})
                    </h3>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {activeChases.map((chase, idx) => {
                        const pnl = (chase.currentPrice - chase.entryPrice) * chase.shares;
                        const isProfit = pnl >= 0;
                        return (
                            <div key={idx} className="glass-panel p-6 rounded-[2.5rem] border-rose-500/30 bg-rose-500/5 relative overflow-hidden group transition-all hover:bg-rose-500/10">
                                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform"><Flame size={140} className="text-rose-500"/></div>
                                <div className="relative z-10 space-y-5">
                                    <div className="flex justify-between items-start">
                                        <h4 className="text-sm font-black text-gray-900 dark:text-white uppercase leading-tight line-clamp-1 tracking-tight pr-4">{chase.question}</h4>
                                        <div className="px-2 py-1 rounded-lg bg-black/40 border border-white/10 text-[9px] font-mono font-bold text-gray-400">{chase.outcome}</div>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <div>
                                            <p className="text-[8px] font-black text-gray-500 uppercase mb-1">Trace PnL</p>
                                            <p className={`text-2xl font-black font-mono leading-none ${isProfit ? 'text-emerald-500' : 'text-rose-500'}`}>
                                                {isProfit ? '+' : ''}{pnl.toFixed(2)} <span className="text-[10px] opacity-40">USDC</span>
                                            </p>
                                        </div>
                                        <button 
                                            onClick={() => handleAbort(chase.marketId)}
                                            className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-2xl text-[9px] uppercase tracking-[0.2em] shadow-lg shadow-rose-900/40 transition-all active:scale-95"
                                        >
                                            Abort Chase
                                        </button>
                                    </div>
                                    <div className="h-1 w-full bg-gray-200 dark:bg-white/5 rounded-full overflow-hidden">
                                        <div className="h-full bg-rose-500 animate-pulse" style={{ width: '85%' }} />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {activeChases.length === 0 && (
                        <div className="col-span-full py-16 text-center border-2 border-dashed border-gray-200 dark:border-white/5 rounded-[2.5rem] flex flex-col items-center gap-4 opacity-30 grayscale hover:opacity-100 transition-opacity">
                            <Target size={36} className="text-gray-400" />
                            <p className="text-[10px] font-black uppercase tracking-[0.3em]">No Active Combat Signals In Sector</p>
                        </div>
                    )}
                </div>
            </section>

            {/* RADAR FEED & TACTICAL LOGIC */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 px-4 md:px-0">
                <div className="lg:col-span-8 space-y-6">
                    <div className="flex items-center gap-4 mb-2">
                        <h3 className="text-[11px] font-black text-gray-500 dark:text-slate-400 uppercase tracking-[0.4em] flex items-center gap-3">
                            <ZapIcon size={16} className="text-amber-500" /> Momentum Radar Feed
                        </h3>
                        <div className="h-px flex-1 bg-gray-200 dark:bg-white/5"></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {signals.map((sig, i) => <TacticalSignalCard key={sig.tokenId + i} move={sig} />)}
                        {signals.length === 0 && (
                            <div className="col-span-full py-32 flex flex-col items-center gap-6">
                                <Radar size={64} className="animate-spin-slow opacity-10 text-blue-500" />
                                <p className="text-[11px] font-black text-gray-400 uppercase tracking-[0.4em] opacity-40">Scanning Global CLOB For Price Flashes...</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* SIDEBAR TACTICAL ADVISORY */}
                <div className="lg:col-span-4 space-y-8">
                    <div className="glass-panel p-8 rounded-[2.5rem] border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-900/40">
                        <h4 className="text-[10px] font-black text-gray-900 dark:text-slate-400 uppercase tracking-[0.3em] mb-8 flex items-center gap-3">
                            <ShieldCheck size={16} className="text-blue-500"/> Tactical constraints
                        </h4>
                        <div className="space-y-4">
                            {[
                                { label: 'Min Velocity', val: '3%', desc: 'Price delta within 60s window' },
                                { label: 'Conf. Floor', val: '75%', desc: 'HFT signal certainty requirement' },
                                { label: 'Safety Cut-off', val: '$500', desc: 'Max single chase vault exposure' }
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

                    <div className="glass-panel p-8 rounded-[2.5rem] border-rose-500/20 bg-rose-500/[0.02]">
                        <h4 className="text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mb-4 flex items-center gap-3">
                            <Info size={16}/> HFT Radar Advisory
                        </h4>
                        <p className="text-xs text-gray-600 dark:text-slate-400 leading-relaxed font-medium uppercase tracking-tight">
                            Fomo Runner engages high-velocity spikes. Explosive moves often imply <span className="text-gray-900 dark:text-white font-black">thin liquidity</span>. Always verify your <span className="text-blue-600 dark:text-blue-400 font-black">Max Trade Size</span> settings in the vault to avoid slippage traps on 1-cent spikes.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FlashMoveDashboard;
