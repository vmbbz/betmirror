import React, { useMemo, useCallback } from 'react';
import { 
  Sword, Zap, ShieldCheck, 
  ExternalLink, TrendingUp, 
  TrendingDown, RefreshCw, Flame,
  Loader2, Target
} from 'lucide-react';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

interface FlashMove {
    id: string;
    tokenId: string;
    question: string;
    oldPrice: number;
    newPrice: number;
    velocity: number;
    timestamp: number;
    image?: string;
    marketSlug?: string;
    eventSlug?: string;
}

const FlashCard = ({ move }: { move: FlashMove }) => {
    // Add defensive checks for move
    if (!move) {
        console.error('FlashCard received null/undefined move');
        return null;
    }
    
    const isUp = (move.velocity || 0) > 0;
    // Ensure we have valid slugs before constructing URL
    const hasValidSlugs = move.eventSlug && move.marketSlug;
    const polyUrl = hasValidSlugs 
        ? `https://polymarket.com/event/${move.eventSlug}/${move.marketSlug}`
        : '#';

    return (
        <div className="relative transition-all duration-500 w-full max-w-[420px] mx-auto scale-[1.03] z-10 group">
            {/* Pulsating Sniper Glow */}
            <div className="absolute -inset-0.5 bg-gradient-to-r from-rose-500 via-orange-500 to-rose-500 rounded-[2.5rem] blur opacity-30 group-hover:opacity-60 transition-opacity animate-pulse"></div>

            <div className="glass-panel rounded-[2.2rem] border-rose-500/30 bg-slate-900/95 shadow-2xl relative flex flex-col h-full overflow-hidden transition-transform hover:-translate-y-1">
                
                {/* Visual Header with Market Image */}
                <div className="h-28 w-full relative overflow-hidden shrink-0">
                    {move.image ? (
                        <img 
                            src={move.image} 
                            alt="Market" 
                            className="w-full h-full object-cover opacity-20 scale-110 group-hover:scale-125 transition-transform duration-1000 blur-[2px]" 
                        />
                    ) : (
                        <div className="w-full h-full bg-slate-800 opacity-20"></div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-b from-slate-900/20 via-slate-900/80 to-slate-900"></div>
                    
                    <div className="absolute top-4 left-6 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-rose-500 shadow-lg shadow-rose-500/40 flex items-center justify-center text-white animate-bounce">
                            <Zap size={20} fill="currentColor"/>
                        </div>
                        <div>
                            <h4 className="text-[10px] font-black text-rose-400 uppercase tracking-[0.3em] leading-none">Flash Move</h4>
                            <p className="text-[8px] text-slate-500 font-mono mt-1">{(new Date(move.timestamp)).toLocaleTimeString()}</p>
                        </div>
                    </div>

                    <div className="absolute top-4 right-6">
                        <a href={polyUrl} target="_blank" rel="noreferrer" className="p-2 bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-colors">
                            <ExternalLink size={14} className="text-slate-400" />
                        </a>
                    </div>
                </div>

                <div className="px-6 pb-6 relative z-10 flex-1 flex flex-col">
                    <h4 className="text-[14px] font-bold text-white leading-snug mb-6 line-clamp-2 min-h-[42px]">
                        {move.question}
                    </h4>

                    {/* Price Velocity Grid */}
                    <div className="grid grid-cols-2 gap-4 mb-6">
                        <div className="p-4 bg-black/40 rounded-2xl border border-white/5 flex flex-col">
                            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Baseline</p>
                            <p className="text-xl font-mono font-bold text-slate-400">${move.oldPrice.toFixed(2)}</p>
                        </div>
                        <div className="p-4 bg-rose-500/5 rounded-2xl border border-rose-500/20 flex flex-col relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-1 opacity-10"><TrendingUp size={32}/></div>
                            <p className="text-[8px] font-black text-rose-500 uppercase tracking-widest mb-1.5">Current Spike</p>
                            <p className="text-xl font-mono font-black text-white">${move.newPrice.toFixed(2)}</p>
                        </div>
                    </div>

                    {/* Velocity Performance Bar */}
                    <div className="bg-slate-950 rounded-2xl p-4 flex items-center justify-between border border-white/5 shadow-inner">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-500">
                                {isUp ? <TrendingUp size={24}/> : <TrendingDown size={24}/>}
                            </div>
                            <div>
                                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Alpha Velocity</p>
                                <p className="text-2xl font-black text-rose-500 tracking-tighter">
                                    {(move.velocity * 100).toFixed(1)}<span className="text-sm ml-0.5">%</span>
                                </p>
                            </div>
                        </div>
                        <div className="text-right">
                             <p className="text-[8px] font-bold text-slate-500 uppercase mb-1">Protection</p>
                             <div className="flex items-center gap-1.5">
                                 <ShieldCheck size={10} className="text-emerald-500"/>
                                 <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Sniper Lock</span>
                             </div>
                        </div>
                    </div>
                </div>

                <div className="px-6 pb-6">
                    <button className="w-full py-4 bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-500 hover:to-orange-500 text-white font-black text-[11px] uppercase tracking-[0.25em] rounded-2xl transition-all shadow-xl shadow-rose-500/20 flex items-center justify-center gap-3 group-hover:scale-[1.02]">
                        <Sword size={18}/> Execute High-Velocity Entry
                    </button>
                </div>
            </div>
        </div>
    );
};

interface FomoRunnerProps {
    flashMoves?: FlashMove[];
    onRefresh?: () => Promise<void>;
    isLoading?: boolean;
}

const FomoRunner: React.FC<FomoRunnerProps> = ({ 
    flashMoves: initialFlashMoves = [],
    onRefresh,
    isLoading = false
}) => {
    // Process flash moves data
    const processedMoves = useMemo(() => {
        try {
            const moves = Array.isArray(initialFlashMoves) ? initialFlashMoves : [];
            return moves.map(move => ({
                ...move,
                tokenId: move.tokenId || '',
                question: move.question || 'Unknown Market',
                oldPrice: move.oldPrice || 0,
                newPrice: move.newPrice || 0,
                velocity: move.velocity || 0,
                timestamp: move.timestamp || Date.now(),
                marketSlug: move.marketSlug || '',
                eventSlug: move.eventSlug || '',
                image: move.image || undefined
            }));
        } catch (error) {
            console.error('Error processing flash moves:', error);
            return [];
        }
    }, [initialFlashMoves]);

    // Handle refresh
    const handleRefresh = useCallback(async () => {
        if (onRefresh) {
            try {
                await onRefresh();
                toast.success('Flash moves refreshed');
            } catch (error) {
                console.error('Error refreshing data:', error);
                toast.error('Failed to refresh data');
            }
        }
    }, [onRefresh]);

    // Handle loading state
    if (isLoading) {
        return (
            <div className="max-w-[1600px] mx-auto py-20 px-4 md:px-8 flex items-center justify-center">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-rose-500 mx-auto mb-4"></div>
                    <p className="text-gray-400 text-sm">Scanning for flash moves...</p>
                </div>
            </div>
        );
    }

    // Handle error state - using initialFlashMoves instead of flashMoves
    if (!Array.isArray(initialFlashMoves)) {
        return (
            <div className="max-w-[1600px] mx-auto py-20 px-4 md:px-8 flex items-center justify-center">
                <div className="text-center">
                    <div className="w-12 h-12 rounded-full bg-rose-500/20 flex items-center justify-center mx-auto mb-4">
                        <Target className="text-rose-500" size={24} />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-2">Error Loading Data</h3>
                    <p className="text-gray-400 text-sm mb-4">Unable to load flash moves. Please try again.</p>
                    <button
                        onClick={handleRefresh}
                        className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-lg text-sm font-medium transition-colors"
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-[1600px] mx-auto pb-20 px-4 md:px-8 animate-in fade-in duration-1000">
            {/* Navigation & Stats */}
            <div className="flex flex-col md:flex-row justify-between items-end gap-6 mb-12 border-b border-white/5 pb-10">
                <div className="space-y-4">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-rose-600 rounded-2xl shadow-lg shadow-rose-900/40">
                            <Flame className="text-white" size={32}/>
                        </div>
                        <h2 className="text-5xl font-black text-white uppercase tracking-tighter italic">
                            FOMO <span className="text-rose-500">RUNNER</span>
                        </h2>
                    </div>
                    <p className="text-xs text-slate-500 font-bold uppercase tracking-[0.5em] ml-20">
                        GLOBAL VELOCITY SNIPER PRO v2.0
                    </p>
                </div>
                
                <div className="flex items-center gap-4">
                    <div className="text-right">
                        <p className="text-sm text-slate-400">Last updated</p>
                        <p className="text-white font-mono">
                            {new Date().toLocaleTimeString()}
                        </p>
                    </div>
                    <button 
                        onClick={handleRefresh}
                        disabled={isLoading}
                        className={`p-2 rounded-lg ${isLoading ? 'bg-slate-800' : 'bg-slate-800 hover:bg-slate-700'} transition-colors`}
                        title="Refresh data"
                    >
                        <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin text-slate-500' : 'text-rose-400'}`} />
                    </button>
                </div>
                
                <div className="flex items-center gap-4 mb-2">
                    <div className="bg-slate-900/60 px-8 py-4 rounded-3xl border border-white/10 flex items-center gap-6 shadow-xl backdrop-blur-md">
                        <div className="flex flex-col">
                            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Active Streams</p>
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse shadow-[0_0_10px_#3b82f6]"></div>
                                <p className="text-xl font-mono font-black text-white">1,472</p>
                            </div>
                        </div>
                        <div className="w-px h-10 bg-white/10"></div>
                        <div className="flex flex-col">
                            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Global Heat</p>
                            <p className="text-xl font-mono font-black text-rose-500">HIGH</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-12 gap-10">
                <div className="col-span-12 xl:col-span-9">
                    {initialFlashMoves.length === 0 ? (
                        <div className="glass-panel p-20 rounded-[3rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20 min-h-[550px] relative overflow-hidden">
                             <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(244,63,94,0.03)_0%,transparent_70%)]"></div>
                            <Loader2 className="animate-spin text-rose-500/20 mb-10" size={72}/>
                            <p className="text-slate-600 uppercase font-black tracking-[1em] text-sm animate-pulse">Monitoring pitch velocity via real-time stream...</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
                            {initialFlashMoves.map((move: FlashMove) => (
                                <FlashCard key={move.id} move={move} />
                            ))}
                        </div>
                    )}
                </div>

                {/* Tactical Strategy Sidebar */}
                <div className="col-span-12 xl:col-span-3 space-y-8">
                    <div className="glass-panel rounded-[2.5rem] border-white/5 bg-black/40 overflow-hidden flex flex-col shadow-2xl sticky top-24">
                        <div className="p-8 border-b border-white/[0.03] bg-gradient-to-br from-rose-500/10 to-transparent">
                            <h3 className="text-sm font-black text-white uppercase tracking-[0.4em] flex items-center gap-4">
                                <Target size={20} className="text-rose-500"/> FOMO STRATEGY
                            </h3>
                        </div>
                        
                        <div className="p-8 space-y-8">
                            <div className="space-y-3">
                                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Autonomous Guard</p>
                                <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl">
                                    <p className="text-xs text-emerald-200/80 leading-relaxed font-bold">
                                        Liquidity Guard: Enabled ($1,000 Floor)
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Risk Mitigation</p>
                                <div className="flex justify-between items-center p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl">
                                    <span className="text-[10px] font-bold text-rose-400">Hard Stop Loss</span>
                                    <span className="text-xs font-mono font-black text-white">10%</span>
                                </div>
                            </div>

                            <div className="pt-8 border-t border-white/5 space-y-5">
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Detection Time</span>
                                    <span className="text-[10px] font-mono text-white">~50ms</span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase">GTC Take-Profit</span>
                                    <span className="text-[10px] font-mono text-emerald-400">ACTIVE</span>
                                </div>
                            </div>

                            <div className="p-5 bg-blue-500/10 border border-blue-500/20 rounded-3xl">
                                <p className="text-[10px] font-bold text-blue-300 leading-relaxed">
                                    Flash moves often indicate unannounced alpha. Sniper enters at market then immediately parks a sell limit on the book.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FomoRunner;
