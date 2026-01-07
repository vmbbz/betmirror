import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Crosshair, Zap, Scale, Terminal, ShieldCheck, 
  Loader2, Search, Globe, Trophy, 
  TrendingUp, ExternalLink, RefreshCw,
  Coins, Landmark, Star, BarChart3, PlusCircle, Cpu, Lock
} from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
import { ActivePosition } from './domain/trade.types.js';
import { ArbitrageOpportunity } from './adapters/interfaces.js';
import { UserStats } from './domain/user.types.js';

type TabValue = "dashboard" | "money-market" | "marketplace" | "history" | "vault" | "bridge" | "system" | "help";

const formatCompactNumber = (num: number): string => {
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
  return (num / 1000000000).toFixed(1) + 'B';
};

// --- Internal Component: Inventory Skew Meter ---
const InventorySkewMeter = ({ skew }: { skew: number }) => {
  const isLong = skew >= 0;
  return (
    <div className="space-y-1.5 mt-3 bg-black/40 p-2.5 rounded-xl border border-white/5">
      <div className="flex justify-between text-[7px] font-black uppercase tracking-widest">
        <span className="text-gray-500">Inventory Skew</span>
        <span className={isLong ? 'text-emerald-500' : 'text-rose-500'}>
          {isLong ? 'YES' : 'NO'} {Math.abs(skew * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-1 bg-white/10 rounded-full overflow-hidden relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20 z-10"></div>
        <div 
          className={`h-full transition-all duration-700 ${isLong ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]'}`}
          style={{ 
            width: `${Math.max(5, Math.abs(skew * 50))}%`, 
            left: isLong ? '50%' : `${50 - Math.abs(skew * 50)}%` 
          }}
        />
      </div>
    </div>
  );
};

// --- Internal Component: Exposure Position Card ---
const PositionCard = ({ position }: { position: ActivePosition }) => {
    const value = (position.currentPrice || position.entryPrice) * position.shares;
    const cost = position.entryPrice * position.shares;
    const pnl = value - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

    return (
        <div className={`p-4 bg-white/[0.02] rounded-2xl border transition-all hover:border-blue-500/30 ${position.managedByMM ? 'border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.05)]' : 'border-white/5'}`}>
            <div className="flex gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-gray-900 shrink-0 border border-white/5 overflow-hidden flex items-center justify-center">
                    {position.image ? <img src={position.image} className="w-full h-full object-cover" /> : <Activity size={16} className="text-gray-700"/>}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-black text-white truncate leading-tight uppercase tracking-tight">{position.question}</p>
                    <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${position.outcome === 'YES' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{position.outcome}</span>
                        {position.managedByMM && (
                             <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1"><Zap size={8} fill="currentColor"/> MM Active</span>
                        )}
                    </div>
                </div>
            </div>
            {position.managedByMM && <InventorySkewMeter skew={position.inventorySkew || 0} />}
            <div className="grid grid-cols-2 gap-4 mt-4 border-t border-white/5 pt-3">
                <div>
                    <p className="text-[8px] font-black text-gray-600 uppercase mb-0.5">Valuation</p>
                    <p className="text-[11px] font-mono font-black text-white">${value.toFixed(2)}</p>
                </div>
                <div className="text-right">
                    <p className="text-[8px] font-black text-gray-600 uppercase mb-0.5">Performance</p>
                    <p className={`text-[11px] font-mono font-black ${pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)</p>
                </div>
            </div>
        </div>
    );
};

// --- Internal Component: Reward Scoring Badge ---
const RewardScoringBadge = ({ spread, maxSpread }: { spread: number, maxSpread?: number }) => {
  const isScoring = maxSpread ? (spread <= maxSpread) : true;
  return (
    <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-widest ${
      isScoring ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-gray-500/10 text-gray-500 border border-white/5'
    }`}>
      <Cpu size={8} className={isScoring ? 'animate-pulse' : ''} />
      {isScoring ? 'Rewards Active' : 'Outside Band'}
    </div>
  );
};

// --- Internal Component: The Scout Card (Preserved Design) ---
const ScoutMarketCard = ({ 
  opp, 
  onExecute, 
  onBookmark,
  holdings,
  isBookmarking = false
}: { 
  opp: ArbitrageOpportunity, 
  onExecute: (o: any) => void,
  onBookmark: (id: string, state: boolean) => void,
  holdings?: ActivePosition,
  isBookmarking?: boolean
}) => {
  const isHighVol = opp.isVolatile || (opp.lastPriceMovePct !== undefined && opp.lastPriceMovePct > 3);
  const movePct = opp.lastPriceMovePct?.toFixed(1) || '0.0';
  const spreadCents = (opp.spread * 100).toFixed(1);

  return (
    <div className={`relative group glass-panel rounded-2xl border transition-all duration-300 hover:-translate-y-1 overflow-hidden ${
      holdings ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.1)]' : 'border-white/5 hover:border-blue-500/40'
    } ${isHighVol ? 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.15)]' : ''}`}>
      
      {isHighVol && (
        <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-600 text-white text-[8px] font-black px-2 py-0.5 rounded-full flex items-center gap-1 z-30 shadow-lg">
          <Zap className="w-2.5 h-2.5" fill="currentColor" /> 
          SPIKE: {movePct}%
        </div>
      )}

      <div className="relative h-32 bg-gray-100 dark:bg-gray-800 overflow-hidden">
        {opp.image ? (
          <img src={opp.image} alt={opp.question} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-blue-900/20 to-black">
            <BarChart3 className="w-10 h-10 text-gray-700" />
          </div>
        )}
        
        <div className="absolute top-1.5 left-1.5 z-30 flex flex-col gap-1.5">
          <button 
            onClick={(e) => { e.stopPropagation(); onBookmark(opp.marketId, !opp.isBookmarked); }}
            className={`p-1.5 rounded-full backdrop-blur-md transition-all ${opp.isBookmarked ? 'bg-yellow-500/20 text-yellow-500' : 'bg-black/40 text-gray-400 hover:text-white'}`}
          >
            {isBookmarking ? <Loader2 size={12} className="animate-spin" /> : <Star size={12} fill={opp.isBookmarked ? 'currentColor' : 'none'} />}
          </button>
          <RewardScoringBadge spread={Number(spreadCents)} maxSpread={opp.rewardsMaxSpread} />
        </div>

        <div className="absolute top-1.5 right-1.5 z-10">
          {opp.category && (
            <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-[8px] font-black text-gray-300 uppercase tracking-widest">
              {opp.category}
            </span>
          )}
        </div>

        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 z-20">
          <button onClick={() => onExecute(opp)} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-xl transition-all hover:scale-105 mb-3">
            Quick Capture
          </button>
          <a href={`https://polymarket.com/market/${opp.marketSlug || opp.marketId}`} target="_blank" className="text-[9px] text-gray-400 hover:text-white uppercase font-black tracking-widest flex items-center gap-1.5">
            View Source <ExternalLink size={9}/>
          </a>
        </div>
      </div>

      <div className="p-4 space-y-3">
        <h3 className="text-[11px] font-black text-white leading-tight line-clamp-2 h-8 tracking-tight uppercase">
          {opp.question}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 bg-white/[0.02] border border-white/5 rounded-xl">
            <p className="text-[7px] font-black text-gray-500 uppercase tracking-widest mb-0.5">Spread</p>
            <p className="text-xs font-mono font-black text-blue-400">{spreadCents}¢</p>
          </div>
          <div className="p-2 bg-white/[0.02] border border-white/5 rounded-xl">
            <p className="text-[7px] font-black text-gray-500 uppercase tracking-widest mb-0.5">Liquidity</p>
            <p className="text-xs font-mono font-black text-white">${formatCompactNumber(opp.liquidity || 0)}</p>
          </div>
        </div>
        <button onClick={() => onExecute(opp)} className={`w-full py-2 rounded-lg font-black text-[9px] uppercase tracking-widest transition-all ${ holdings ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-white/5 hover:bg-white text-gray-400 hover:text-black border border-white/10' }`}>
          {holdings ? 'Adjust Strategy' : 'Dispatch HFT'}
        </button>
      </div>
    </div>
  );
};

export interface ProTerminalProps {
  userId: string;
  stats: UserStats | null;
  activePositions: ActivePosition[];
  logs: any[];
  moneyMarketOpps: ArbitrageOpportunity[];
  isRunning: boolean;
  onRefresh: (force?: boolean) => Promise<void>;
  handleExecuteMM: (opp: ArbitrageOpportunity) => Promise<void>;
  handleSyncPositions: () => Promise<void>;
  openDepositModal: () => void;
  openWithdrawModal: () => void;
  setActiveTab: (tab: TabValue) => void;
}

const ProTerminal: React.FC<ProTerminalProps> = ({ 
  userId, 
  stats,
  activePositions, 
  logs,
  moneyMarketOpps,
  onRefresh,
  handleExecuteMM,
  handleSyncPositions
}) => {
    const [activeCategory, setActiveCategory] = useState('all');
    const [manualId, setManualId] = useState('');
    const [scanning, setScanning] = useState(false);
    const [bookmarkedMarkets, setBookmarkedMarkets] = useState<Set<string>>(new Set());
    const [isBookmarking, setIsBookmarking] = useState<Record<string, boolean>>({});
    const [lastHftPulse, setLastHftPulse] = useState(Date.now());

    useEffect(() => {
        if (logs.length > 0 && (logs[0].message.includes('FILLED') || logs[0].message.includes('QUOTE'))) {
            setLastHftPulse(Date.now());
        }
    }, [logs]);

    const filteredOpps = useMemo(() => {
        if (!moneyMarketOpps) return [];
        const enhanced = moneyMarketOpps.map(opp => ({
            ...opp,
            isBookmarked: bookmarkedMarkets.has(opp.marketId) || opp.isBookmarked
        }));
        if (activeCategory === 'bookmarks') return enhanced.filter(o => o.isBookmarked);
        if (activeCategory !== 'all') return enhanced.filter(o => o.category?.toLowerCase() === activeCategory.toLowerCase());
        return enhanced;
    }, [moneyMarketOpps, activeCategory, bookmarkedMarkets]);

    const handleManualAdd = async () => {
        if (!manualId) return;
        setScanning(true);
        try {
            const isSlug = !manualId.startsWith('0x');
            await axios.post('/api/bot/mm/add-market', { userId, [isSlug ? 'slug' : 'conditionId']: manualId });
            toast.success("✅ Intelligence Synced");
            setManualId('');
            onRefresh(true);
        } catch (e) { toast.error("Sync failed"); }
        finally { setScanning(false); }
    };

    const handleBookmark = async (marketId: string, isBookmarked: boolean) => {
        if (!userId) return;
        setIsBookmarking(prev => ({ ...prev, [marketId]: true }));
        try {
            await axios.post('/api/bot/mm/bookmark', { userId, marketId, isBookmarked });
            setBookmarkedMarkets(prev => {
                const next = new Set(prev);
                if (isBookmarked) next.add(marketId);
                else next.delete(marketId);
                return next;
            });
            toast.success(isBookmarked ? "📌 Bookmarked" : "Removed");
        } catch (e) { toast.error("Bookmark failed"); }
        finally { setIsBookmarking(prev => ({ ...prev, [marketId]: false })); }
    };

    return (
        <div className="grid grid-cols-12 gap-8 pb-10 animate-in fade-in duration-500 max-w-screen-2xl mx-auto">
            {/* LEFT COLUMN: Main Discovery Feed */}
            <div className="col-span-12 lg:col-span-8 space-y-6">
                <div className="glass-panel p-6 rounded-3xl border-white/5 bg-gradient-to-br from-blue-600/[0.02] to-transparent shadow-xl relative overflow-hidden">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 relative z-10">
                        <div>
                            <h2 className="text-2xl font-black text-white uppercase tracking-tight flex items-center gap-3">
                                <Crosshair className="text-blue-500" size={24}/> Intelligence Scout
                            </h2>
                            <p className="text-[9px] text-gray-500 font-bold uppercase tracking-[0.4em] mt-1">Autonomous Yield Capture Protocol v4.0</p>
                        </div>
                        <div className="flex gap-2 w-full md:w-auto">
                            <div className="relative flex-1 md:w-[260px]">
                                <input value={manualId} onChange={(e)=>setManualId(e.target.value)} placeholder="Market ID or Slug..." className="w-full bg-black/40 border border-white/5 rounded-xl px-4 py-2.5 text-[10px] font-mono text-white outline-none focus:border-blue-500/50 transition-all placeholder:text-gray-700" />
                            </div>
                            <button onClick={handleManualAdd} className="bg-white text-black px-4 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-gray-200 transition-all shadow-lg flex items-center justify-center">
                                {scanning ? <Loader2 size={14} className="animate-spin"/> : <PlusCircle size={14}/>}
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 relative z-10">
                        {[
                            { id: 'all', label: 'All Discovery', icon: <Globe size={12}/> },
                            { id: 'trending', label: 'Trending', icon: <TrendingUp size={12}/> },
                            { id: 'sports', label: 'Sports', icon: <Trophy size={12}/> },
                            { id: 'crypto', label: 'Crypto', icon: <Coins size={12}/> },
                            { id: 'politics', label: 'Politics', icon: <Landmark size={12}/> },
                            { id: 'bookmarks', label: 'Bookmarks', icon: <Star size={12}/> }
                        ].map(cat => (
                            <button key={cat.id} onClick={() => setActiveCategory(cat.id)} className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-all whitespace-nowrap ${activeCategory === cat.id ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/40' : 'bg-white/5 text-gray-500 border-white/5 hover:border-white/20'}`}>
                                {cat.icon} {cat.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    {filteredOpps.map((opp: any) => (
                        <ScoutMarketCard key={opp.tokenId} opp={opp} onExecute={handleExecuteMM} onBookmark={handleBookmark} holdings={activePositions.find(p => p.marketId === opp.marketId)} isBookmarking={isBookmarking[opp.marketId]} />
                    ))}
                    {filteredOpps.length === 0 && (
                        <div className="col-span-full py-32 text-center glass-panel rounded-3xl border-dashed border-white/10 flex flex-col items-center justify-center space-y-4 grayscale">
                            <Activity size={40} className="text-gray-800 animate-pulse"/>
                            <h3 className="text-sm font-black text-gray-700 uppercase tracking-widest">Awaiting Alpha Signals</h3>
                        </div>
                    )}
                </div>
            </div>

            {/* RIGHT COLUMN: Exposure & Discovery Sidebars */}
            <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">
                {/* Active Risk Exposure */}
                <div className="glass-panel p-6 rounded-3xl border-white/5 flex flex-col shadow-xl max-h-[580px]">
                    <div className="flex items-center justify-between mb-6">
                        <div className="space-y-1">
                            <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2">
                                <Scale size={16} className="text-blue-500"/> Exposure Hub
                            </h3>
                            <p className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">Live Inventory Positions</p>
                        </div>
                        <button onClick={handleSyncPositions} className="p-2 hover:bg-white/5 rounded-full transition-colors text-gray-500 hover:text-white">
                            <RefreshCw size={14}/>
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar">
                        {activePositions.length === 0 ? (
                            <div className="h-full py-10 flex flex-col items-center justify-center text-gray-700 opacity-20 space-y-4">
                                <Lock size={40}/>
                                <p className="uppercase tracking-[0.2em] font-black text-center text-[9px]">No active inventory<br/>in vault</p>
                            </div>
                        ) : (
                            activePositions.map((pos: ActivePosition) => (
                                <PositionCard key={pos.marketId + pos.outcome} position={pos} />
                            ))
                        )}
                    </div>
                </div>

                {/* Global Opportunity Scout Sidebar */}
                <div className="glass-panel p-6 rounded-3xl border-white/5 bg-gradient-to-br from-blue-600/5 to-transparent flex flex-col shadow-xl">
                    <div className="flex items-center justify-between mb-6">
                        <div className="space-y-1">
                            <h3 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2">
                                <Crosshair size={16} className="text-blue-500"/> Opportunity Scout
                            </h3>
                            <p className="text-[8px] text-gray-500 font-bold uppercase tracking-widest">High-Yield Reward Pools</p>
                        </div>
                    </div>
                    <div className="space-y-3 overflow-y-auto h-[380px] custom-scrollbar pr-1">
                        {moneyMarketOpps.length === 0 ? (
                             <div className="h-full flex items-center justify-center text-gray-600 text-[10px] italic font-bold">Scanning for Spreads...</div>
                        ) : (
                            moneyMarketOpps.slice(0, 15).map((opp: ArbitrageOpportunity) => {
                                const holdings = activePositions.find(p => p.marketId === opp.marketId);
                                return (
                                    <div key={opp.tokenId} onClick={() => handleExecuteMM(opp)} className={`flex items-center gap-4 p-3 bg-black/40 rounded-xl border transition-all cursor-pointer group ${holdings ? 'border-emerald-500/40 bg-emerald-500/[0.01]' : 'border-white/5 hover:border-blue-500/30 hover:bg-white/[0.01]'}`}>
                                        <div className="w-8 h-8 rounded-lg bg-gray-900 border border-white/5 overflow-hidden shrink-0">
                                            <img src={opp.image} className="w-full h-full object-cover grayscale-[40%] group-hover:grayscale-0 group-hover:scale-110 transition-all duration-500" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[9px] font-bold text-white truncate uppercase tracking-tight">{opp.question}</p>
                                            <div className="flex items-center gap-2.5 mt-1">
                                                 <p className="text-[9px] font-black text-blue-500 font-mono">{(opp.spreadCents ? opp.spreadCents : (opp.spread * 100)).toFixed(1)}¢ ROI</p>
                                                 <p className="text-[8px] font-bold text-gray-600 uppercase">Vol: ${formatCompactNumber(opp.volume || 0)}</p>
                                            </div>
                                        </div>
                                        {holdings && <ShieldCheck size={14} className="text-emerald-500 shrink-0"/>}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ProTerminal;
