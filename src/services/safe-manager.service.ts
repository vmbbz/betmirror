import { Wallet, Interface, Contract, ethers, JsonRpcProvider } from 'ethers';
import { RelayClient, SafeTransaction, OperationType } from '@polymarket/builder-relayer-client';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { POLYGON_CHAIN_ID, TOKENS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';

// --- Constants ---
const RELAYER_URL = "https://relayer-v2.polymarket.com";

// Polymarket Core Contracts
const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// Gnosis Safe Factories
const POLYMARKET_SAFE_FACTORY = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b"; 
const STANDARD_SAFE_FACTORY = "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2";

const SAFE_SINGLETON_ADDRESS = "0x3e5c63644e683549055b9be8653de26e0b4cd36e";
const FALLBACK_HANDLER_ADDRESS = "0xf48f2b2d2a534e40247ecb36350021948091179d";

const SAFE_ABI = [
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
    "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
    "function isOwner(address owner) view returns (bool)",
    "function addOwnerWithThreshold(address owner, uint256 _threshold)",
    "function getOwners() view returns (address[])"
];

const PROXY_FACTORY_ABI = [
    "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) returns (address proxy)"
];

// ABIs
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)"
];
const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address account, address operator) view returns (bool)"
];

// --- Rate Limiting & Retry Utilities ---
class RateLimiter {
    private queue: Array<() => Promise<any>> = [];
    private processing = false;
    private lastRequestTime = 0;
    private minInterval: number;

    constructor(requestsPerSecond: number = 2) {
        this.minInterval = 1000 / requestsPerSecond;
    }

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await fn();
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            
            if (timeSinceLastRequest < this.minInterval) {
                await new Promise(r => setTimeout(r, this.minInterval - timeSinceLastRequest));
            }

            const fn = this.queue.shift();
            if (fn) {
                this.lastRequestTime = Date.now();
                await fn();
            }
        }

        this.processing = false;
    }
}

