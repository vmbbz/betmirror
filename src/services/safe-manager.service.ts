import { Wallet, Interface, Contract, ethers, JsonRpcProvider } from 'ethers';
import { RelayClient, SafeTransaction, OperationType } from '@polymarket/builder-relayer-client';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive.js';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { POLYGON_CHAIN_ID, TOKENS } from '../config/env.js';
import { Logger } from '../utils/logger.util.js';
import axios from 'axios';

// --- Constants ---
const RELAYER_URL = "https://relayer-v2.polymarket.com";

// Polymarket Core Contracts
const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// Gnosis Safe Factories
const POLYMARKET_SAFE_FACTORY = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b"; 
const STANDARD_SAFE_FACTORY = "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2"; // Legacy/Standard Gnosis

// Use Polymarket as default for new deployments, but check both
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

const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

// ABIs
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];
const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address account, address operator) view returns (bool)"
];

export class SafeManagerService {
    private relayClient: RelayClient;
    private safeAddress: string; // Source of Truth
    private viemPublicClient: any;

    constructor(
        private signer: Wallet, // Ethers V6 Wallet
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

        const account = privateKeyToAccount(signer.privateKey as `0x${string}`);
        const viemClient = createWalletClient({
            account,
            chain: polygon,
            transport: http('https://polygon-rpc.com')
        });
        
        this.viemPublicClient = createPublicClient({
            chain: polygon,
            transport: http('https://polygon-rpc.com')
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
     * SMART ADDRESS DERIVATION
     * Prioritizes Standard Gnosis factory for sovereignty as requested.
     */
    public static async computeAddress(ownerAddress: string): Promise<string> {
        const stdSafe = await deriveSafe(ownerAddress, STANDARD_SAFE_FACTORY);
        const polySafe = await deriveSafe(ownerAddress, POLYMARKET_SAFE_FACTORY);

        try {
            const provider = new JsonRpcProvider('https://polygon-rpc.com');
            const stdCode = await provider.getCode(stdSafe);
            if (stdCode && stdCode !== '0x') return stdSafe;
            
            const polyCode = await provider.getCode(polySafe);
            if (polyCode && polyCode !== '0x') return polySafe;
        } catch (e) {
            console.warn("[SafeManager] Failed to check code on-chain, defaulting to Standard factory.");
        }

        return stdSafe;
    }

    public async isDeployed(): Promise<boolean> {
        try {
            const code = await this.viemPublicClient.getBytecode({ address: this.safeAddress });
            return (code && code !== '0x');
        } catch(e) { return false; }
    }

    public async deploySafe(): Promise<string> {
        if (await this.isDeployed()) {
            this.logger.info(`   Safe ${this.safeAddress.slice(0,8)}... is active.`);
            return this.safeAddress;
        }

        this.logger.info(`🚀 Deploying Safe ${this.safeAddress.slice(0,8)}...`);

        try {
            const task = await this.relayClient.deploy();
            await task.wait(); 
            const realAddress = (task as any).proxyAddress;
            return realAddress || this.safeAddress;
        } catch (e: any) {
            if (e.message?.toLowerCase().includes("already deployed")) return this.safeAddress;
            return await this.deploySafeOnChain();
        }
    }

    /**
     * Core Signature Helper for Gnosis Safe EOA Signers.
     * Fixes GS026 by adjusting the v value (+4) as required by Gnosis for ECDSA.
     */
    private async signSafeTransaction(txHash: string): Promise<string> {
        const signature = await this.signer.signMessage(ethers.getBytes(txHash));
        let sigBytes = ethers.getBytes(signature);
        // Gnosis v adjustment: if v is 27/28, add 4 to make it 31/32 for SignatureType.EthSign
        if (sigBytes[64] < 27) sigBytes[64] += 27;
        sigBytes[64] += 4;
        return ethers.hexlify(sigBytes);
    }

    public async enableApprovals(): Promise<void> {
        const usdcInterface = new Interface(ERC20_ABI);
        const ctfInterface = new Interface(ERC1155_ABI);

        this.logger.info(`   Checking permissions for ${this.safeAddress.slice(0,8)}...`);

        const usdcSpenders = [
            { addr: CTF_CONTRACT_ADDRESS, name: "CTF" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" },
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" }
        ];

        for (const spender of usdcSpenders) {
            try {
                const allowance = await this.viemPublicClient.readContract({
                    address: TOKENS.USDC_BRIDGED,
                    abi: parseAbi(ERC20_ABI),
                    functionName: 'allowance',
                    args: [this.safeAddress, spender.addr]
                }) as bigint;

                if (allowance < 1000000000n) {
                    this.logger.info(`     + Granting USDC to ${spender.name}`);
                    const data = usdcInterface.encodeFunctionData("approve", [spender.addr, MAX_UINT256]);
                    await this.executeTransactionViaApi({ 
                        to: TOKENS.USDC_BRIDGED, 
                        value: "0", 
                        data: data, 
                        operation: OperationType.Call 
                    });
                }
            } catch (e: any) { this.logger.error(`Failed to approve ${spender.name}`); }
        }

        const ctfOperators = [
            { addr: CTF_EXCHANGE_ADDRESS, name: "CTFExchange" },
            { addr: NEG_RISK_CTF_EXCHANGE_ADDRESS, name: "NegRiskExchange" },
            { addr: NEG_RISK_ADAPTER_ADDRESS, name: "NegRiskAdapter" }
        ];

        for (const operator of ctfOperators) {
             try {
                const isApproved = await this.viemPublicClient.readContract({
                    address: CTF_CONTRACT_ADDRESS,
                    abi: parseAbi(ERC1155_ABI),
                    functionName: 'isApprovedForAll',
                    args: [this.safeAddress, operator.addr]
                }) as boolean;

                if (!isApproved) {
                    this.logger.info(`     + Granting Operator to ${operator.name}`);
                    const data = ctfInterface.encodeFunctionData("setApprovalForAll", [operator.addr, true]);
                    await this.executeTransactionViaApi({ 
                        to: CTF_CONTRACT_ADDRESS, 
                        value: "0", 
                        data: data, 
                        operation: OperationType.Call 
                    });
                }
            } catch (e: any) { this.logger.error(`Failed to set operator ${operator.name}`); }
        }
    }

    public async withdrawUSDC(to: string, amount: string): Promise<string> {
        const usdcInterface = new Interface(ERC20_ABI);
        const data = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const tx: SafeTransaction = { to: TOKENS.USDC_BRIDGED, value: "0", data, operation: OperationType.Call };
        
        this.logger.info(`💸 Withdrawing USDC via Relayer...`);
        try {
            return await this.executeTransactionViaApi(tx);
        } catch (e: any) {
            this.logger.warn(`Relayer failed, trying rescue mode...`);
            return await this.withdrawUSDCOnChain(to, amount);
        }
    }

    public async withdrawNative(to: string, amount: string): Promise<string> {
        const tx: SafeTransaction = { to, value: amount, data: "0x", operation: OperationType.Call };
        this.logger.info(`💸 Withdrawing POL via Relayer...`);
        try {
            return await this.executeTransactionViaApi(tx);
        } catch (e: any) {
            return await this.withdrawNativeOnChain(to, amount);
        }
    }

    private async executeTransactionViaApi(safeTx: SafeTransaction): Promise<string> {
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();

        const txHashBytes = await safeContract.getTransactionHash(
            safeTx.to, safeTx.value, safeTx.data, safeTx.operation, 0, 0, 0, 
            ethers.ZeroAddress, ethers.ZeroAddress, nonce
        );

        const signature = await this.signSafeTransaction(txHashBytes);

        const payload = {
            safeTxHash: txHashBytes,
            signature,
            safeTx: {
                to: safeTx.to,
                value: safeTx.value,
                data: safeTx.data,
                operation: safeTx.operation,
                safeTxGas: 0,
                baseGas: 0,
                gasPrice: 0,
                gasToken: ethers.ZeroAddress,
                refundReceiver: ethers.ZeroAddress,
                nonce: Number(nonce)
            },
            proxyWallet: this.safeAddress 
        };

        try {
            const response = await axios.post(`${RELAYER_URL}/transactions`, payload);
            return response.data.transactionHash;
        } catch (error: any) {
            throw new Error(error.response?.data?.message || "Relayer API Failed");
        }
    }

    public async addOwner(newOwnerAddress: string): Promise<string> {
        this.logger.info(`🛡️ Adding Recovery Owner: ${newOwnerAddress}`);
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        if (await safeContract.isOwner(newOwnerAddress)) return "ALREADY_OWNER";

        const innerData = new Interface(SAFE_ABI).encodeFunctionData("addOwnerWithThreshold", [newOwnerAddress, 1]);
        const nonce = await safeContract.nonce();
        const txHash = await safeContract.getTransactionHash(this.safeAddress, 0, innerData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);

        const signature = await this.signSafeTransaction(txHash);
        const tx = await safeContract.execTransaction(this.safeAddress, 0, innerData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature);
        await tx.wait();
        return tx.hash;
    }

    public async deploySafeOnChain(): Promise<string> {
        this.logger.warn(`🏗️ STARTING ON-CHAIN RESCUE DEPLOYMENT...`);
        const gasBal = await this.signer.provider!.getBalance(this.signer.address);
        if (gasBal < ethers.parseEther("0.1")) throw new Error("Need POL for gas.");

        const initializer = new Interface(SAFE_ABI).encodeFunctionData("setup", [[this.signer.address], 1, ethers.ZeroAddress, "0x", FALLBACK_HANDLER_ADDRESS, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
        const factory = new Contract(STANDARD_SAFE_FACTORY, PROXY_FACTORY_ABI, this.signer);
        const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, initializer, 0);
        await tx.wait();
        return this.safeAddress;
    }

    public async withdrawUSDCOnChain(to: string, amount: string): Promise<string> {
        this.logger.warn(`🚨 RESCUE MODE: Executing on-chain withdrawal...`);
        const usdcInterface = new Interface(ERC20_ABI);
        const innerData = usdcInterface.encodeFunctionData("transfer", [to, amount]);
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();

        const txHash = await safeContract.getTransactionHash(TOKENS.USDC_BRIDGED, 0, innerData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
        const signature = await this.signSafeTransaction(txHash);
        const tx = await safeContract.execTransaction(TOKENS.USDC_BRIDGED, 0, innerData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature);
        await tx.wait();
        return tx.hash;
    }

    public async withdrawNativeOnChain(to: string, amount: string): Promise<string> {
        this.logger.warn(`🚨 RESCUE MODE: Executing on-chain POL withdrawal...`);
        const safeContract = new Contract(this.safeAddress, SAFE_ABI, this.signer);
        const nonce = await safeContract.nonce();

        const txHash = await safeContract.getTransactionHash(to, amount, "0x", 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
        const signature = await this.signSafeTransaction(txHash);
        const tx = await safeContract.execTransaction(to, amount, "0x", 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature);
        await tx.wait();
        return tx.hash;
    }
}
