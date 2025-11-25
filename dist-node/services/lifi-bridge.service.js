import { createConfig, getRoutes, executeRoute } from '@lifi/sdk';
import axios from 'axios';
// Initialize LiFi Config
const lifiConfig = createConfig({
    integrator: 'polycafe-BetMirror',
    providers: [], // Auto-detect window.ethereum / window.solana
});
export class LiFiBridgeService {
    constructor() {
        this.history = [];
        this.userId = '';
    }
    setUserId(userId) {
        this.userId = userId;
    }
    /**
     * Get a quote to bridge funds from User's Chain -> Polygon Proxy
     * Includes 0.5% Integrator Fee
     */
    async getDepositRoute(params) {
        try {
            const result = await getRoutes({
                fromChainId: params.fromChainId,
                fromTokenAddress: params.fromTokenAddress,
                fromAmount: params.fromAmount,
                toChainId: params.toChainId, // Target: Polygon
                toTokenAddress: params.toTokenAddress, // Target: USDC
                toAddress: params.toAddress,
                options: {
                    slippage: 0.005, // 0.5% Slippage
                    order: 'CHEAPEST',
                    fee: 0.005, // 0.5% Protocol Fee (Monetization)
                    integrator: 'polycafe-BetMirror'
                }
            });
            return result.routes;
        }
        catch (error) {
            console.error("LiFi Route Error:", error);
            throw error;
        }
    }
    /**
     * Execute the bridge transaction
     * Returns the full route object for tracking
     */
    async executeBridge(route, onUpdate) {
        const recordId = Math.random().toString(36).substring(7);
        // 1. Log Start
        const record = {
            id: recordId,
            timestamp: new Date().toISOString(),
            fromChain: this.getChainName(route.fromChainId),
            toChain: this.getChainName(route.toChainId),
            amountIn: route.fromAmountUSD,
            amountOut: route.toAmountUSD,
            status: 'PENDING',
            tool: route.steps[0]?.toolDetails?.name || 'LiFi',
            fees: route.gasCostUSD
        };
        await this.saveRecord(record);
        try {
            // 2. Execute
            const result = await executeRoute(route, {
                updateRouteHook: (updatedRoute) => {
                    const step = updatedRoute.steps[0];
                    const process = step.execution?.process;
                    // Find the active process
                    const activeProcess = process?.find(p => p.status === 'STARTED' || p.status === 'PENDING') || process?.[process.length - 1];
                    let statusMsg = "Processing...";
                    if (activeProcess) {
                        if (activeProcess.type === 'TOKEN_ALLOWANCE')
                            statusMsg = "Approving Token Spend...";
                        if (activeProcess.type === 'SWAP')
                            statusMsg = "Swapping Assets...";
                        if (activeProcess.type === 'CROSS_CHAIN')
                            statusMsg = "Bridging to Polygon...";
                    }
                    onUpdate(statusMsg, step);
                }
            });
            // 3. Success
            const lastStep = result.steps[result.steps.length - 1];
            // Safe access to txHash via casting or process inspection
            const txHash = lastStep.execution?.toTx ||
                lastStep.execution?.process?.find((p) => p.txHash)?.txHash ||
                lastStep.execution?.process?.slice(-1)[0]?.txHash;
            await this.saveRecord({ ...record, status: 'COMPLETED', txHash });
            return result;
        }
        catch (e) {
            // 4. Fail
            await this.saveRecord({ ...record, status: 'FAILED' });
            throw e;
        }
    }
    async fetchHistory() {
        if (!this.userId)
            return [];
        try {
            const res = await axios.get(`/api/bridge/history/${this.userId}`);
            this.history = res.data;
            return this.history;
        }
        catch (e) {
            console.error("Failed to fetch bridge history", e);
            return [];
        }
    }
    getHistory() {
        return this.history;
    }
    async saveRecord(record) {
        // Update Local State
        const index = this.history.findIndex(r => r.id === record.id);
        if (index >= 0) {
            this.history[index] = record;
        }
        else {
            this.history.unshift(record);
        }
        // Persist to DB
        if (this.userId) {
            try {
                await axios.post('/api/bridge/record', {
                    userId: this.userId,
                    transaction: record
                });
            }
            catch (e) {
                console.error("Failed to persist bridge record", e);
            }
        }
    }
    getChainName(chainId) {
        switch (chainId) {
            case 1: return 'Ethereum';
            case 137: return 'Polygon';
            case 8453: return 'Base';
            case 42161: return 'Arbitrum';
            case 56: return 'BNB Chain';
            case 1151111081099710: return 'Solana';
            default: return `Chain ${chainId}`;
        }
    }
    getNativeToken(chainId) {
        return '0x0000000000000000000000000000000000000000';
    }
}
export const lifiService = new LiFiBridgeService();
