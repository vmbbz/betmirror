import React, { useState, useEffect } from 'react';
import { 
    Activity, 
    Sword, 
    Zap, 
    ShieldCheck, 
    ExternalLink, 
    TrendingUp, 
    Clock, 
    Target, 
    Loader2, 
    Radar, 
    Flame, 
    Info,
    TrendingDown, 
    Timer, 
    BarChart3, 
    ChevronRight,
    Settings
} from 'lucide-react';

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
    marketSlug?: string;
    riskScore: number;
    strategy: string;
}

interface FlashMoveServiceStatus {
    isEnabled: boolean;
    activePositions: number;
    totalExecuted: number;
    successRate: number;
    lastDetection: Date | null;
    portfolioRisk: any;
}

const FlashMoveCard = ({ move }: { move: FlashMoveData }) => {
    const isUp = move.velocity > 0;
    const velocityPct = Math.abs(move.velocity * 100).toFixed(1);
    const confidencePct = Math.abs(move.confidence * 100).toFixed(0);

    return (
        <div className="relative group animate-in fade-in slide-in-from-bottom-2 duration-500 w-full">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-rose-500 to-orange-500 rounded-[1.5rem] blur opacity-20 group-hover:opacity-40 transition-opacity"></div>
            <div className="glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/90 overflow-hidden relative flex flex-col h-full shadow-xl">
                <div className="p-4 flex items-center justify-between border-b border-white/5 bg-white/[0.02]">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-rose-500/20 flex items-center justify-center text-rose-500">
                            <Zap size={14} fill="currentColor" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[9px] font-black text-rose-400 uppercase tracking-widest leading-none">Flash Move</p>
                            <p className="text-[8px] text-slate-500 font-mono mt-0.5">{(new Date(move.timestamp)).toLocaleTimeString()}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-rose-500/10 rounded-full border border-rose-500/20">
                        <TrendingUp size={10} className="text-rose-400"/>
                        <span className="text-[10px] font-black text-rose-400">{velocityPct}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="text-xs text-slate-500 uppercase">Confidence</div>
                        <div className="text-xs font-mono text-slate-400">{confidencePct}%</div>
                    </div>
                </div>
                
                <div className="p-5 flex-1">
                    <h4 className="text-sm font-bold text-white mb-4 line-clamp-2 leading-snug h-10">{move.question || 'Unknown Market'}</h4>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="bg-black/30 p-3 rounded-xl border border-white/5">
                            <p className="text-[8px] font-bold text-slate-500 uppercase mb-1">Baseline</p>
                            <p className="text-lg font-mono font-bold text-slate-400">${move.oldPrice.toFixed(3)}</p>
                        </div>
                        <div className="bg-rose-500/10 p-3 rounded-xl border border-rose-500/20">
                            <p className="text-[8px] font-bold text-rose-500 uppercase mb-1">Spike</p>
                            <p className="text-lg font-mono font-bold text-white">${move.newPrice.toFixed(3)}</p>
                        </div>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className="bg-black/30 p-2 rounded-lg border border-white/5">
                            <div className="text-slate-500 uppercase">Strategy</div>
                            <div className="text-white font-mono">{move.strategy}</div>
                        </div>
                        <div className="bg-black/30 p-2 rounded-lg border border-white/5">
                            <div className="text-slate-500 uppercase">Risk Score</div>
                            <div className="text-white font-mono">{move.riskScore.toFixed(0)}</div>
                        </div>
                        <div className="bg-black/30 p-2 rounded-lg border border-white/5">
                            <div className="text-slate-500 uppercase">Token ID</div>
                            <div className="text-white font-mono text-xs">{move.tokenId.slice(0, 8)}...</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const FlashMoveServiceStatusCard = ({ status }: { status: FlashMoveServiceStatus }) => {
    return (
        <div className="glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/90 p-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Radar className="w-5 h-5" />
                    Flash Move Service Status
                </h3>
                <div className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    status.isEnabled 
                        ? 'bg-green-500 text-white' 
                        : 'bg-red-500 text-white'
                }`}>
                    {status.isEnabled ? 'ACTIVE' : 'INACTIVE'}
                </div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                    <div className="text-2xl font-bold text-white mb-1">{status.activePositions}</div>
                    <div className="text-xs text-slate-500 uppercase">Active Positions</div>
                </div>
                
                <div className="text-center">
                    <div className="text-2xl font-bold text-white mb-1">{status.totalExecuted}</div>
                    <div className="text-xs text-slate-500 uppercase">Total Executed</div>
                </div>
                
                <div className="text-center">
                    <div className="text-2xl font-bold text-white mb-1">{(status.successRate * 100).toFixed(1)}%</div>
                    <div className="text-xs text-slate-500 uppercase">Success Rate</div>
                </div>
                
                <div className="text-center">
                    <div className="text-2xl font-bold text-white mb-1">{status.portfolioRisk?.totalExposure || 0}</div>
                    <div className="text-xs text-slate-500 uppercase">Portfolio Risk</div>
                </div>
                
                <div className="text-center">
                    <div className="text-sm font-semibold text-white mb-1">
                        {status.lastDetection ? (new Date(status.lastDetection)).toLocaleTimeString() : 'Never'}
                    </div>
                    <div className="text-xs text-slate-500 uppercase">Last Detection</div>
                </div>
            </div>
        </div>
    );
};

export const FlashMoveDashboard = () => {
    const [flashMoves, setFlashMoves] = useState<FlashMoveData[]>([]);
    const [serviceStatus, setServiceStatus] = useState<FlashMoveServiceStatus | null>(null);
    const [selectedStrategy, setSelectedStrategy] = useState<'default' | 'conservative' | 'aggressive'>('default');

    useEffect(() => {
        // Simulate real-time updates
        const interval = setInterval(() => {
            // This would connect to the actual WebSocket events
            // For demo, we'll simulate some data
            const mockMove: FlashMoveData = {
                tokenId: '0x1234567890abcdef',
                conditionId: '0xabcdef1234567890',
                oldPrice: 0.45,
                newPrice: 0.52,
                velocity: 0.156,
                confidence: 0.85,
                timestamp: Date.now(),
                question: 'Will Bitcoin reach $100k by end of year?',
                image: '',
                marketSlug: 'btc-price-prediction',
                riskScore: 42,
                strategy: 'momentum'
            };
            
            setFlashMoves(prev => [mockMove, ...prev.slice(0, 9)]);
            
            // Mock service status
            setServiceStatus({
                isEnabled: true,
                activePositions: 3,
                totalExecuted: 127,
                successRate: 0.73,
                lastDetection: new Date(),
                portfolioRisk: { totalExposure: 2500 }
            });
        }, 2000);

        return () => clearInterval(interval);
    }, []);

    return (
        <div className="min-h-screen bg-slate-950 p-6">
            <div className="max-w-7xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                    <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                        <Flame className="w-8 h-8 text-orange-500" />
                        Flash Move Dashboard
                    </h1>
                    
                    <div className="flex items-center gap-4">
                        <div className="relative">
                            <select 
                                value={selectedStrategy}
                                onChange={(e) => setSelectedStrategy(e.target.value as any)}
                                className="bg-slate-800 text-white border border-slate-700 rounded-lg px-4 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-orange-500 appearance-none"
                            >
                                <option value="default">Default Strategy</option>
                                <option value="conservative">Conservative</option>
                                <option value="aggressive">Aggressive</option>
                            </select>
                            <Settings className="absolute right-3 top-3 w-4 h-4 text-slate-400" />
                        </div>
                    </div>
                </div>

                {serviceStatus && (
                    <FlashMoveServiceStatusCard status={serviceStatus} />
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="lg:col-span-2">
                        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                            <Activity className="w-6 h-6" />
                            Recent Flash Moves
                        </h2>
                        
                        <div className="space-y-4">
                            {flashMoves.length === 0 ? (
                                <div className="glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/90 p-8 text-center">
                                    <div className="text-slate-500 mb-4">
                                        <Radar className="w-12 h-12 mx-auto text-slate-600" />
                                    </div>
                                    <p className="text-white">No flash moves detected yet</p>
                                    <p className="text-sm text-slate-400 mt-2">
                                        Flash moves will appear here when significant price movements are detected.
                                        The system monitors velocity, momentum, and volume spikes across all markets.
                                    </p>
                                </div>
                            ) : (
                                flashMoves.map((move, index) => (
                                    <FlashMoveCard key={`${move.tokenId}-${index}`} move={move} />
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
