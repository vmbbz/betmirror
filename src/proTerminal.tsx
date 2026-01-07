
import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Crosshair, Zap, Scale, Terminal, ShieldCheck, 
  Loader2, Search, Globe, Trophy, 
  TrendingUp, ExternalLink, RefreshCw,
  Coins, Landmark, Star, BarChart3, PlusCircle, Cpu, Lock, Info, X, ChevronRight, Layers, Recycle
} from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
import { ActivePosition } from './domain/trade.types.js';
import { ArbitrageOpportunity } from './adapters/interfaces.js';
import { UserStats } from './domain/user.types.js';

type TabValue = "dashboard" | "money-market";

const formatCompactNumber = (num: number): string => {
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
  return (num / 1000000000).toFixed(1) + 'B';
};

// --- Sub-Component: Money Market Anatomy Modal ---
const MoneyMarketExplainer = ({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/90 backdrop-blur-xl animate-in fade-in duration-300">
            <div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto custom-scrollbar bg-[#0a0a0a] border border-white/10 rounded-[3rem] p-10 shadow-2xl">
                <button onClick={onClose} className="absolute top-8 right-8 p-2 text-gray-500 hover:text-white hover:bg-white/5 rounded-full transition-all">
                    <X size={24}/>
                </button>

                <div className="space-y-12">
                    {/* Header */}
                    <div className="text-center space-y-4">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-black uppercase tracking-[0.2em]">
                            <Terminal size={14}/> Institutional Engine Anatomy
                        </div>
                        <h2 className="text-4xl font-black text-white uppercase tracking-tighter italic">How the Money Market Logic Works</h2>
                        <p className="text-gray-500 max-w-xl mx-auto text-sm font-medium">
                            Bet Mirror Pro operates as a sophisticated HFT (High-Frequency Trading) Market Maker. Here is how our server-side engine captures alpha on every tick.
                        </p>
                    </div>

                    {/* Dual Purpose Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="p-8 bg-white/[0.02] border border-white/5 rounded-[2.5rem] space-y-4">
                            <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20">
                                <Recycle size={24}/>
                            </div>
                            <h3 className="text-xl font-black text-white uppercase italic">1. Spread Arbitrage</h3>
                            <p className="text-gray-400 text-xs leading-relaxed">
                                The engine identifies "gaps" in the order book. By simultaneously placing a <span className="text-emerald-400 font-bold">BID</span> (Buy) and an <span className="text-rose-400 font-bold">ASK</span> (Sell), we capture the spread. This is pure arbitrage: buying at the bottom of the gap and selling at the top.
                            </p>
                        </div>
                        <div className="p-8 bg-white/[0.02] border border-white/5 rounded-[2.5rem] space-y-4">
                            <div className="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center text-white shadow-lg shadow-emerald-600/20">
                                <Trophy size={24}/>
                            </div>
                            <h3 className="text-xl font-black text-white uppercase italic">2. Liquidity Rewards</h3>
                            <p className="text-gray-400 text-xs leading-relaxed">
                                Polymarket rewards users who provide liquidity. Our server ensures your quotes stay within the <span className="text-blue-400 font-bold">Max Reward Band</span>. Even if a trade doesn't fill immediately, the bot generates a passive USDC yield just for existing on the book.
                            </p>
                        </div>
                    </div>

                    {/* Step-by-Step Server Logic */}
                    <div className="space-y-6">
                        <h4 className="text-xs font-black text-gray-500 uppercase tracking-[0.3em] border-l-2 border-blue-500 pl-4">The Autonomous Execution Loop</h4>
                        <div className="grid grid-cols-1 gap-4">
                            {[
                                {
                                    icon: <Crosshair className="text-blue-400"/>,
                                    title: "Real-time Midpoint Calculation",
                                    desc: "The server tracks the fair value of a market in milliseconds. It identifies the exact center between the current buyer and seller."
                                },
                                {
                                    icon: <Zap className="text-amber-400"/>,
                                    title: "GTC Order Placement",
                                    desc: "Unlike 'Swaps' which lose money to slippage, we use GTC (Good-Til-Cancelled) Limit Orders. These rest on the blockchain, becoming the liquidity other people pay for."
                                },
                                {
                                    icon: <Scale className="text-purple-400"/>,
                                    title: "Inventory Skew Management",
                                    desc: "If the bot accumulates too many 'YES' shares, it automatically 'skews' its quotes. It will lower the Sell price to encourage a trade-out and lower the Buy price to prevent further exposure."
                                },
                                {
                                    icon: <ShieldCheck className="text-emerald-400"/>,
                                    title: "Atomic Re-quoting",
                                    desc: "The moment the market moves, the server cancels stale orders and re-posts fresh ones. This 'Re-quoting' ensures we are never 'run over' by sharp price movements."
                                }
                            ].map((step, i) => (
                                <div key={i} className="flex items-start gap-6 p-6 hover:bg-white/[0.03] transition-all rounded-3xl group">
                                    <div className="mt-1">{step.icon}</div>
                                    <div className="space-y-1">
                                        <div className="text-sm font-black text-white uppercase tracking-tight group-hover:text-blue-400 transition-colors">{step.title}</div>
                                        <div className="text-[11px] text-gray-500 leading-relaxed">{step.desc}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Final CTA/Summary */}
                    <div className="p-8 rounded-[2.5rem] bg-gradient-to-br from-blue-600/20 to-transparent border border-blue-500/20 text-center">
                        <p className="text-sm font-bold text-white mb-6 italic">
                            "In summary: The server behaves like a 24/7 automated exchange, picking up pennies in front of steamrollers, but with a built-in shield of AI risk management."
                        </p>
                        <button onClick={onClose} className="px-10 py-4 bg-white text-black font-black rounded-2xl uppercase text-[10px] tracking-widest hover:scale-105 transition-all">
                            Initialize Strategy
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- Sub-Component: Reward Scoring Indicator (HFT Specific) ---
const RewardScoringBadge = ({ spread, maxSpread }: { spread: number, maxSpread?: number }) => {
  const isScoring = maxSpread ? (spread <= maxSpread) : true;
  return (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest ${
      isScoring ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-gray-500/10 text-gray-500 border border-white/5'
    }`}>
      <Cpu size={10} className={isScoring ? 'animate-pulse' : ''} />
      {isScoring ? 'Scoring Rewards' : 'Outside Band'}
    </div>
  );
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

// --- Internal Component: The Scout Card (Discovery Feed) ---
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
    <div className={`relative group glass-panel rounded-3xl border transition-all duration-300 hover:-translate-y-1 overflow-hidden ${
      holdings ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.15)]' : 'border-white/5 hover:border-blue-500/50'
    } ${isHighVol ? 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.2)]' : ''}`}>
      
      {isHighVol && (
          <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-600 text-white text-[10px] font-black px-3 py-1 rounded-full flex items-center gap-1 z-30 shadow-lg">
              <Zap className="w-3 h-3" fill="currentColor" /> 
              FLASH MOVE: {movePct}%
          </div>
      )}

      <div className="relative h-40 bg-gray-100 dark:bg-gray-900 overflow-hidden">
          {opp.image ? (
              <img
                  src={opp.image}
                  alt={opp.question}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
          ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-blue-900/20 to-black">
                  <BarChart3 className="w-12 h-12 text-gray-700" />
              </div>
          )}
          
          <div className="absolute top-2 left-2 z-30 flex flex-col gap-2">
              <button 
                onClick={(e) => { e.stopPropagation(); onBookmark(opp.marketId, !opp.isBookmarked); }}
                className={`p-2 rounded-full backdrop-blur-md transition-all ${opp.isBookmarked ? 'bg-yellow-500/20 text-yellow-500' : 'bg-black/40 text-gray-400 hover:text-white'}`}
              >
                  {isBookmarking ? <Loader2 size={14} className="animate-spin" /> : <Star size={14} fill={opp.isBookmarked ? 'currentColor' : 'none'} />}
              </button>
              <RewardScoringBadge spread={Number(spreadCents)} maxSpread={opp.rewardsMaxSpread} />
          </div>

          <div className="absolute top-2 right-2 flex items-center space-x-1 z-10">
              {opp.category && (
                  <span className="px-3 py-1 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-[9px] font-black text-gray-300 uppercase tracking-widest">
                      {opp.category}
                  </span>
              )}
          </div>

          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 z-20">
              <button
                  onClick={() => onExecute(opp)}
                  className="px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-black uppercase tracking-widest shadow-xl transition-all hover:scale-105 mb-4"
              >
                  Quick Capture
              </button>
              <a href={`https://polymarket.com/market/${opp.marketSlug || opp.marketId}`} target="_blank" className="text-[10px] text-gray-400 hover:text-white uppercase font-black tracking-widest flex items-center gap-2">
                Polymarket <ExternalLink size={10}/>
              </a>
          </div>
      </div>

      <div className="p-5 space-y-4">
          <h3 className="text-[13px] font-black text-white leading-tight line-clamp-2 h-10 tracking-tight uppercase">
              {opp.question}
          </h3>

          <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-white/[0.02] border border-white/5 rounded-2xl">
                  <p className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Spread ROI</p>
                  <p className="text-sm font-mono font-black text-blue-400">{spreadCents}¢</p>
              </div>
              <div className="p-3 bg-white/[0.02] border border-white/5 rounded-2xl">
                  <p className="text-[8px] font-black text-gray-500 uppercase tracking-widest mb-1">Liquidity</p>
                  <p className="text-sm font-mono font-black text-white">${formatCompactNumber(opp.liquidity || 0)}</p>
              </div>
          </div>

          {holdings && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-1.5">
                   <ShieldCheck size={12}/> {holdings.shares.toFixed(0)} Shares Active
                </span>
              </div>
              <InventorySkewMeter skew={holdings.inventorySkew || 0} />
            </div>
          )}

          <button
              onClick={() => onExecute(opp)}
              className={`w-full py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${
                  holdings 
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white' 
                  : 'bg-white/5 hover:bg-white text-gray-400 hover:text-black border border-white/10'
              }`}
          >
              {holdings ? 'Adjust Strategy' : 'Dispatch HFT Engine'}
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
  openOrders: any[];
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
  openOrders,
  onRefresh,
  handleExecuteMM,
  handleSyncPositions
}) => {
    const [activeCategory, setActiveCategory] = useState('all');
    const [manualId, setManualId] = useState('');
    const [scanning, setScanning] = useState(false);
    const [isBookmarking, setIsBookmarking] = useState<Record<string, boolean>>({});
    const [isExplainerOpen, setIsExplainerOpen] = useState(false);

    const filteredOpps = useMemo(() => {
        if (!moneyMarketOpps) return [];
        if (activeCategory === 'bookmarks') return moneyMarketOpps.filter(o => o.isBookmarked);
        if (activeCategory !== 'all') return moneyMarketOpps.filter(o => o.category?.toLowerCase() === activeCategory.toLowerCase());
        return moneyMarketOpps;
    }, [moneyMarketOpps, activeCategory]);

    const handleBookmark = async (marketId: string, isBookmarked: boolean) => {
        setIsBookmarking(prev => ({ ...prev, [marketId]: true }));
        try {
            await axios.post('/api/bot/mm/bookmark', { userId, marketId, isBookmarked });
            toast.success(isBookmarked ? "📌 Bookmarked" : "Removed");
            onRefresh();
        } catch (e) { toast.error("Failed"); }
        finally { setIsBookmarking(prev => ({ ...prev, [marketId]: false })); }
    };

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

    return (
                <div className="grid grid-cols-12 gap-10 pb-10 animate-in fade-in duration-700">
            <MoneyMarketExplainer isOpen={isExplainerOpen} onClose={() => setIsExplainerOpen(false)} />

            {/* Main Intelligence Discovery Layer */}
            <div className="col-span-12 lg:col-span-8 space-y-8">
                <div className="glass-panel p-8 rounded-[2.5rem] border-white/5 bg-gradient-to-br from-blue-600/[0.04] to-transparent shadow-xl relative overflow-hidden">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 relative z-10">
                        <div>
                            <h2 className="text-2xl font-black text-white uppercase tracking-tight flex items-center gap-4">
                                <Crosshair className="text-blue-500" size={28}/> Intelligence Scout
                            </h2>
                            <div className="flex items-center gap-3 mt-1.5">
                                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.4em]">v4.0.2 Institutional Node</p>
                                <button onClick={() => setIsExplainerOpen(true)} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[9px] font-black text-blue-400 uppercase tracking-widest transition-all">
                                    <Info size={12}/> How it works
                                </button>
                            </div>
                        </div>
                        <div className="flex gap-3 w-full md:w-auto">
                            <input value={manualId} onChange={(e)=>setManualId(e.target.value)} placeholder="Market ID or Slug..." className="w-full md:w-72 bg-black/40 border border-white/5 rounded-2xl px-6 py-4 text-xs font-mono text-white outline-none focus:border-blue-500/50 transition-all placeholder:text-gray-700" />
                            <button onClick={handleManualAdd} className="bg-white text-black px-8 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-gray-200 transition-all shadow-xl">
                                {scanning ? <Loader2 size={16} className="animate-spin"/> : 'Sync Intel'}
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 relative z-10">
                        {['all', 'trending', 'sports', 'crypto', 'politics'].map(cat => (
                            <button key={cat} onClick={() => setActiveCategory(cat)} className={`px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all ${activeCategory === cat ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/40' : 'bg-white/5 text-gray-500 border-white/5 hover:border-white/20'}`}>
                                {cat}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    {filteredOpps.map((opp) => (
                        <ScoutMarketCard 
                            key={opp.tokenId} 
                            opp={opp} 
                            onExecute={handleExecuteMM} 
                            onBookmark={handleBookmark} 
                            holdings={activePositions.find(p => p.marketId === opp.marketId)} 
                            isBookmarking={isBookmarking[opp.marketId]} 
                        />
                    ))}
                </div>
            </div>

            {/* PERSISTENT MONITORING SIDEBAR */}
            <div className="col-span-12 lg:col-span-4 flex flex-col gap-8">
                {/* 1. EXPOSURE HUB (Inventory Skew) */}
                <div className="glass-panel p-8 rounded-[2.5rem] border-white/5 flex flex-col shadow-2xl max-h-[600px]">
                    <div className="flex items-center justify-between mb-8">
                        <div className="space-y-1">
                            <h3 className="text-base font-black text-white uppercase tracking-tight flex items-center gap-3">
                                <Scale size={20} className="text-blue-500"/> Exposure Hub
                            </h3>
                            <p className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">Active Inventory Distribution</p>
                        </div>
                        <button onClick={handleSyncPositions} className="p-2 hover:bg-white/5 rounded-full transition-all text-gray-500 hover:text-white"><RefreshCw size={16}/></button>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar">
                        {activePositions.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-gray-700 opacity-20 py-20"><Lock size={48}/><p className="uppercase tracking-[0.2em] font-black mt-6 text-[10px]">Vault Empty</p></div>
                        ) : (
                            activePositions.map((pos, i) => (
                                <PositionCard key={i} position={pos} />
                            ))
                        )}
                    </div>
                </div>

                {/* 2. ORDER LEDGER (Live resting GTC orders) */}
                <div className="glass-panel p-8 rounded-[2.5rem] border-white/5 bg-gradient-to-br from-amber-600/5 to-transparent flex flex-col shadow-2xl h-[400px]">
                    <div className="flex items-center gap-3 mb-6">
                        <BarChart3 size={20} className="text-amber-500"/>
                        <h3 className="text-sm font-black text-white uppercase tracking-widest">Active Quotes</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar font-mono">
                        {openOrders.length === 0 ? (
                            <div className="h-full flex items-center justify-center text-gray-700 text-[10px] italic">No active resting orders...</div>
                        ) : (
                            openOrders.map((order, i) => (
                                <div key={i} className="flex items-center justify-between p-3 bg-black/40 rounded-xl border border-white/5">
                                    <div className="flex items-center gap-3">
                                        <span className={`w-1.5 h-1.5 rounded-full ${order.side === 'BUY' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                                        <div>
                                            <div className="text-[9px] text-white font-black">{order.side} {order.size}</div>
                                            <div className="text-[8px] text-gray-500">@{order.price}¢</div>
                                        </div>
                                    </div>
                                    <button onClick={async () => {
                                        await axios.post('/api/orders/cancel', { userId, orderId: order.orderID });
                                        toast.success("Order Purged");
                                    }} className="text-[8px] text-gray-600 hover:text-rose-500 uppercase font-black">Cancel</button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ProTerminal;