async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxRetries?: number;
        baseDelay?: number;
        maxDelay?: number;
        onRetry?: (error: any, attempt: number) => void;
    } = {}
): Promise<T> {
    const { maxRetries = 5, baseDelay = 1000, maxDelay = 30000, onRetry } = options;
    
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            const errorMsg = (error.message || '').toLowerCase();
            
            // Check if it's a rate limit error
            const isRateLimited = errorMsg.includes('rate limit') || 
                                  errorMsg.includes('too many requests') ||
                                  error.code === -32090;
            
            if (attempt === maxRetries || !isRateLimited) {
                throw error;
            }

            // Exponential backoff with jitter
            const delay = Math.min(
                baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
                maxDelay
            );
            
            if (onRetry) {
                onRetry(error, attempt + 1);
            }
            
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

// Global rate limiter instance (shared across all SafeManager instances)
const globalRateLimiter = new RateLimiter(2); // 2 requests per second max

export class SafeManagerService {
    private relayClient: RelayClient;
    private safeAddress: string;
    private viemPublicClient: any;
    private rateLimiter: RateLimiter;

    constructor(
        private signer: Wallet,
        private builderApiKey: string | undefined,
        private builderApiSecret: string | undefined,
        private builderApiPassphrase: string | undefined,
        private logger: Logger,
        knownSafeAddress: string 
    ) {
        if (!knownSafeAddress || !knownSafeAddress.startsWith('0x')) {
            throw new Error("SafeManagerService initialized without a valid Safe Address.");
        }
        this.safeAddress = knownSafeAddress;
        this.rateLimiter = globalRateLimiter;
        
        this.logger.info(`ℹ️ Active Safe: ${knownSafeAddress}`);

        let builderConfig: BuilderConfig | undefined = undefined;

        if (!builderApiKey || !builderApiSecret || !builderApiPassphrase) {
            this.logger.warn(`⚠️ Builder Creds Missing. Safe Relayer functionality limited.`);
        } else {
            try {
                builderConfig = new BuilderConfig({
                    localBuilderCreds: {
                        key: builderApiKey,
                        secret: builderApiSecret,
                        passphrase: builderApiPassphrase
                    }
                });
            } catch (e) {
                this.logger.warn("⚠️ Failed to initialize BuilderConfig.");
            }
        }

        const rpcUrl = process.env.RPC_URL;
        if (!rpcUrl || rpcUrl.includes('polygon-rpc.com')) {
            this.logger.warn(`⚠️ Using public RPC. Set RPC_URL env var to a dedicated provider (Alchemy, QuickNode, Infura) for production.`);
        }

        const account = privateKeyToAccount(signer.privateKey as `0x${string}`);
        const viemClient = createWalletClient({
            account,
            chain: polygon,
            transport: http(rpcUrl || 'https://polygon-rpc.com')
        });
        
        // Configure viem client with aggressive retry settings
        this.viemPublicClient = createPublicClient({
            chain: polygon,
            transport: http(rpcUrl || 'https://polygon-rpc.com', {
                retryCount: 5,
                retryDelay: 2000,
                timeout: 30000,
                batch: {
                    wait: 100 // Batch requests within 100ms window
                }
            })
        });

        this.relayClient = new RelayClient(
            RELAYER_URL,
            POLYGON_CHAIN_ID,
            viemClient, 
            builderConfig
        );
    }

    public getSafeAddress(): string {
        return this.safeAddress;
    }

    /**
     * Rate-limited RPC call wrapper with exponential backoff retry
     */
    private async rpcCall<T>(fn: () => Promise<T>, context: string = 'RPC call'): Promise<T> {
        return this.rateLimiter.execute(() => 
            withRetry(fn, {
                maxRetries: 5,
                baseDelay: 2000,
                maxDelay: 30000,
                onRetry: (error, attempt) => {
                    this.logger.warn(`   ⏳ ${context} rate limited, retry ${attempt}/5...`);
                }
            })
        );
    }

    public static async computeAddress(ownerAddress: string): Promise<string> {
        const polySafe = await deriveSafe(ownerAddress, POLYMARKET_SAFE_FACTORY);
        const stdSafe = await deriveSafe(ownerAddress, STANDARD_SAFE_FACTORY);

        try {
            const network = { chainId: 137, name: 'polygon' };
            const rpcUrl = process.env.RPC_URL || 'https://polygon-rpc.com';
            const provider = new JsonRpcProvider(rpcUrl, network, { 
                staticNetwork: true,
                batchMaxCount: 1, // Reduce batching to avoid rate limits
                polling: false,
                cacheTimeout: 30000
            });
            
            // Add delay between checks
            const stdCode = await provider.getCode(stdSafe);
            if (stdCode && stdCode !== '0x') {
                console.log(`[SafeManager] Found existing Legacy Safe at ${stdSafe}`);
                return stdSafe;
            }

            await new Promise(r => setTimeout(r, 500)); // Small delay between calls

            const polyCode = await provider.getCode(polySafe);
            if (polyCode && polyCode !== '0x') {
                console.log(`[SafeManager] Found existing Polymarket Safe at ${polySafe}`);
                return polySafe;
            }
        } catch (e) {
            console.warn("[SafeManager] Failed to check code on-chain, defaulting to Polymarket factory derivation.");
        }

        return polySafe;
    }

    public async isDeployed(): Promise<boolean> {
        return this.rpcCall(async () => {
            try {
                const code = await this.viemPublicClient.getBytecode({ address: this.safeAddress });
                return (code && code !== '0x');
            } catch(e) { 
                return false; 
            }
        }, 'isDeployed check');
    }

    public async deploySafe(): Promise<string> {
        if (await this.isDeployed()) {
            this.logger.info(`   Safe ${this.safeAddress.slice(0,8)}... is active.`);
            return this.safeAddress;
        }

        this.logger.info(`🚀 Deploying Gnosis Safe ${this.safeAddress.slice(0,8)}...`);

        try {
            const task = await this.relayClient.deploy();
            await task.wait(); 
            const realAddress = (task as any).proxyAddress;
            
            if (realAddress && realAddress.toLowerCase() !== this.safeAddress.toLowerCase()) {
                this.logger.warn(`⚠️ Relayer deployed to ${realAddress}, but DB expected ${this.safeAddress}. Updating DB...`);
                return realAddress;
            }
            this.logger.success(`✅ Safe Deployed via Relayer`);
            return realAddress || this.safeAddress;
        } catch (e: any) {
            const msg = (e.message || "").toLowerCase();
            if (msg.includes("already deployed")) {
                this.logger.success(`   Safe active (confirmed by Relayer).`);
                return this.safeAddress;
            }
            this.logger.warn(`   Relayer deploy failed (${msg}). Switching to Rescue Deploy...`);
            return await this.deploySafeOnChain();
        }
    }

    public async checkAllowance(token: string, spender: string): Promise<bigint> {
        return this.rpcCall(async () => {
            const allowance = await this.viemPublicClient.readContract({
                address: token as `0x${string}`,
                abi: parseAbi(ERC20_ABI),
                functionName: 'allowance',
                args: [this.safeAddress, spender]
            }) as bigint;
            return allowance;
        }, `checkAllowance(${spender.slice(0,8)})`);
    }

    public async checkBalance(token: string): Promise<bigint> {
        return this.rpcCall(async () => {
            const balance = await this.viemPublicClient.readContract({
                address: token as `0x${string}`,
                abi: parseAbi(ERC20_ABI),
                functionName: 'balanceOf',
                args: [this.safeAddress]
            }) as bigint;
            return balance;
        }, 'checkBalance');
    }

    public async setDynamicAllowance(token: string, spender: string, requiredAmount: bigint): Promise<boolean> {
        try {
            const currentAllowance = await this.checkAllowance(token, spender);
            if (currentAllowance >= requiredAmount) {
                return true;
            }

            const balance = await this.checkBalance(token);
            const approvalAmount = balance > 0 ? balance * 2n : requiredAmount * 2n;

            this.logger.info(`   Setting allowance for ${spender.slice(0, 8)}... to ${ethers.formatUnits(approvalAmount, 6)} USDC`);
            
            const usdcInterface = new Interface(ERC20_ABI);
            const tx = await this.executeTransaction({
                to: token,
                data: usdcInterface.encodeFunctionData("approve", [spender, approvalAmount]) as `0x${string}`,
                value: "0x0"
            });
            
            this.logger.success(`   Allowance set in tx: ${tx}`);
            return true;
        } catch (e) {
            this.logger.error(`Failed to set allowance: ${e}`);
            return false;
        }
    }

    /**
     * PRODUCTION-READY APPROVAL ENGINE
     * Uses rate limiting and retry logic to handle RPC limits gracefully
     */
    public async enableApprovals(): Promise<void> {
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);

        this.logger.info(`   Synchronizing permissions for ${this.safeAddress.slice(0,8)}...`);

        // Wait for Safe deployment confirmation
        let retries = 10;
        while (retries > 0 && !(await this.isDeployed())) {
            this.logger.info(`   Waiting for Safe deployment indexing...`);
            await new Promise(r => setTimeout(r, 3000));
            retries--;
        }

        const batch: SafeTransaction[] = [];

        // 1. COLLECT USDC APPROVALS (sequentially with rate limiting)
        const usdcSpenders = [
            { addr: CTF_CONTRACT_ADDRESS, name: "CTF" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" },
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" }
        ];

        const DEFAULT_MAX_ALLOWANCE = 10_000_000_000n; // 10,000 USDC
        
        // Get balance first (rate limited)
        let currentBalance = 0n;
        try {
            currentBalance = await this.checkBalance(TOKENS.USDC_BRIDGED);
        } catch (e) {
            this.logger.warn(`   Could not fetch balance, using default allowance`);
        }
        
        const minAllowance = currentBalance > 0n 
            ? currentBalance * 2n 
            : DEFAULT_MAX_ALLOWANCE;

        // Check allowances sequentially (rate limiter handles timing)
        for (const spender of usdcSpenders) {
            try {
                const allowance = await this.checkAllowance(TOKENS.USDC_BRIDGED, spender.addr);
                
                if (allowance < minAllowance) {
                    this.logger.info(`     + Batching USDC approval for ${spender.name}`);
                    batch.push({ 
                        to: TOKENS.USDC_BRIDGED as `0x${string}`, 
                        value: "0", 
                        data: usdcInterface.encodeFunctionData("approve", [spender.addr, minAllowance]) as `0x${string}`, 
                        operation: OperationType.Call 
                    });
                }
            } catch (e) {
                // If we can't check, add to batch anyway (safe to re-approve)
                this.logger.warn(`     ⚠️ Could not check ${spender.name} allowance, adding to batch`);
                batch.push({ 
                    to: TOKENS.USDC_BRIDGED as `0x${string}`, 
                    value: "0", 
                    data: usdcInterface.encodeFunctionData("approve", [spender.addr, minAllowance]) as `0x${string}`, 
                    operation: OperationType.Call 
                });
            }
        }

        // 2. COLLECT CTF OPERATOR PERMISSIONS (sequentially with rate limiting)
        const ctfOperators = [
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" }
        ];

        for (const operator of ctfOperators) {
            try {
                const isApproved = await this.rpcCall(async () => {
                    return await this.viemPublicClient.readContract({
                        address: CTF_CONTRACT_ADDRESS,
                        abi: parseAbi(ERC1155_ABI),
                        functionName: 'isApprovedForAll',
                        args: [this.safeAddress, operator.addr]
                    }) as boolean;
                }, `isApprovedForAll(${operator.name})`);

                if (!isApproved) {
                    this.logger.info(`     + Batching Operator set for ${operator.name}`);
                    batch.push({ 
                        to: CTF_CONTRACT_ADDRESS as `0x${string}`, 
                        value: "0", 
                        data: ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]) as `0x${string}`, 
                        operation: OperationType.Call 
                    });
                }
            } catch (e) {
                // If we can't check, add to batch anyway
                this.logger.warn(`     ⚠️ Could not check ${operator.name} approval, adding to batch`);
                batch.push({ 
                    to: CTF_CONTRACT_ADDRESS as `0x${string}`, 
                    value: "0", 
                    data: ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]) as `0x${string}`, 
                    operation: OperationType.Call 
                });
            }
        }

        // 3. EXECUTE ATOMIC BATCH
        if (batch.length > 0) {
            this.logger.info(`   🚀 Executing Atomic Approval Batch (${batch.length} actions)...`);
            try {
                const task = await this.relayClient.execute(batch);
                await task.wait();
                this.logger.success(`   ✅ All permissions synchronized.`);
            } catch (e: any) {
                this.logger.error(`❌ Batch Approval Failed: ${e.message}`);
                throw e;
            }
        } else {
            this.logger.info(`   ✅ Permissions already sufficient.`);
        }
    }

    public async withdrawUSDC(to: string, amount: string): Promise<string> {
        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const tx: SafeTransaction = { 
            to: TOKENS.USDC_BRIDGED as `0x${string}`, 
            value: "0", 
            data: data as `0x${string}`, 
            operation: OperationType.Call 
        };
        
        const task = await this.relayClient.execute([tx]);
        const result = await task.wait();
        return (result as any).transactionHash || "0x...";
    }

    public async addOwner(newOwnerAddress: string): Promise<string> {
        this.logger.info(`🛡️ Adding Recovery Owner: ${newOwnerAddress} to Safe ${this.safeAddress}`);

        const isOwner = await this.rpcCall(async () => {
            return await this.viemPublicClient.readContract({
                address: this.safeAddress as `0x${string}`,
                abi: parseAbi(SAFE_ABI),
                functionName: 'isOwner',
                args: [newOwnerAddress]
            }) as boolean;
        }, 'isOwner check');

        if (isOwner) {
            this.logger.info("   Address is already an owner.");
            return "ALREADY_OWNER";
        }

        const safeInterface = new Interface(SAFE_ABI);
        const data = safeInterface.encodeFunctionData("addOwnerWithThreshold", [newOwnerAddress, 1]);
        
        const tx: SafeTransaction = { 
            to: this.safeAddress as `0x${string}`, 
            value: "0", 
            data: data as `0x${string}`, 
            operation: OperationType.Call 
        };
        
        const task = await this.relayClient.execute([tx]);
        const result = await task.wait();
        
        this.logger.success(`   ✅ Owner Added! Tx: ${(result as any).transactionHash}`);
        return (result as any).transactionHash;
    }

    public async deploySafeOnChain(): Promise<string> {
        this.logger.warn(`🏗️ STARTING ON-CHAIN RESCUE DEPLOYMENT...`);
        
        if (!this.signer.provider) throw new Error("No provider for deployment");

        const gasBal = await this.signer.provider.getBalance(this.signer.address);
        if (gasBal < 100000000000000000n) {
            throw new Error("Insufficient POL (Matic) in Signer wallet to deploy Safe. Please send ~0.2 POL to " + this.signer.address);
        }

        const safeInterface = new Interface(SAFE_ABI);
        const owners = [this.signer.address];
        const threshold = 1;
        const to = "0x0000000000000000000000000000000000000000";
        const data = "0x";
        const fallbackHandler = FALLBACK_HANDLER_ADDRESS;
        const paymentToken = "0x0000000000000000000000000000000000000000";
        const payment = 0;
        const paymentReceiver = "0x0000000000000000000000000000000000000000";

        const initializer = safeInterface.encodeFunctionData("setup", [
            owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver
        ]);

        const factory = new Contract(POLYMARKET_SAFE_FACTORY, PROXY_FACTORY_ABI, this.signer);
        const saltNonce = 0; 

        this.logger.info(`   🚀 Sending Deployment Transaction...`);
        const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, initializer, saltNonce);
        await tx.wait();
        this.logger.success(`   ✅ Safe Deployed Successfully!`);
        
        return this.safeAddress;
    }

    public async withdrawUSDCOnChain(to: string, amount: string): Promise<string> {
        const innerData = new Interface(ERC20_ABI).encodeFunctionData("transfer", [to, amount]);
        return await this.executeOnChain(TOKENS.USDC_BRIDGED, 0, innerData);
    }

    public async withdrawNativeOnChain(to: string, amount: string): Promise<string> {
        const amountInWei = ethers.parseEther(amount);
        return await this.executeOnChain(to, amountInWei, "0x");
    }

    private async executeOnChain(to: string, value: bigint | number | string, data: string): Promise<string> {
        const safeAddr = this.safeAddress;
        this.logger.warn(`🚨 RESCUE MODE: Executing direct on-chain transaction from ${safeAddr}...`);
        
        if (!this.signer.provider) {
             throw new Error("Signer has no provider. Cannot execute on-chain.");
        }

        const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
        const safeInterface = new Interface(SAFE_ABI);
        const safeContract = new Contract(safeAddr, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();

        const txHash = await safeContract.getTransactionHash(
            to, value, data, 0, 0, 0, 0,
            ZERO_ADDRESS, ZERO_ADDRESS, nonce
        );

        const signingKey = new ethers.SigningKey(this.signer.privateKey);
        const rawSig = signingKey.sign(txHash);

        const vValue = rawSig.v >= 27 ? rawSig.v : rawSig.v + 27;
        const signature = ethers.concat([
            rawSig.r,
            rawSig.s,
            ethers.toBeHex(vValue, 1)
        ]);

        const execData = safeInterface.encodeFunctionData("execTransaction", [
            to, value, data, 0, 0, 0, 0, ZERO_ADDRESS, ZERO_ADDRESS, signature
        ]);

        const feeData = await this.signer.provider.getFeeData();
        
        this.logger.info(`   🚀 Sending Rescue Transaction (Manual Data Encoding)...`);
        const tx = await this.signer.sendTransaction({
            to: safeAddr,
            data: execData,
            gasLimit: 600000,
            gasPrice: feeData.gasPrice 
        });
        
        this.logger.success(`   ✅ Rescue Tx Sent: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
    }

    public async checkOutcomeTokenApproval(safeAddress: string, operatorAddress: string): Promise<boolean> {
        return this.rpcCall(async () => {
            const isApproved = await this.viemPublicClient.readContract({
                address: CTF_CONTRACT_ADDRESS,
                abi: parseAbi(ERC1155_ABI),
                functionName: 'isApprovedForAll',
                args: [safeAddress as `0x${string}`, operatorAddress as `0x${string}`]
            }) as boolean;
            return isApproved;
        }, 'checkOutcomeTokenApproval');
    }

    public async approveOutcomeTokens(operatorAddress: string, isNegRisk: boolean): Promise<void> {
        const ctfInterface = new Interface(ERC1155_ABI);
        const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operatorAddress, true]);
        
        const tx: SafeTransaction = { 
            to: CTF_CONTRACT_ADDRESS as `0x${string}`, 
            value: "0", 
            data: data as `0x${string}`, 
            operation: OperationType.Call 
        };
        
        const task = await this.relayClient.execute([tx]);
        await task.wait();
        
        this.logger.success(`   ✅ Approved ${isNegRisk ? 'Neg Risk' : 'CTF'} Exchange for outcome tokens`);
    }

    public async executeTransaction(tx: { to: string; data: string; value: string }): Promise<string> {
        const safeTx: SafeTransaction = { 
            to: tx.to as `0x${string}`, 
            value: tx.value as `0x${string}`, 
            data: tx.data as `0x${string}`, 
            operation: OperationType.Call 
        };
        
        const task = await this.relayClient.execute([safeTx]);
        const result = await task.wait();
        return (result as any).transactionHash || "0x...";
    }
}