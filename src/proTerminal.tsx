import React, { useState, useMemo, useEffect } from 'react';
import { 
  Activity, Crosshair, Zap, Scale, Terminal, Trash2, ShieldCheck, 
  Loader2, PlusCircle, Search, Star, Globe, Trophy, 
  TrendingUp, Settings, Lock, LayoutDashboard, 
  ArrowUpCircle, ArrowDownCircle, ExternalLink, RefreshCw,
  Coins, LineChart, Timer, BarChart4, Cpu
} from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { toast } from 'react-toastify';
import axios from 'axios';
import { ActivePosition } from './domain/trade.types.js';
import { ArbitrageOpportunity } from './adapters/interfaces.js';
import { UserStats } from './domain/user.types.js';

type TabValue = "dashboard" | "money-market" | "marketplace" | "history" | "vault" | "bridge" | "system" | "help";

// Format numbers to compact form (1K, 1M, 1B, etc.)
const formatCompactNumber = (num: number): string => {
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
  return (num / 1000000000).toFixed(1) + 'B';
};

// --- Sub-Component: Inventory Skew Meter (MM Intelligence) ---
const InventorySkewMeter = ({ skew }: { skew: number }) => {
  const isLong = skew >= 0;
  return (
    <div className="space-y-2 mt-3">
      <div className="flex justify-between text-[10px] font-black uppercase tracking-tighter">
        <span className="text-gray-500">Inventory Skew</span>
        <span className={isLong ? 'text-emerald-500' : 'text-rose-500'}>
          {isLong ? 'YES' : 'NO'} {Math.abs(skew * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/20 z-10"></div>
        <div 
          className={`h-full transition-all duration-700 ${isLong ? 'bg-emerald-500' : 'bg-rose-500'}`}
          style={{ 
            width: `${Math.max(5, Math.abs(skew * 50))}%`, 
            left: isLong ? '50%' : `${50 - Math.abs(skew * 50)}%` 
          }}
        />
      </div>
    </div>
  );
};

// --- Sub-Component: Enhanced Sidebar Opportunity Card ---
const SidebarOpportunityCard = ({ opp, onExecute, holdings }: any) => {
    const spreadCents = (opp.spread * 100).toFixed(1);
    return (
        <div 
            onClick={() => onExecute(opp)}
            className={`flex items-center gap-4 p-4 bg-black/40 rounded-2xl border transition-all cursor-pointer group ${
                holdings ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-white/5 hover:border-blue-500/40 hover:bg-white/5'
            }`}
        >
            <div className="w-12 h-12 rounded-xl bg-gray-900 border border-white/5 overflow-hidden shrink-0">
                <img src={opp.image} className="w-full h-full object-cover grayscale-[50%] group-hover:grayscale-0 transition-all" />
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-white truncate uppercase tracking-tight leading-tight mb-1">{opp.question}</p>
                <p className="text-[10px] font-black text-blue-500 font-mono">{spreadCents}¢ Spread</p>
            </div>
            {holdings && <ShieldCheck size={18} className="text-emerald-500"/>}
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
  isRunning,
  onRefresh,
  handleExecuteMM,
  handleSyncPositions,
  openDepositModal,
  openWithdrawModal,
  setActiveTab
}) => {
  const [activeCategory, setActiveCategory] = useState('all');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastHftPulse, setLastHftPulse] = useState(Date.now());

  useEffect(() => {
    if (logs.length > 0 && logs[0].message.includes('FILLED')) {
      setLastHftPulse(Date.now());
    }
  }, [logs]);

  const filteredOpps = useMemo(() => {
    if (activeCategory === 'all') return moneyMarketOpps;
    return moneyMarketOpps.filter((o: any) => o.category?.toLowerCase() === activeCategory.toLowerCase());
  }, [moneyMarketOpps, activeCategory]);

  const handlePhysicalRefresh = async () => {
    setIsRefreshing(true);
    try {
      await axios.post('/api/bot/refresh', { userId });
      await onRefresh();
      toast.success("HFT Scan Complete");
    } catch (e) {
      toast.error("Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="grid grid-cols-12 gap-8 h-full animate-in fade-in duration-700">
      
      {/* LEFT COLUMN: Portfolio Intelligence & Terminal Logs */}
      <div className="col-span-12 lg:col-span-8 flex flex-col gap-8">
        
        {/* Performance Dashboard */}
        <div className="glass-panel p-10 rounded-[3rem] border-white/5 relative overflow-hidden shadow-2xl bg-gradient-to-br from-black to-blue-900/10">
          <div className="absolute top-0 right-0 p-12 opacity-[0.03] text-blue-500 pointer-events-none">
            <TrendingUp size={300} />
          </div>

          <div className="flex justify-between items-center mb-12">
            <div className="space-y-2">
              <h2 className="text-2xl font-black text-white uppercase tracking-tighter flex items-center gap-3">
                <LayoutDashboard size={24} className="text-blue-500"/> Institutional Terminal
              </h2>
              <div className="flex items-center gap-4">
                <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">
                  Bot Engine: <span className={isRunning ? 'text-emerald-500' : 'text-gray-600'}>{isRunning ? 'ACTIVE' : 'STANDBY'}</span>
                </p>
                {isRunning && (
                  <div className="flex items-center gap-2">
                    <div key={lastHftPulse} className="w-2 h-2 rounded-full bg-blue-500 animate-ping"></div>
                    <span className="text-[10px] font-black text-blue-500 uppercase">HFT Pulse</span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-3">
               <button 
                onClick={handlePhysicalRefresh}
                disabled={isRefreshing}
                className="p-4 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/10 transition-all group"
              >
                <RefreshCw size={22} className={`${isRefreshing ? 'animate-spin text-blue-500' : 'text-gray-400 group-hover:text-white'}`} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-10 relative z-10">
            <div className="p-8 bg-white/[0.02] border border-white/5 rounded-[2.5rem] group hover:border-blue-500/20 transition-colors">
              <span className="text-[11px] font-black text-gray-500 uppercase tracking-widest mb-3 block">Total Liquidity</span>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-black text-white font-mono tracking-tighter">
                  ${stats?.portfolioValue.toLocaleString() || '0.00'}
                </span>
              </div>
            </div>

            <div className="p-8 bg-white/[0.02] border border-white/5 rounded-[2.5rem] group hover:border-emerald-500/20 transition-colors">
              <span className="text-[11px] font-black text-emerald-500/50 uppercase tracking-widest mb-3 block flex items-center gap-2">
                Realized Alpha <Trophy size={12}/>
              </span>
              <div className="flex items-baseline gap-2">
                <span className={`text-4xl font-black font-mono tracking-tighter ${stats?.totalPnl && stats.totalPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  ${Math.abs(stats?.totalPnl || 0).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="p-8 bg-white/[0.02] border border-white/5 rounded-[2.5rem] group hover:border-blue-500/20 transition-colors">
              <span className="text-[11px] font-black text-gray-500 uppercase tracking-widest mb-3 block">Vault Cash</span>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-black text-white font-mono tracking-tighter">
                  ${stats?.cashBalance.toFixed(2) || '0.00'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-6 mt-12">
            <button onClick={openDepositModal} className="flex-1 py-4 bg-blue-600 hover:bg-blue-700 text-white font-black text-[12px] uppercase tracking-widest rounded-[1.5rem] transition-all shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2">
              <ArrowDownCircle size={18}/> Add Capital
            </button>
            <button onClick={openWithdrawModal} className="flex-1 py-4 bg-white/5 hover:bg-white/10 text-white font-black text-[12px] uppercase tracking-widest rounded-[1.5rem] border border-white/10 transition-all flex items-center justify-center gap-2">
              <ArrowUpCircle size={18}/> Liquidate
            </button>
          </div>
        </div>

        {/* Execution Terminal (Logs) */}
        <div className="flex-1 glass-panel rounded-[3rem] border-white/5 overflow-hidden flex flex-col min-h-[450px]">
          <div className="px-8 py-6 border-b border-white/5 bg-black/40 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <Terminal size={20} className="text-blue-500"/>
              <span className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em]">HFT Execution Pulse</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-8 space-y-2.5 font-mono text-[11px] bg-black/20 custom-scrollbar">
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-700 opacity-20 space-y-6">
                <Activity size={64}/>
                <p className="uppercase tracking-[0.4em] font-black text-sm">Awaiting WebSocket Signals...</p>
              </div>
            ) : (
              logs.map((log: any) => (
                <div key={log.id} className="flex gap-4 animate-in fade-in slide-in-from-left-2 duration-300">
                  <span className="text-gray-600 shrink-0">[{log.time}]</span>
                  <span className={`${
                    log.type === 'error' ? 'text-rose-500' : 
                    log.type === 'warn' ? 'text-amber-500' : 
                    log.type === 'success' ? 'text-emerald-500' : 'text-blue-300'
                  }`}>
                    {log.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: Exposure & Discovery */}
      <div className="col-span-12 lg:col-span-4 flex flex-col gap-8">
        
        {/* Active Risk Exposure */}
        <div className="glass-panel p-10 rounded-[3rem] border-white/5 flex-1 flex flex-col shadow-2xl max-h-[600px]">
          <div className="flex items-center justify-between mb-10">
            <div className="space-y-1.5">
              <h3 className="text-base font-black text-white uppercase tracking-tight flex items-center gap-3">
                <Scale size={20} className="text-blue-500"/> Exposure Hub
              </h3>
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Live Inventory Positions</p>
            </div>
            <button onClick={handleSyncPositions} className="p-3 hover:bg-white/5 rounded-full transition-colors text-gray-500 hover:text-white">
              <RefreshCw size={18}/>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-5 pr-2 custom-scrollbar">
            {activePositions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-700 opacity-20 space-y-6">
                <Lock size={64}/>
                <p className="uppercase tracking-[0.2em] font-black text-center text-[11px]">No active inventory<br/>in vault</p>
              </div>
            ) : (
              activePositions.map((pos: ActivePosition) => {
                const value = (pos.currentPrice || pos.entryPrice) * pos.shares;
                const cost = pos.entryPrice * pos.shares;
                const pnl = value - cost;
                const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
                
                return (
                  <div key={pos.marketId + pos.outcome} className={`p-5 bg-white/[0.02] rounded-[1.5rem] border transition-all hover:border-blue-500/40 ${
                    pos.managedByMM ? 'border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.1)]' : 'border-white/5'
                  }`}>
                    <div className="flex gap-4 mb-4">
                      <div className="w-12 h-12 rounded-xl bg-gray-900 shrink-0 border border-white/5 overflow-hidden flex items-center justify-center">
                        {pos.image ? <img src={pos.image} className="w-full h-full object-cover" /> : <Activity size={20} className="text-gray-700"/>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-black text-white truncate leading-tight uppercase tracking-tight">
                          {pos.question}
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${
                            pos.outcome === 'YES' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                          }`}>
                            {pos.outcome}
                          </span>
                          {pos.managedByMM && (
                             <span className="text-[9px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1.5">
                                <Zap size={10} fill="currentColor"/> MM Active
                             </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {pos.managedByMM && <InventorySkewMeter skew={pos.inventorySkew || 0} />}

                    <div className="grid grid-cols-2 gap-6 mt-5 border-t border-white/5 pt-4">
                      <div>
                        <p className="text-[9px] font-black text-gray-600 uppercase mb-1">Valuation</p>
                        <p className="text-sm font-mono font-black text-white">${value.toFixed(2)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] font-black text-gray-600 uppercase mb-1">Performance</p>
                        <p className={`text-sm font-mono font-black ${pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Global Discovery Engine */}
        <div className="glass-panel p-10 rounded-[3rem] border-white/5 bg-gradient-to-br from-blue-600/5 to-transparent flex-1">
          <div className="flex items-center justify-between mb-10">
            <div className="space-y-1.5">
              <h3 className="text-base font-black text-white uppercase tracking-tight flex items-center gap-3">
                <Crosshair size={20} className="text-blue-500"/> Opportunity Scout
              </h3>
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Yield Captured Markets</p>
            </div>
          </div>
          <div className="space-y-4 overflow-y-auto h-[400px] custom-scrollbar pr-2">
            {filteredOpps.length === 0 ? (
               <div className="h-full flex items-center justify-center text-gray-500 text-xs italic">Seeking high-yield spreads...</div>
            ) : (
              filteredOpps.slice(0, 20).map((opp: ArbitrageOpportunity) => {
                const holdings = activePositions.find(p => p.marketId === opp.marketId);
                return (
                  <SidebarOpportunityCard 
                    key={opp.tokenId} 
                    opp={opp} 
                    onExecute={handleExecuteMM} 
                    holdings={holdings} 
                  />
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