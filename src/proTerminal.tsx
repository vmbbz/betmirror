
import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Crosshair, Zap, Scale, Terminal, ShieldCheck, 
  Loader2, Search, Globe, Trophy, 
  TrendingUp, ExternalLink, RefreshCw,
  Coins, Landmark, Star, BarChart3, PlusCircle, Cpu, Lock, LayoutGrid, List
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
          style={{ width: `${Math.max(5, Math.abs(skew * 50))}%`, left: isLong ? '50%' : `${50 - Math.abs(skew * 50)}%` }}
        />
      </div>
    </div>
  );
};

// --- Scout Card: The Intelligence Discovery Layer ---
const ScoutCard = ({ opp, onExecute, holdings }: { opp: ArbitrageOpportunity, onExecute: (o: any) => void, holdings?: ActivePosition }) => {
    const spreadCents = (opp.spread * 100).toFixed(1);
    const isHighVol = opp.isVolatile || (opp.lastPriceMovePct !== undefined && opp.lastPriceMovePct > 3);

    return (
        <div className={`relative group glass-panel rounded-3xl border transition-all duration-300 hover:-translate-y-1 overflow-hidden ${holdings ? 'border-emerald-500/50' : 'border-white/5 hover:border-blue-500/50'} ${isHighVol ? 'border-rose-600 shadow-[0_0_20px_rgba(225,29,72,0.1)]' : ''}`}>
            <div className="relative h-32 bg-gray-900 overflow-hidden">
                {opp.image ? <img src={opp.image} className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-all duration-700" /> : <div className="w-full h-full flex items-center justify-center bg-blue-900/10"><BarChart3 size={32} className="text-gray-700"/></div>}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"></div>
                <div className="absolute bottom-3 left-4 right-4">
                    <h3 className="text-[11px] font-black text-white leading-tight uppercase tracking-tight line-clamp-2">{opp.question}</h3>
                </div>
                <div className="absolute top-3 right-3 flex gap-1.5">
                    {opp.category && <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-[8px] font-black text-gray-300 uppercase tracking-widest">{opp.category}</span>}
                    {isHighVol && <div className="p-1 bg-rose-600 text-white rounded-full animate-pulse"><Zap size={10} fill="currentColor"/></div>}
                </div>
            </div>
            <div className="p-4 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 bg-white/[0.02] border border-white/5 rounded-xl">
                        <p className="text-[7px] font-black text-gray-500 uppercase tracking-widest mb-0.5">Spread ROI</p>
                        <p className="text-xs font-mono font-black text-blue-400">{spreadCents}¢</p>
                    </div>
                    <div className="p-2 bg-white/[0.02] border border-white/5 rounded-xl">
                        <p className="text-[7px] font-black text-gray-500 uppercase tracking-widest mb-0.5">Liquidity</p>
                        <p className="text-xs font-mono font-black text-white">${formatCompactNumber(opp.liquidity || 0)}</p>
                    </div>
                </div>
                <button onClick={() => onExecute(opp)} className={`w-full py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${holdings ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-white/5 hover:bg-white text-gray-400 hover:text-black border border-white/10'}`}>
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
  userId, activePositions, moneyMarketOpps, openOrders, isRunning, handleExecuteMM, handleSyncPositions
}) => {
    const [activeCategory, setActiveCategory] = useState('all');
    const [manualId, setManualId] = useState('');
    const [scanning, setScanning] = useState(false);

    const filteredOpps = useMemo(() => {
        if (!moneyMarketOpps) return [];
        if (activeCategory === 'all') return moneyMarketOpps;
        return moneyMarketOpps.filter(o => o.category?.toLowerCase() === activeCategory.toLowerCase());
    }, [moneyMarketOpps, activeCategory]);

    const handleManualAdd = async () => {
        if (!manualId) return;
        setScanning(true);
        try {
            const isSlug = !manualId.startsWith('0x');
            await axios.post('/api/bot/mm/add-market', { userId, [isSlug ? 'slug' : 'conditionId']: manualId });
            toast.success("✅ Intelligence Synced");
            setManualId('');
        } catch (e) { toast.error("Sync failed"); }
        finally { setScanning(false); }
    };

    return (
        <div className="grid grid-cols-12 gap-10 pb-10 animate-in fade-in duration-700">
            {/* Main Intelligence Discovery Layer */}
            <div className="col-span-12 lg:col-span-8 space-y-8">
                <div className="glass-panel p-8 rounded-[2.5rem] border-white/5 bg-gradient-to-br from-blue-600/[0.02] to-transparent shadow-xl relative overflow-hidden">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 relative z-10">
                        <div>
                            <h2 className="text-2xl font-black text-white uppercase tracking-tight flex items-center gap-4">
                                <Crosshair className="text-blue-500" size={28}/> Intelligence Scout
                            </h2>
                            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.4em] mt-1.5">v4.0.2 Institutional Node</p>
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
                        <ScoutCard key={opp.tokenId} opp={opp} onExecute={handleExecuteMM} holdings={activePositions.find(p => p.marketId === opp.marketId)} />
                    ))}
                    {filteredOpps.length === 0 && (
                        <div className="col-span-full py-40 text-center glass-panel rounded-[3rem] border-dashed border-white/10 flex flex-col items-center justify-center space-y-6 grayscale">
                            <Activity size={80} className="text-gray-800 animate-pulse"/>
                            <h3 className="text-sm font-black text-gray-700 uppercase tracking-[0.3em]">Awaiting Yield Signal Detection...</h3>
                        </div>
                    )}
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
                                <div key={i} className={`p-5 bg-white/[0.02] rounded-[1.5rem] border transition-all ${pos.managedByMM ? 'border-blue-500/30' : 'border-white/5'}`}>
                                    <div className="flex gap-4 mb-4">
                                        <div className="w-10 h-10 rounded-xl bg-gray-900 shrink-0 border border-white/5 overflow-hidden">
                                            {pos.image ? <img src={pos.image} className="w-full h-full object-cover" /> : <Activity size={18} className="m-auto text-gray-700"/>}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[10px] font-black text-white truncate leading-tight uppercase tracking-tight">{pos.question}</p>
                                            <div className="flex items-center gap-2 mt-2">
                                                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${pos.outcome === 'YES' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{pos.outcome}</span>
                                                <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1"><Zap size={10} fill="currentColor"/> MM ACTIVE</span>
                                            </div>
                                        </div>
                                    </div>
                                    <InventorySkewMeter skew={pos.inventorySkew || 0} />
                                </div>
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
