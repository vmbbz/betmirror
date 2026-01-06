import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Crosshair, Zap, Scale, Terminal, Trash2, ShieldCheck, 
  Loader2, Search, Globe, Trophy, 
  TrendingUp, ExternalLink, RefreshCw,
  Coins, Landmark, Star, BarChart3, PlusCircle, Cpu
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

const InventorySkewMeter = ({ skew }: { skew: number }) => {
  const isLong = skew >= 0;
  return (
    <div className="space-y-2 mt-4 bg-black/40 p-3 rounded-xl border border-white/5">
      <div className="flex justify-between text-[8px] font-black uppercase tracking-widest">
        <span className="text-gray-500">Skew</span>
        <span className={isLong ? 'text-emerald-500' : 'text-rose-500'}>
          {isLong ? 'YES' : 'NO'} {Math.abs(skew * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-1 bg-white/10 rounded-full overflow-hidden relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20 z-10"></div>
        <div 
          className={`h-full transition-all duration-700 ${isLong ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]'}`}
          style={{ 
            width: `${Math.max(5, Math.abs(skew * 50))}%`, 
            left: isLong ? '50%' : `${50 - Math.abs(skew * 50)}%` 
          }}
        />
      </div>
    </div>
  );
};

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
  handleExecuteMM
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
            toast.success("✅ HFT Intelligence Synced");
            setManualId('');
            onRefresh(true);
        } catch (e) { toast.error("Sync failed"); }
        finally { setScanning(false); }
    };

    const handleBookmark = async (marketId: string, isBookmarked: boolean) => {
        if (!userId) { toast.error('Please connect wallet'); return; }
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
        <div className="space-y-12 animate-in fade-in duration-1000 pb-20">
            {/* Portfolio Overview - Hero Block */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="glass-panel p-8 rounded-[2rem] border-white/5 bg-gradient-to-br from-black to-blue-900/20">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Total Equity</p>
                <h2 className="text-3xl font-black text-white font-mono">${stats?.portfolioValue.toLocaleString() || '0.00'}</h2>
              </div>
              <div className="glass-panel p-8 rounded-[2rem] border-white/5 bg-gradient-to-br from-black to-emerald-900/20">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Realized Alpha</p>
                <h2 className={`text-3xl font-black font-mono ${stats?.totalPnl && stats.totalPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  ${stats?.totalPnl?.toFixed(2) || '0.00'}
                </h2>
              </div>
              <div className="glass-panel p-8 rounded-[2rem] border-white/5 bg-gradient-to-br from-black to-amber-900/20">
                <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">Vault Cash</p>
                <h2 className="text-3xl font-black text-white font-mono">${stats?.cashBalance.toFixed(2) || '0.00'}</h2>
              </div>
            </div>

            {/* Intelligence Scout Header */}
            <div className="glass-panel p-12 rounded-[3.5rem] border-white/5 bg-gradient-to-br from-blue-600/[0.03] to-transparent shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-12 opacity-[0.02] text-blue-500 pointer-events-none">
                    <Crosshair size={300} />
                </div>
                <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-10 mb-12 relative z-10">
                    <div>
                        <h2 className="text-5xl font-black text-white uppercase tracking-tighter flex items-center gap-6">
                            <Crosshair className="text-blue-500" size={56}/> Intelligence Scout
                        </h2>
                        <div className="flex items-center gap-6 mt-4 ml-1">
                            <p className="text-xs text-gray-500 font-bold uppercase tracking-[0.5em]">Autonomous Yield Capture Protocol v4.0</p>
                            <div className="flex items-center gap-2">
                                <div key={lastHftPulse} className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-ping"></div>
                                <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest">HFT Heartbeat</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex gap-4 w-full lg:w-auto">
                        <div className="relative flex-1 lg:w-[400px]">
                            <input value={manualId} onChange={(e)=>setManualId(e.target.value)} placeholder="Sync Market ID or Slug..." className="w-full bg-black/40 border border-white/5 rounded-[1.5rem] px-8 py-5 text-xs font-mono text-white outline-none focus:border-blue-500/50 transition-all placeholder:text-gray-700"/>
                            <Search className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-700" size={20}/>
                        </div>
                        <button onClick={handleManualAdd} className="bg-white text-black px-10 py-5 rounded-[1.5rem] text-[11px] font-black uppercase tracking-widest hover:scale-105 transition-all shadow-2xl shadow-blue-500/10">
                            {scanning ? <Loader2 size={20} className="animate-spin"/> : <PlusCircle size={20} className="inline mr-2" />}
                            Sync Intelligence
                        </button>
                    </div>
                </div>
                <div className="flex items-center gap-3 overflow-x-auto no-scrollbar pb-2 relative z-10">
                    {[
                        { id: 'all', label: 'All Discovery', icon: <Globe size={14}/> },
                        { id: 'trending', label: 'Trending', icon: <TrendingUp size={14}/> },
                        { id: 'sports', label: 'Sports', icon: <Trophy size={14}/> },
                        { id: 'crypto', label: 'Crypto', icon: <Coins size={14}/> },
                        { id: 'politics', label: 'Politics', icon: <Landmark size={14}/> },
                        { id: 'bookmarks', label: 'Bookmarks', icon: <Star size={14}/> }
                    ].map(cat => (
                        <button key={cat.id} onClick={() => setActiveCategory(cat.id)} className={`flex items-center gap-3 px-6 py-3 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all whitespace-nowrap ${activeCategory === cat.id ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/40' : 'bg-white/5 text-gray-500 border-white/5 hover:border-white/20'}`}>
                            {cat.icon} {cat.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Grid Display */}
            {filteredOpps.length === 0 ? (
                <div className="py-48 text-center glass-panel rounded-[4rem] border-dashed border-white/10 flex flex-col items-center justify-center space-y-8 grayscale">
                    <Activity size={80} className="text-gray-800 animate-pulse"/>
                    <h3 className="text-2xl font-black text-gray-700 uppercase tracking-widest">No Signals in Category: {activeCategory}</h3>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
                    {filteredOpps.map((opp: any) => {
                        const holdings = activePositions.find(p => p.marketId === opp.marketId);
                        return (
                            <ScoutMarketCard key={opp.tokenId} opp={opp} onExecute={handleExecuteMM} onBookmark={handleBookmark} holdings={holdings} isBookmarking={isBookmarking[opp.marketId]}/>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default ProTerminal;
