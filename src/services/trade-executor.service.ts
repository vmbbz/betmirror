import type { RuntimeEnv } from '../config/env.js';
import type { Logger } from '../utils/logger.util.js';
import type { TradeSignal, ActivePosition } from '../domain/trade.types.js';
import { computeProportionalSizing } from '../config/copy-strategy.js';
import { httpGet } from '../utils/http.js';
import { IExchangeAdapter, LiquidityHealth } from '../adapters/interfaces.js';
import axios from 'axios';

export type TradeExecutorDeps = {
  adapter: IExchangeAdapter;
  env: RuntimeEnv;
  logger: Logger;
  proxyWallet: string; // Funder address
};

interface Position {
  conditionId: string;
  initialValue: number;
  currentValue: number;
  balance: string; // share balance
}

export interface ExecutionResult {
    status: 'FILLED' | 'FAILED' | 'SKIPPED' | 'ILLIQUID';
    txHash?: string;
    executedAmount: number; // USD Value
    executedShares: number; // Share Count
    priceFilled: number;    
    reason?: string;
}

export class TradeExecutorService {
  private readonly deps: TradeExecutorDeps;
  
  private balanceCache: Map<string, { value: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; 
  
  private pendingSpend = 0;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  // Check if market resolved and which outcome won
  private async checkMarketResolution(position: ActivePosition): Promise<{
    resolved: boolean;
    winningOutcome?: string;
    userWon?: boolean;
    market?: any;
    conditionId?: string;
    source?: 'CLOB' | 'GAMMA';
}> {
    const { logger, adapter } = this.deps;
    const conditionId = position.conditionId || position.marketId;
    
    try {
        let market: any = null;
        let source: 'CLOB' | 'GAMMA' | undefined;

        // ATTEMPT 1: CLOB API (Active Markets)
        const client = (adapter as any).getRawClient?.();
        if (client) {
            try {
                market = await client.getMarket(conditionId);
                if (market) source = 'CLOB';
            } catch (e) {
                logger.debug(`CLOB 404 for ${conditionId}, checking Gamma fallback...`);
            }
        }

        // ATTEMPT 2: GAMMA API FALLBACK (Archived Markets)
        if (!market) {
            try {
                const gammaUrl = `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`;
                const res = await axios.get(gammaUrl);
                if (res.data && Array.isArray(res.data) && res.data.length > 0) {
                    market = res.data[0];
                    source = 'GAMMA';
                }
            } catch (e) {
                logger.error(`Gamma fallback failed for ${conditionId}`);
            }
        }

        if (!market) {
            logger.warn(`❌ Market resolution check failed: ID ${conditionId} not found.`);
            return { resolved: false, conditionId };
        }

        // Detailed Metadata Logging for Admin
        logger.info(`📊 Resolution Metadata [${source}] for ${conditionId}: closed=${market.closed}, active=${market.active}, status=${market.status}`);

        // Primary Resolution Detection
        const isResolved = market.closed === true || market.status === 'resolved' || market.archived === true;

        if (!isResolved) {
            logger.debug(`⏳ Market ${conditionId} is not resolved yet.`);
            return { resolved: false, market, conditionId, source };
        }

        // Winner Detection Logic
        let winningOutcome: string | undefined;
        let userWon = false;

        if (market.tokens && Array.isArray(market.tokens)) {
            // CLOB Format
            const winningToken = market.tokens.find((t: any) => t.winner === true);
            if (winningToken) winningOutcome = winningToken.outcome;
        } else if (market.winning_outcome) {
            // Gamma Format
            winningOutcome = market.winning_outcome;
        }

        if (winningOutcome) {
            userWon = position.outcome.toUpperCase() === winningOutcome.toUpperCase();
            logger.info(`🏆 Resolution result: Winning=${winningOutcome}, Mine=${position.outcome}, Result=${userWon ? 'WON' : 'LOST'}`);
        }

        return { 
            resolved: true, 
            winningOutcome, 
            userWon, 
            market,
            conditionId,
            source
        };

    } catch (error: any) {
        logger.error(`❌ Error in resolution engine: ${error.message}`);
        return { resolved: false, conditionId };
    }
}

  async executeManualExit(position: ActivePosition, currentPrice: number): Promise<boolean> {
      console.log('🚀 executeManualExit called with:', {
        positionId: position.tradeId,
        marketId: position.marketId,
        shares: position.shares,
        currentPrice
      });
      
      const { logger, adapter } = this.deps;
      let remainingShares = position.shares;
      
      try {
          if (remainingShares < 5) {
              logger.error(`🚨 Cannot Exit: Balance (${remainingShares.toFixed(2)}) below exchange minimum (5).`);
              return false;
          }

          logger.info(`📉 Attempting Market Sell for ${position.tokenId}...`);
          
          const result = await adapter.createOrder({
              marketId: position.marketId,
              tokenId: position.tokenId,
              outcome: position.outcome,
              side: 'SELL',
              sizeUsd: 0, 
              sizeShares: remainingShares,
              priceLimit: 0.001 
          });
          
          if (result.success) {
              const filled = result.sharesFilled || 0;
              const diff = position.shares - filled;
              
              if (diff > 0.01) {
                  logger.warn(`⚠️ Partial Fill: Only liquidated ${filled}/${position.shares} shares. ${diff.toFixed(2)} shares remain stuck due to book depth.`);
              }
              
              logger.success(`Exit summary: Liquidated ${filled.toFixed(2)} shares @ avg best possible price.`);
              return true;
          } else {
              // Handle Resolution & Redemption if Orderbook is gone
              if (result.error?.includes("404") || result.error?.includes("No orderbook")) {
                  logger.info(`Market unresponsive. Checking resolution status...`);
                  
                  const resolution = await this.checkMarketResolution(position);
                  
                  if (resolution.resolved) {
                      if (resolution.userWon) {
                          logger.success(`🏆 Winner! Redeeming Favorably...`);
                          const redeemResult = await adapter.redeemPosition(resolution.conditionId || position.marketId, position.tokenId);
                          return redeemResult.success;
                      } else {
                          logger.warn(`💀 Position Expired Worthless. Winner was: ${resolution.winningOutcome}`);
                          return false;
                      }
                  }
              }
              
              logger.error(`Exit failed: ${result.error || "Unknown Error"}`);
              return false;
          }
          
      } catch (e: any) {
          logger.error(`Manual Exit Critical Error: ${e.message}`);
          return false;
      }
  }

  async copyTrade(signal: TradeSignal): Promise<ExecutionResult> {
    const { logger, env, adapter, proxyWallet } = this.deps;
    
    const failResult = (reason: string, status: 'SKIPPED' | 'FAILED' | 'ILLIQUID' = 'SKIPPED'): ExecutionResult => ({
        status,
        executedAmount: 0,
        executedShares: 0,
        priceFilled: 0,
        reason
    });

    try {
      // MARKET VALIDATION - Check if market is still tradeable
      try {
        const market = await (adapter as any).getRawClient().getMarket(signal.marketId);
        
        if (!market) {
          logger.warn(`[Market Not Found] ${signal.marketId} - Skipping`);
          return failResult("market_not_found");
        }
        if (market.closed) {
          logger.warn(`[Market Closed] ${signal.marketId} - Skipping`);
          return failResult("market_closed");
        }
        if (!market.active || !market.accepting_orders) {
          logger.warn(`[Market Inactive] ${signal.marketId} - Skipping`);
          return failResult("market_not_accepting_orders");
        }
        if (market.archived) {
          logger.warn(`[Market Archived] ${signal.marketId} - Skipping`);
          return failResult("market_archived");
        }
      } catch (e: any) {
        if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
          logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position`);
          
          // Try to redeem existing position if market is resolved
          try {
            const positions = await adapter.getPositions(proxyWallet);
            const existingPosition = positions.find(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
            
            if (existingPosition) {
              logger.info(`[Auto-Redeem] Found position: ${existingPosition.balance} shares of ${signal.outcome}`);
              const redeemResult = await adapter.redeemPosition(signal.marketId, existingPosition.tokenId);
              
              if (redeemResult.success) {
                logger.success(`[Auto-Redeem] Successfully redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                return {
                  status: 'FILLED',
                  executedAmount: redeemResult.amountUsd || 0,
                  executedShares: existingPosition.balance,
                  priceFilled: 1.0,
                  reason: 'Auto-redeemed resolved market position'
                };
              } else {
                logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                return failResult("redemption_failed", 'FAILED');
              }
            } else {
              logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
              return failResult("orderbook_not_found");
            }
          } catch (redeemError: any) {
            logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
            return failResult("redemption_error", 'FAILED');
          }
        }
        throw e;
      }
      if (this.deps.adapter.getLiquidityMetrics) {
          try {
              const metrics = await this.deps.adapter.getLiquidityMetrics(signal.tokenId, signal.side);
              const minRequired = (this.deps.env as any).minLiquidityFilter || 'LOW';
              
              const ranks: Record<string, number> = { 
                  [LiquidityHealth.HIGH]: 3, 
                  [LiquidityHealth.MEDIUM]: 2, 
                  [LiquidityHealth.LOW]: 1, 
                  [LiquidityHealth.CRITICAL]: 0 
              };
              
              if (ranks[metrics.health] < ranks[minRequired]) {
                  const msg = `[Liquidity Filter] Health: ${metrics.health} (Min: ${minRequired}) | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)} -> SKIPPING`;
                  logger.warn(msg);
                  return failResult("insufficient_liquidity", "ILLIQUID");
              }
              logger.info(`[Liquidity OK] Health: ${metrics.health} | Spread: ${(metrics.spread * 100).toFixed(1)}¢ | Depth: $${metrics.availableDepthUsd.toFixed(0)}`);
          } catch (e: any) {
              // Check if this is a resolved market (404/No orderbook)
              if (e.message?.includes("404") || e.message?.includes("No orderbook") || String(e).includes("404")) {
                  logger.warn(`[Market Resolved] ${signal.marketId} - Attempting to redeem existing position (liquidity check)`);
                  
                  // Try to redeem existing position if market is resolved
                  try {
                      const positions = await adapter.getPositions(proxyWallet);
                      const existingPosition = positions.find(p => p.marketId === signal.marketId && p.outcome === signal.outcome);
                      
                      if (existingPosition) {
                          logger.info(`[Auto-Redeem] Found position: ${existingPosition.balance} shares of ${signal.outcome}`);
                          const redeemResult = await adapter.redeemPosition(signal.marketId, existingPosition.tokenId);
                          
                          if (redeemResult.success) {
                              logger.success(`[Auto-Redeem] Successfully redeemed $${redeemResult.amountUsd?.toFixed(2)} USDC`);
                              return {
                                  status: 'FILLED',
                                  executedAmount: redeemResult.amountUsd || 0,
                                  executedShares: existingPosition.balance,
                                  priceFilled: 1.0,
                                  reason: 'Auto-redeemed resolved market position'
                              };
                          } else {
                              logger.error(`[Auto-Redeem] Failed: ${redeemResult.error}`);
                              return failResult("redemption_failed", 'FAILED');
                          }
                      } else {
                          logger.warn(`[Auto-Redeem] No existing position found for ${signal.marketId}`);
                          return failResult("orderbook_not_found");
                      }
                  } catch (redeemError: any) {
                      logger.error(`[Auto-Redeem] Error during redemption: ${redeemError.message}`);
                      return failResult("redemption_error", 'FAILED');
                  }
              }
              throw e;
          }
      }

      let usableBalanceForTrade = 0;
      let currentShareBalance = 0;

      const positions = await adapter.getPositions(proxyWallet);
      const myPosition = positions.find(p => p.tokenId === signal.tokenId);
      if (myPosition) {
          currentShareBalance = myPosition.balance;
      }

      if (signal.side === 'BUY') {
          const chainBalance = await adapter.fetchBalance(proxyWallet);
          usableBalanceForTrade = Math.max(0, chainBalance - this.pendingSpend);
      } else {
          if (!myPosition || myPosition.balance <= 0) return failResult("no_position_to_sell");
          usableBalanceForTrade = myPosition.valueUsd;
      }

      const traderBalance = await this.getTraderBalance(signal.trader);

      // Check for insufficient funds BEFORE sizing computation
      if (signal.side === 'BUY' && usableBalanceForTrade < 1) {
          const chainBalance = await adapter.fetchBalance(proxyWallet);
          return failResult(`insufficient_funds (balance: $${chainBalance.toFixed(2)}, pending: $${this.pendingSpend.toFixed(2)}, available: $${usableBalanceForTrade.toFixed(2)})`, "FAILED");
      }

      let minOrderSize = 5; 
      try {
          const book = await adapter.getOrderBook(signal.tokenId);
          if (book.min_order_size) minOrderSize = Number(book.min_order_size);
      } catch (e) {}

      const sizing = computeProportionalSizing({
        yourUsdBalance: usableBalanceForTrade,
        yourShareBalance: currentShareBalance,
        traderUsdBalance: traderBalance,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
        currentPrice: signal.price,
        maxTradeAmount: env.maxTradeAmount,
        minOrderSize: minOrderSize,
        side: signal.side
      });

      if (sizing.targetShares <= 0) {
          return failResult(sizing.reason || "skipped_by_sizing_engine");
      }

      let priceLimit: number | undefined = undefined;
      if (signal.side === 'BUY') {
          priceLimit = Math.min(0.99, signal.price * 1.05);
      } else {
          priceLimit = Math.max(0.001, signal.price * 0.90);
      }

      logger.info(`[Sizing] Whale: $${traderBalance.toFixed(0)} | Signal: $${signal.sizeUsd.toFixed(0)} (${signal.side}) | Target: $${sizing.targetUsdSize.toFixed(2)} (${sizing.targetShares} shares) | Reason: ${sizing.reason}`);

      const result = await adapter.createOrder({
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
        sizeShares: signal.side === 'SELL' ? sizing.targetShares : undefined,
        priceLimit: priceLimit
      });

      if (!result.success) {
          return {
              status: 'FAILED',
              executedAmount: 0,
              executedShares: 0,
              priceFilled: 0,
              reason: result.error || 'Unknown error'
          };
      }

      if (signal.side === 'BUY') this.pendingSpend += sizing.targetUsdSize;
      
      return {
          status: 'FILLED',
          txHash: result.orderId || result.txHash,
          executedAmount: result.sharesFilled * result.priceFilled,
          executedShares: result.sharesFilled,
          priceFilled: result.priceFilled,
          reason: sizing.reason
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to copy trade: ${errorMessage}`, err as Error);
      return {
            status: 'FAILED',
            executedAmount: 0,
            executedShares: 0,
            priceFilled: 0,
            reason: errorMessage
      };
    }
  }

  private async getTraderBalance(trader: string): Promise<number> {
    const cached = this.balanceCache.get(trader);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
        return cached.value;
    }

    try {
      const positions: Position[] = await httpGet<Position[]>(
        `https://data-api.polymarket.com/positions?user=${trader}`,
      );
      const totalValue = positions.reduce((sum, pos) => sum + (pos.currentValue || pos.initialValue || 0), 0);
      const val = Math.max(1000, totalValue);
      this.balanceCache.set(trader, { value: val, timestamp: Date.now() });
      return val;
    } catch {
      return 10000; 
    }
  }
}