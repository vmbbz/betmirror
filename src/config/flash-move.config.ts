import { FlashMoveConfig } from '../services/flash-detection.service.js';

/**
 * Default Flash Move Configuration
 * 
 * These settings control the sensitivity and behavior of the flash move detection
 * and execution system. Adjust based on market conditions and risk tolerance.
 */
export const DEFAULT_FLASH_MOVE_CONFIG: FlashMoveConfig = {
  // Detection thresholds
  velocityThreshold: 0.03,        // 3% price movement triggers detection
  momentumThreshold: 0.02,        // 2% price acceleration threshold
  volumeSpikeMultiplier: 3.0,     // 3x normal volume triggers detection
  
  // Execution parameters
  baseTradeSize: 50,              // $50 default trade size
  maxSlippagePercent: 0.02,      // 2% maximum slippage tolerance
  stopLossPercent: 0.10,           // 10% stop loss
  takeProfitPercent: 0.20,         // 20% take profit
  
  // Risk management
  maxVolatilityPercent: 1.0,       // 100% volatility triggers kill switch
  liquidityFloor: 1000,             // $1000 minimum liquidity required
  maxConcurrentTrades: 3,          // Maximum 3 concurrent flash trades
  
  // Strategy selection
  preferredStrategy: 'adaptive',      // Adaptive strategy selection
  enableLiquidityCheck: true,       // Check liquidity before execution
  enableVolatilityKillSwitch: true   // Enable extreme volatility protection
};

/**
 * Conservative Flash Move Configuration
 * 
 * Lower risk settings for stable trading with fewer but higher quality signals
 */
export const CONSERVATIVE_FLASH_MOVE_CONFIG: FlashMoveConfig = {
  ...DEFAULT_FLASH_MOVE_CONFIG,
  velocityThreshold: 0.05,        // 5% threshold (more selective)
  momentumThreshold: 0.03,        // 3% acceleration threshold
  volumeSpikeMultiplier: 4.0,     // 4x volume required
  baseTradeSize: 25,              // $25 smaller position size
  maxSlippagePercent: 0.01,      // 1% tighter slippage control
  stopLossPercent: 0.05,           // 5% tighter stop loss
  takeProfitPercent: 0.15,         // 15% conservative take profit
  maxConcurrentTrades: 1,          // Only 1 concurrent trade
  preferredStrategy: 'conservative'
};

/**
 * Aggressive Flash Move Configuration
 * 
 * Higher risk settings for capturing more opportunities with increased volatility
 */
export const AGGRESSIVE_FLASH_MOVE_CONFIG: FlashMoveConfig = {
  ...DEFAULT_FLASH_MOVE_CONFIG,
  velocityThreshold: 0.02,        // 2% threshold (more sensitive)
  momentumThreshold: 0.015,       // 1.5% acceleration threshold
  volumeSpikeMultiplier: 2.0,     // 2x volume required
  baseTradeSize: 100,             // $100 larger position size
  maxSlippagePercent: 0.03,      // 3% looser slippage tolerance
  stopLossPercent: 0.15,           // 15% wider stop loss
  takeProfitPercent: 0.30,         // 30% higher take profit target
  maxConcurrentTrades: 5,          // Up to 5 concurrent trades
  preferredStrategy: 'aggressive'
};

/**
 * Configuration presets for different market conditions
 */
export const FLASH_MOVE_PRESETS = {
  default: DEFAULT_FLASH_MOVE_CONFIG,
  conservative: CONSERVATIVE_FLASH_MOVE_CONFIG,
  aggressive: AGGRESSIVE_FLASH_MOVE_CONFIG
} as const;

export type FlashMovePreset = keyof typeof FLASH_MOVE_PRESETS;
