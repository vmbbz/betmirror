import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { 
    Activity, Zap, TrendingUp, Radar, Flame, 
    Target, Loader2, ShieldAlert, Cpu, 
    ArrowRight, History, BarChart3, Info, 
    Sword, AlertCircle, Timer, ShieldCheck, X
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
}

// FIX: New visual intensity component for price velocity
const SignalHeatBar = ({ value }: { value: number }) => {
    const intensity = Math.min(Math.abs(value * 1000), 100); // Scaled for visual impact
    return (
        <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
            <div 
                className={`h-full transition-all duration-1000 ${intensity > 30 ? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.8)]' : 'bg-orange-400'}`}
                style={{ width: `${intensity}%` }}
            />
        </div>
    );
};

// FIX: Redesigned Signal Card with tactical metadata
const TacticalSignalCard = ({ move }: { move: FlashMoveData }) => {
    const velocityPct = (move.velocity * 100).toFixed(1);
    const timeAgo = Math.floor((Date.now() - move.timestamp) / 1000);

    return (
        <div className="relative group animate-in fade-in zoom-in-95 duration-500">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-rose-600 to-amber-500 rounded-2xl blur opacity-10 group-hover:opacity-30 transition-opacity"></div>
            <div className="relative glass-panel bg-slate-900/80 border-white/5 rounded-2xl p-4 overflow-hidden">
                <div className="flex items-start justify-between gap-4 mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-500">
                            <Zap size={20} fill="currentColor" className="animate-pulse" />
                        </div>
                        <div className="min-w-0">
                            <div className="text-[10px] font-black text-rose-400 uppercase tracking-widest leading-none mb-1">Incoming Spike</div>
                            <h4 className="text-sm font-bold text-white leading-tight line-clamp-1">{move.question || 'New Velocity Event'}</h4>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className={`text-lg font-black font-mono ${move.velocity > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {move.velocity > 0 ? '+' : ''}{velocityPct}%
                        </div>
                        <div className="text-[8px] text-slate-500 font-bold uppercase tracking-tighter">{timeAgo < 0 ? 0 : timeAgo}s Ago</div>
                    </div>
                </div>

                <div className="space-y-3">
                    <SignalHeatBar value={move.velocity} />
                    <div className="grid grid-cols-3 gap-2">
                        <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                            <div className="text-[8px] text-gray-500 uppercase font-black mb-0.5">Entry</div>
                            <div className="text-xs font-mono text-white">${move.oldPrice.toFixed(2)}</div>
                        </div>
                        <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                            <div className="text-[8px] text-gray-500 uppercase font-black mb-0.5">Peak</div>
                            <div className="text-xs font-mono text-white">${move.newPrice.toFixed(2)}</div>
                        </div>
                        <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                            <div className="text-[8px] text-gray-500 uppercase font-black mb-0.5">Score</div>
                            <div className="text-xs font-mono text-emerald-400">{(move.confidence * 100).toFixed(0)}</div>
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
    const [stats, setStats] = useState({ totalChased: 0, winRate: 0, totalProfit: 0 });

    useEffect(() => {
        const userId = localStorage.getItem('userAddress') || '';
        const socket = io();

        const fetchData = async () => {
            try {
                const res = await axios.get(`/api/bot/status/${userId}`);
                setSignals(res.data.flashMoves || []);
                // Filter active positions for FOMO origin
                const chases = (res.data.positions || []).filter((p: any) => p.serviceOrigin === 'FOMO');
                setActiveChases(chases);
            } catch (e) { console.error(e); }
            finally { setLoading(false); }
        };

        fetchData();
        const poll = setInterval(fetchData, 10000);

        socket.on('flash_move_detected', (data) => {
            setSignals(prev => [data.event, ...prev].slice(0, 20));
            if (data.event.confidence > 0.8) {
                toast.info(`🔥 High Conf Spike: ${data.event.question?.slice(0,30)}...`, {
                    position: "top-right",
                    autoClose: 3000
                });
            }
        });

        return () => { clearInterval(poll); socket.disconnect(); };
    }, []);

    const handleAbort = async (marketId: string) => {
        const userId = localStorage.getItem('userAddress') || '';
        try {
            await axios.post('/api/trade/exit', { userId, marketId, outcome: 'YES' });
            toast.success("Chase Aborted. Market Order Sent.");
        } catch (e) { toast.error("Abort Failed"); }
    };

    if (loading) return (
        <div className="flex flex-col items-center justify-center py-40 gap-4">
            <Loader2 className="animate-spin text-blue-500" size={40} />
            <p className="text-xs font-black uppercase tracking-[0.4em] text-slate-500">Initializing Tactical HUD...</p>
        </div>
    );

    const globalHeat = signals.length > 5 ? 'EXTREME' : signals.length > 0 ? 'ACTIVE' : 'STABLE';

    return (
        <div className="max-w-7xl mx-auto space-y-8 pb-20 p-4 animate-in fade-in duration-700">
            {/* TACTICAL HEADER */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-gradient-to-br from-rose-600 to-orange-500 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-rose-900/20">
                        <Radar size={32} />
                    </div>
                    <div>
                        <h2 className="text-3xl font-black text-white uppercase tracking-tighter italic">Fomo Runner HUB</h2>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em] flex items-center gap-2">
                            <Activity size={12} className="text-rose-500" /> Real-Time Signal Pulse • Autonomous v3
                        </p>
                    </div>
                </div>
                <div className="flex gap-4 w-full md:w-auto">
                    <div className="flex-1 md:flex-none glass-panel px-6 py-3 rounded-2xl border-white/5 bg-slate-900/40">
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Global Heat</div>
                        <div className={`text-xl font-black font-mono ${globalHeat === 'EXTREME' ? 'text-rose-500 animate-pulse' : 'text-orange-400'}`}>
                            {globalHeat}
                        </div>
                    </div>
                    <div className="flex-1 md:flex-none glass-panel px-6 py-3 rounded-2xl border-white/5 bg-slate-900/40">
                        <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Latency</div>
                        <div className="text-xl font-black text-white font-mono">0.42s <span className="text-[10px] font-normal text-slate-500">API</span></div>
                    </div>
                </div>
            </div>

            {/* FIX: Elevated 'Active Chases' section for immediate control */}
            <section className="space-y-4">
                <div className="flex items-center justify-between">
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.4em] flex items-center gap-2">
                        <Sword size={14} className="text-rose-500" /> Live Combat Sequences ({activeChases.length})
                    </h3>
                    {activeChases.length > 0 && <span className="text-[9px] font-black text-emerald-500 animate-pulse uppercase tracking-widest">Active Monitoring</span>}
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {activeChases.map((chase, idx) => (
                        <div key={idx} className="glass-panel p-6 rounded-[2rem] border-rose-500/30 bg-rose-500/5 relative overflow-hidden group">
                            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:scale-110 transition-transform"><Flame size={100} className="text-rose-500"/></div>
                            <div className="relative z-10 space-y-4">
                                <h4 className="text-sm font-black text-white uppercase leading-tight line-clamp-1">{chase.question}</h4>
                                <div className="flex justify-between items-end">
                                    <div>
                                        <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Unrealized PnL</p>
                                        <p className={`text-2xl font-black font-mono ${(chase.currentPrice - chase.entryPrice) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {((chase.currentPrice - chase.entryPrice) * chase.shares).toFixed(2)} <span className="text-xs">USDC</span>
                                        </p>
                                    </div>
                                    <button 
                                        onClick={() => handleAbort(chase.marketId)}
                                        className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-xl text-[10px] uppercase tracking-widest shadow-lg shadow-rose-900/40 active:scale-95 transition-all"
                                    >
                                        Abort Chase
                                    </button>
                                </div>
                                <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                                    <div className="h-full bg-rose-500 animate-pulse" style={{ width: '65%' }} />
                                </div>
                            </div>
                        </div>
                    ))}
                    {activeChases.length === 0 && (
                        <div className="col-span-full py-12 text-center border-2 border-dashed border-white/5 rounded-[2rem] flex flex-col items-center gap-3 opacity-20">
                            <Target size={32} />
                            <p className="text-[10px] font-black uppercase tracking-widest">No Active Combat Sequences</p>
                        </div>
                    )}
                </div>
            </section>

            {/* RADAR SIGNAL FEED */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
                <div className="lg:col-span-8 space-y-6">
                    <div className="flex items-center gap-4 mb-4">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.4em] flex items-center gap-2">
                            <Zap size={14} className="text-amber-500" /> Momentum Radar
                        </h3>
                        <div className="h-px flex-1 bg-white/5"></div>
                        <span className="text-[10px] font-black text-amber-500 animate-pulse uppercase tracking-widest">Scanning Network Pulse...</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {signals.map((sig, i) => <TacticalSignalCard key={i} move={sig} />)}
                        {signals.length === 0 && (
                            <div className="col-span-full py-32 flex flex-col items-center gap-4 text-slate-700">
                                <Radar size={64} className="animate-spin-slow opacity-10" />
                                <p className="text-sm font-black uppercase tracking-widest opacity-20">Awaiting Price Flash Events...</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* SIDEBAR INTEL */}
                <div className="lg:col-span-4 space-y-6">
                    <div className="glass-panel p-8 rounded-[2.5rem] border-white/5">
                        <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-6 flex items-center gap-2">
                            <ShieldCheck size={14} className="text-blue-500"/> Tactical Logic
                        </h4>
                        <div className="space-y-4">
                            {[
                                { label: 'Min Velocity', val: '3%', desc: 'Price movement required within 60s window' },
                                { label: 'Confidence Floor', val: '75%', desc: 'Algorithmic signal certainty threshold' },
                                { label: 'Safety Cut-off', val: '500 USDC', desc: 'Maximum single position chase exposure' }
                            ].map((item, i) => (
                                <div key={i} className="p-4 bg-white/5 rounded-2xl border border-white/5 group hover:border-blue-500/20 transition-all">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-[10px] font-black text-white uppercase">{item.label}</span>
                                        <span className="text-xs font-mono font-black text-blue-400">{item.val}</span>
                                    </div>
                                    <p className="text-[9px] text-slate-600 font-bold">{item.desc}</p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="glass-panel p-8 rounded-[2.5rem] border-rose-500/20 bg-rose-500/[0.02]">
                        <h4 className="text-[10px] font-black text-rose-500 uppercase tracking-[0.3em] mb-4">HFT Radar Advisory</h4>
                        <p className="text-[11px] text-slate-400 leading-relaxed font-medium">
                            Fomo Runner engages markets with explosive price movements. High velocity often implies lower orderbook depth. Always maintain a <strong>Max Trade Size</strong> in the Vault to prevent slippage on thin volatility spikes.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FlashMoveDashboard;
