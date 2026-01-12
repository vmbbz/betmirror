import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// DO add comment above each fix.
import { useState, useRef, useEffect } from 'react';
import { Sword, Zap, TrendingUp, Target, Loader2, Radar, Flame, Info } from 'lucide-react';
const FlashCard = ({ move }) => {
    const isUp = move.velocity > 0;
    const velocityPct = Math.abs(move.velocity * 100).toFixed(1);
    return (_jsxs("div", { className: "relative group animate-in fade-in slide-in-from-bottom-2 duration-500 w-full", children: [_jsx("div", { className: "absolute -inset-0.5 bg-gradient-to-r from-rose-500 to-orange-500 rounded-[1.5rem] blur opacity-20 group-hover:opacity-40 transition-opacity" }), _jsxs("div", { className: "glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/90 overflow-hidden relative flex flex-col h-full shadow-xl", children: [_jsxs("div", { className: "p-4 flex items-center justify-between border-b border-white/5 bg-white/[0.02]", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "w-8 h-8 rounded-full bg-rose-500/20 flex items-center justify-center text-rose-500", children: _jsx(Zap, { size: 14, fill: "currentColor" }) }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-[9px] font-black text-rose-400 uppercase tracking-widest leading-none", children: "Flash Move" }), _jsx("p", { className: "text-[8px] text-slate-500 font-mono mt-0.5", children: (new Date(move.timestamp)).toLocaleTimeString() })] })] }), _jsxs("div", { className: "flex items-center gap-1.5 px-2 py-0.5 bg-rose-500/10 rounded-full border border-rose-500/20", children: [_jsx(TrendingUp, { size: 10, className: "text-rose-400" }), _jsxs("span", { className: "text-[10px] font-black text-rose-400", children: [velocityPct, "%"] })] })] }), _jsxs("div", { className: "p-5 flex-1", children: [_jsx("h4", { className: "text-sm font-bold text-white mb-4 line-clamp-2 leading-snug h-10", children: move.question || 'Unknown Market' }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "bg-black/30 p-3 rounded-xl border border-white/5", children: [_jsx("p", { className: "text-[8px] font-bold text-slate-500 uppercase mb-1", children: "Baseline" }), _jsxs("p", { className: "text-lg font-mono font-bold text-slate-400", children: ["$", move.oldPrice.toFixed(2)] })] }), _jsxs("div", { className: "bg-rose-500/10 p-3 rounded-xl border border-rose-500/20", children: [_jsx("p", { className: "text-[8px] font-bold text-rose-500 uppercase mb-1", children: "Spike" }), _jsxs("p", { className: "text-lg font-mono font-bold text-white", children: ["$", move.newPrice.toFixed(2)] })] })] })] }), _jsx("div", { className: "px-5 pb-5", children: _jsxs("button", { className: "w-full py-3 bg-white text-black rounded-xl font-black text-[10px] uppercase tracking-[0.2em] hover:scale-[1.02] transition-transform flex items-center justify-center gap-2 shadow-lg", children: [_jsx(Sword, { size: 14 }), " Execute Entry"] }) })] })] }));
};
const SnipeCard = ({ snipe }) => {
    const roi = ((snipe.currentPrice - snipe.entryPrice) / snipe.entryPrice) * 100;
    const isProfit = roi >= 0;
    return (_jsxs("div", { className: "glass-panel rounded-[1.5rem] border-white/5 bg-slate-900/60 p-5 space-y-4 border-l-4 border-l-emerald-500", children: [_jsxs("div", { className: "flex justify-between items-start gap-4", children: [_jsx("h4", { className: "text-xs font-bold text-white leading-snug line-clamp-1", children: snipe.question || 'FOMO Snipe' }), _jsxs("div", { className: `px-2 py-0.5 rounded-lg font-mono font-black text-[10px] ${isProfit ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`, children: [isProfit ? '+' : '', roi.toFixed(2), "%"] })] }), _jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsxs("div", { className: "bg-black/20 p-2 rounded-xl text-center", children: [_jsx("p", { className: "text-[7px] font-bold text-slate-500 uppercase mb-1", children: "Entry" }), _jsxs("p", { className: "text-xs font-mono font-bold text-white", children: ["$", snipe.entryPrice.toFixed(2)] })] }), _jsxs("div", { className: "bg-black/20 p-2 rounded-xl text-center", children: [_jsx("p", { className: "text-[7px] font-bold text-slate-500 uppercase mb-1", children: "Current" }), _jsxs("p", { className: "text-xs font-mono font-bold text-white", children: ["$", snipe.currentPrice.toFixed(2)] })] }), _jsxs("div", { className: "bg-emerald-500/5 p-2 rounded-xl text-center border border-emerald-500/10", children: [_jsx("p", { className: "text-[7px] font-bold text-emerald-500 uppercase mb-1", children: "Target" }), _jsxs("p", { className: "text-xs font-mono font-bold text-emerald-400", children: ["$", snipe.targetPrice.toFixed(2)] })] })] }), _jsx("div", { className: "flex items-center gap-2", children: _jsx("button", { className: "flex-1 py-2 bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 text-[9px] font-black uppercase rounded-lg transition-colors border border-rose-500/20", children: "Emergency Exit" }) })] }));
};
const FomoRunner = ({ flashMoves: propFlashMoves = [], activeSnipes: propActiveSnipes = [] }) => {
    const [isLoading, setIsLoading] = useState(true);
    const [isConnected, setIsConnected] = useState(false);
    const [socket, setSocket] = useState(null);
    const [activeTab, setActiveTab] = useState('scanner');
    const [wsFlashMoves, setWsFlashMoves] = useState([]);
    const prevFlashMovesCount = useRef(0);
    const notificationSound = useRef(null);
    // Ensure we always have arrays, even if props are undefined/null
    const propFlashMovesArray = Array.isArray(propFlashMoves) ? propFlashMoves : [];
    const activeSnipes = Array.isArray(propActiveSnipes) ? propActiveSnipes : [];
    // Combine prop-based and WebSocket-based flash moves
    const flashMoves = [...propFlashMovesArray, ...wsFlashMoves];
    // Initialize audio
    useEffect(() => {
        notificationSound.current = new Audio('/sounds/new-notification-011-364050.mp3');
        notificationSound.current.volume = 0.5; // Set volume to 50%
        return () => {
            if (notificationSound.current) {
                notificationSound.current.pause();
                notificationSound.current = null;
            }
        };
    }, []);
    // Play sound when new flash moves are detected
    useEffect(() => {
        const currentCount = flashMoves.length;
        if (currentCount > 0 && currentCount > prevFlashMovesCount.current) {
            if (notificationSound.current) {
                notificationSound.current.currentTime = 0;
                notificationSound.current.play().catch(e => console.error('Error playing notification sound:', e));
            }
        }
        prevFlashMovesCount.current = currentCount;
    }, [flashMoves.length]);
    useEffect(() => {
        const connectWebSocket = () => {
            try {
                const ws = new WebSocket('wss://betmirror.bet/socket.io/');
                ws.onopen = () => {
                    console.log('WebSocket connected');
                    setIsConnected(true);
                    setIsLoading(false);
                };
                ws.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        // Safely handle different message formats
                        let fomoMoves = [];
                        // Handle different possible message structures
                        if (Array.isArray(message?.data?.fomoMoves)) {
                            fomoMoves = message.data.fomoMoves;
                        }
                        else if (Array.isArray(message?.fomoMoves)) {
                            fomoMoves = message.fomoMoves;
                        }
                        else if (message?.data && typeof message.data === 'object' && 'fomoMoves' in message.data) {
                            fomoMoves = Array.isArray(message.data.fomoMoves) ? message.data.fomoMoves : [];
                        }
                        // Validate and update state
                        if (Array.isArray(fomoMoves)) {
                            const validMoves = fomoMoves.filter(move => move &&
                                typeof move === 'object' &&
                                'tokenId' in move &&
                                'velocity' in move);
                            setWsFlashMoves(validMoves);
                        }
                    }
                    catch (error) {
                        console.error('Error processing WebSocket message:', error);
                    }
                };
                ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    setIsConnected(false);
                    setIsLoading(false);
                };
                ws.onclose = () => {
                    console.log('WebSocket disconnected');
                    setIsConnected(false);
                    setIsLoading(false);
                    // Attempt to reconnect after a delay
                    setTimeout(connectWebSocket, 3000);
                };
                setSocket(ws);
            }
            catch (error) {
                console.error('WebSocket connection error:', error);
                setIsLoading(false);
                // Retry connection after a delay
                setTimeout(connectWebSocket, 5000);
            }
        };
        connectWebSocket();
        // Cleanup function
        return () => {
            if (socket) {
                socket.close();
            }
        };
    }, []);
    const heat = flashMoves.length > 5 ? 'EXTREME' : flashMoves.length > 0 ? 'HIGH' : 'STABLE';
    return (_jsxs("div", { className: "space-y-6 md:space-y-10 animate-in fade-in duration-700 px-0 md:px-4", children: [_jsxs("div", { className: "flex flex-col md:flex-row justify-between items-center gap-6 px-4 md:px-0", children: [_jsxs("div", { className: "space-y-2 text-center md:text-left", children: [_jsxs("div", { className: "flex items-center justify-center md:justify-start gap-3", children: [_jsx("div", { className: "p-2 bg-rose-600 rounded-xl shadow-lg shadow-rose-900/30", children: _jsx(Flame, { className: "text-white", size: 24 }) }), _jsxs("h2", { className: "text-2xl md:text-5xl font-black text-white uppercase tracking-tighter italic leading-none", children: ["FOMO ", _jsx("span", { className: "text-rose-600", children: "RUNNER" })] })] }), _jsx("p", { className: "text-[8px] md:text-xs text-slate-500 font-bold uppercase tracking-[0.4em] ml-1", children: "Velocity Liquidity Sniper v2.1" })] }), _jsxs("div", { className: "w-full md:w-auto bg-slate-900/60 p-4 rounded-2xl border border-white/10 flex items-center justify-between md:justify-start gap-6 md:gap-8 backdrop-blur-md", children: [_jsxs("div", { className: "text-center md:text-left", children: [_jsx("p", { className: "text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-1", children: "Global Heat" }), _jsx("p", { className: `text-sm md:text-xl font-black font-mono ${heat === 'EXTREME' ? 'text-rose-500 animate-pulse' : 'text-orange-400'}`, children: heat })] }), _jsx("div", { className: "w-px h-8 md:h-10 bg-white/10" }), _jsxs("div", { className: "text-center md:text-left", children: [_jsx("p", { className: "text-[8px] font-bold text-slate-500 uppercase tracking-widest mb-1", children: "Active Snipes" }), _jsx("p", { className: "text-sm md:text-xl font-black text-white font-mono", children: activeSnipes.length })] })] })] }), _jsxs("div", { className: "flex gap-2 px-4 md:px-0", children: [_jsxs("button", { onClick: () => setActiveTab('scanner'), className: `flex-1 md:flex-none px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === 'scanner' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-900 text-slate-500'}`, children: [_jsx(Radar, { size: 14 }), " Live Scanner"] }), _jsxs("button", { onClick: () => setActiveTab('snipes'), className: `flex-1 md:flex-none px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === 'snipes' ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-900 text-slate-500'}`, children: [_jsx(Target, { size: 14 }), " My Snipes"] })] }), _jsx("div", { className: "px-4 md:px-0", children: activeTab === 'scanner' ? (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6", children: flashMoves.length === 0 ? (_jsxs("div", { className: "col-span-full glass-panel py-24 rounded-[2rem] border-white/5 text-center space-y-6", children: [_jsxs("div", { className: "relative mx-auto w-20 h-20", children: [_jsx("div", { className: "absolute inset-0 bg-rose-500/20 blur-2xl rounded-full animate-pulse" }), _jsx(Loader2, { className: "animate-spin text-rose-500 mx-auto relative z-10", size: 48 })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-white font-black uppercase tracking-[0.4em] text-xs", children: "Awaiting Alpha" }), _jsx("p", { className: "text-slate-500 text-[10px] uppercase font-bold tracking-widest", children: "Scanning 1,472 Markets for Pitch Velocity..." })] })] })) : (flashMoves.map((move, idx) => _jsx(FlashCard, { move: move }, move.tokenId + idx))) })) : (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4", children: activeSnipes.length === 0 ? (_jsxs("div", { className: "col-span-full glass-panel py-20 rounded-[2rem] border-white/5 text-center flex flex-col items-center justify-center bg-black/20", children: [_jsx(Target, { size: 40, className: "text-slate-800 mb-4" }), _jsx("p", { className: "text-slate-500 text-[10px] font-black uppercase tracking-widest", children: "No active snipes in orbit" })] })) : (activeSnipes.map((snipe, idx) => _jsx(SnipeCard, { snipe: snipe }, snipe.tokenId + idx))) })) }), _jsxs("div", { className: "mx-4 md:mx-0 p-6 glass-panel rounded-3xl border-white/5 bg-blue-600/[0.03] flex flex-col md:flex-row items-center gap-6", children: [_jsx("div", { className: "w-12 h-12 bg-blue-600/20 rounded-2xl flex items-center justify-center text-blue-500 shrink-0", children: _jsx(Info, { size: 24 }) }), _jsxs("div", { className: "text-center md:text-left space-y-1", children: [_jsx("p", { className: "text-[10px] font-black text-blue-400 uppercase tracking-widest", children: "Autonomous Guard Strategy" }), _jsx("p", { className: "text-xs text-slate-400 leading-relaxed", children: "The FOMO Runner monitors global price velocity via the raw CLOB WebSocket. It enters only when upward momentum is confirmed and liquidity depth exceeds $1,000 to prevent slippage traps." })] }), _jsxs("div", { className: "flex gap-4 shrink-0", children: [_jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-[8px] font-bold text-slate-500 uppercase mb-1", children: "Safety Cap" }), _jsx("div", { className: "px-3 py-1 bg-black/40 rounded-lg text-[10px] font-mono font-bold text-white", children: "$100/trade" })] }), _jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-[8px] font-bold text-slate-500 uppercase mb-1", children: "Stop Loss" }), _jsx("div", { className: "px-3 py-1 bg-rose-500/20 rounded-lg text-[10px] font-mono font-bold text-rose-400", children: "-10%" })] })] })] })] }));
};
export default FomoRunner;
