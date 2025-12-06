
import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  http,
  Hex,
  createPublicClient,
  PublicClient,
  WalletClient,
  encodeFunctionData,
  parseAbi
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

// Constants
const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
const CHAIN = polygon;

// Default Public RPC (Polygon)
const PUBLIC_RPC = "https://polygon-rpc.com";

// POLYGON BRIDGED USDC (USDC.e) - The gas token
const GAS_TOKEN_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const USDC_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)"
]);

export class ZeroDevService {
  private publicClient: PublicClient;
  private bundlerRpc: string;
  private paymasterRpc: string;

  constructor(zeroDevRpcUrlOrId: string, paymasterRpcUrl?: string) {
    // --- AUTO-CORRECT RPC URL ---
    this.bundlerRpc = this.normalizeRpcUrl(zeroDevRpcUrlOrId);
    // Use explicit paymaster URL if provided, otherwise default to bundler URL
    this.paymasterRpc = paymasterRpcUrl || this.bundlerRpc;
    
    console.log(`[ZeroDev] Bundler RPC: ${this.bundlerRpc}`);
    if (paymasterRpcUrl) {
        console.log(`[ZeroDev] Paymaster RPC: ${this.paymasterRpc}`);
    }

    this.publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(PUBLIC_RPC),
    }) as unknown as PublicClient;
  }

  private normalizeRpcUrl(input: string): string {
      // 1. Extract UUID (Project ID)
      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const match = input.match(uuidRegex);
      
      if (!match) {
          // If no UUID, assume it's a full URL or fallback
          return input; 
      }

      const projectId = match[0];

      // 2. Check if it's already a v3 URL for Polygon
      if (input.includes("/api/v3") && input.includes("/chain/137")) {
          return input;
      }

      // 3. Construct proper v3 URL
      return `https://rpc.zerodev.app/api/v3/${projectId}/chain/137`;
  }

  /**
   * Predicts the deterministic address of the Smart Account for this user.
   */
  async computeMasterAccountAddress(ownerWalletClient: WalletClient) {
      try {
          if (!ownerWalletClient) throw new Error("Missing owner wallet client");

          const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
              entryPoint: ENTRY_POINT,
              signer: ownerWalletClient as any,
              kernelVersion: KERNEL_VERSION,
          });

          const account = await createKernelAccount(this.publicClient as any, {
              entryPoint: ENTRY_POINT,
              plugins: { sudo: ecdsaValidator },
              kernelVersion: KERNEL_VERSION,
          });

          return account.address;
      } catch (e: any) {
          console.error("Failed to compute deterministic address (ZeroDev):", e.message);
          return null;
      }
  }

  /**
   * CLIENT SIDE: Create Session Key
   */
  async createSessionKeyForServer(ownerWalletClient: WalletClient, ownerAddress: string) {
    console.log("🔐 Generating Session Key...");

    // 1. Generate a temporary private key for the session (The "Server Key")
    const sessionPrivateKey = generatePrivateKey();
    const sessionKeyAccount = privateKeyToAccount(sessionPrivateKey);
    
    // 2. Prepare the Session Signer
    const sessionKeySigner = await toECDSASigner({
      signer: sessionKeyAccount,
    });

    // 3. Create/Resolve the Master Smart Account (Kernel)
    const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: ownerWalletClient as any, 
      kernelVersion: KERNEL_VERSION,
    });

    // 4. Create the Permission Plugin
    const permissionPlugin = await toPermissionValidator(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      signer: sessionKeySigner,
      policies: [
        toSudoPolicy({}), // Allow everything for this session key
      ],
      kernelVersion: KERNEL_VERSION,
    });

    // 5. Create the Session Key Account Object
    const sessionKeyAccountObj = await createKernelAccount(this.publicClient as any, {
      entryPoint: ENTRY_POINT,
      plugins: {
        sudo: ecdsaValidator,
        regular: permissionPlugin,
      },
      kernelVersion: KERNEL_VERSION,
    });

    const accountAddress = sessionKeyAccountObj.address;
    
    const serializedSessionKey = await serializePermissionAccount(sessionKeyAccountObj, sessionPrivateKey);

    return {
      smartAccountAddress: accountAddress,
      serializedSessionKey: serializedSessionKey,
      sessionPrivateKey: sessionPrivateKey 
    };
  }

  /**
   * SERVER SIDE: Create Bot Client (with Paymaster)
   */
  async createBotClient(serializedSessionKey: string) {
    // 1. Deserialize the account
    const sessionKeyAccount = await deserializePermissionAccount(
      this.publicClient as any,
      ENTRY_POINT,
      KERNEL_VERSION,
      serializedSessionKey
    );

    // 2. Create Paymaster with DEDICATED RPC
    const paymasterClient = createZeroDevPaymasterClient({
      chain: CHAIN,
      transport: http(this.paymasterRpc), // Use self-funded RPC if configured
    });

    // 3. Create the Kernel Client
    const kernelClient = createKernelAccountClient({
      account: sessionKeyAccount,
      chain: CHAIN,
      bundlerTransport: http(this.bundlerRpc),
      client: this.publicClient as any,
      paymaster: {
        getPaymasterData(userOperation) {
          return paymasterClient.sponsorUserOperation({ 
            userOperation,
            gasToken: GAS_TOKEN_ADDRESS // <--- FORCE USDC GAS PAYMENT
          });
        },
      },
    });

    return {
        address: sessionKeyAccount.address,
        client: kernelClient
    };
  }

  /**
   * CLIENT SIDE: Trustless Withdrawal (with Paymaster Support)
   */
  async withdrawFunds(ownerWalletClient: WalletClient, smartAccountAddress: string, toAddress: string, amount: bigint, tokenAddress: string) {
      console.log("Initiating Trustless Withdrawal...");
      
      // 1. Create the Validator using the Owner's Wallet
      const ecdsaValidator = await signerToEcdsaValidator(this.publicClient as any, {
        entryPoint: ENTRY_POINT,
        signer: ownerWalletClient as any,
        kernelVersion: KERNEL_VERSION,
      });

      // 2. Reconstruct the Account
      const account = await createKernelAccount(this.publicClient as any, {
        entryPoint: ENTRY_POINT,
        plugins: {
          sudo: ecdsaValidator,
        },
        kernelVersion: KERNEL_VERSION,
        address: smartAccountAddress as Hex,
      });
      
      // 3. Create Paymaster Client with DEDICATED RPC
      const paymasterClient = createZeroDevPaymasterClient({
        chain: CHAIN,
        transport: http(this.paymasterRpc), // Use self-funded RPC if configured
      });

      // 4. Detect Token Type (Native vs ERC20)
      const isNative = tokenAddress === '0x0000000000000000000000000000000000000000';
      
      let callData: Hex;
      let value: bigint = BigInt(0);
      let target: Hex;

      if (isNative) {
          // Native Transfer (POL)
          callData = "0x"; 
          value = amount;
          target = toAddress as Hex;
      } else {
          // ERC20 Transfer (USDC)
          callData = encodeFunctionData({
              abi: USDC_ABI,
              functionName: "transfer",
              args: [toAddress as Hex, amount]
          });
          target = tokenAddress as Hex;
      }

      console.log(`Sending UserOp: Transfer ${amount} units of ${isNative ? 'POL' : tokenAddress} to ${toAddress}`);

      // 5. Attempt with Paymaster (Gas Token)
      try {
          const kernelClient = createKernelAccountClient({
            account,
            chain: CHAIN,
            bundlerTransport: http(this.bundlerRpc),
            client: this.publicClient as any,
            paymaster: {
                getPaymasterData(userOperation) {
                    return paymasterClient.sponsorUserOperation({ 
                        userOperation,
                        gasToken: GAS_TOKEN_ADDRESS 
                    });
                },
            },
          });

          const userOpHash = await kernelClient.sendUserOperation({
            callData: await account.encodeCalls([
              {
                to: target,
                value: value,
                data: callData,
              },
            ]),
          } as any);

          console.log("UserOp Hash (Paymaster):", userOpHash);
          const receipt = await this.publicClient.waitForTransactionReceipt({ hash: userOpHash });
          return receipt.transactionHash;

      } catch (e: any) {
          console.warn("Paymaster failed (likely not whitelisted or insufficient USDC). Retrying with Native Gas...", e.message);
          
          // 6. Fallback: Standard UserOp (User pays Gas in POL)
          const kernelClientFallback = createKernelAccountClient({
            account,
            chain: CHAIN,
            bundlerTransport: http(this.bundlerRpc),
            client: this.publicClient as any,
          });

          const userOpHash = await kernelClientFallback.sendUserOperation({
            callData: await account.encodeCalls([
              {
                to: target,
                value: value,
                data: callData,
              },
            ]),
          } as any);
          
          console.log("UserOp Hash (Self-Funded):", userOpHash);
          const receipt = await this.publicClient.waitForTransactionReceipt({ hash: userOpHash });
          return receipt.transactionHash;
      }
  }
}
