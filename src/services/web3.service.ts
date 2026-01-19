import { BrowserProvider, Contract, formatUnits, parseUnits, parseEther, Eip1193Provider } from 'ethers';
import { createWalletClient, custom, WalletClient } from 'viem';
import { polygon } from 'viem/chains';

// NATIVE USDC (Circle Standard) - Used for Main Wallet, Deposits from Exchanges
export const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; 

// BRIDGED USDC (USDC.e) - Used for Polymarket Trading
export const USDC_BRIDGED_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

// ABI for the proxy contract's deposit function
export const PROXY_ABI = [
  'function deposit(address token, uint256 amount) external',
  'event Deposit(address indexed token, address indexed user, uint256 amount, uint256 balance)'
];

export class Web3Service {
  private provider: BrowserProvider | null = null;
  private viemClient: WalletClient | null = null;

  async connect(): Promise<string> {
    if (!(window as any).ethereum) {
      throw new Error("No wallet found. Please install MetaMask or Phantom.");
    }

    try {
        const accounts = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
        this.provider = new BrowserProvider((window as any).ethereum as Eip1193Provider);
        
        try {
            await this.switchToChain(137);
        } catch (e) {
            console.warn("Auto-switch failed on connect:", e);
        }

        return accounts[0];
    } catch (e: any) {
        if (e.code === -32002) throw new Error("Connection request already pending.");
        if (e.code === 4001) throw new Error("Connection rejected by user.");
        throw e;
    }
  }

  async getViemWalletClient(targetChainId: number = 137): Promise<WalletClient> {
      if (!(window as any).ethereum) throw new Error("No Wallet");
      const provider = (window as any).ethereum;
      await this.ensureChain(provider, targetChainId);
      const [account] = await provider.request({ method: 'eth_requestAccounts' });
      this.viemClient = createWalletClient({
        account,
        chain: polygon,
        transport: custom(provider as any)
      }) as unknown as WalletClient;
      return this.viemClient;
  }

  private async ensureChain(provider: any, targetChainId: number): Promise<void> {
      const currentChainIdHex = await provider.request({ method: 'eth_chainId' });
      if (parseInt(currentChainIdHex, 16) !== targetChainId) {
          await this.switchToChain(targetChainId);
      }
  }

  async switchToChain(chainId: number) {
      const provider = (window as any).ethereum;
      if (!provider) return;
      
      const hexChainId = "0x" + chainId.toString(16);
      try {
          await provider.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: hexChainId }],
          });
      } catch (switchError: any) {
          if (switchError.code === 4902 || switchError.message?.includes("Unrecognized chain")) {
             const chainConfig = this.getChainConfig(chainId);
             if(chainConfig) {
                 await provider.request({
                    method: "wallet_addEthereumChain",
                    params: [chainConfig],
                 });
             }
          } else {
              throw switchError;
          }
      }
  }

    async depositErc20(toAddress: string, amount: string, tokenAddress: string): Promise<string> {
        console.log(`[Web3Service] Initiating ERC20 deposit: ${amount} to ${toAddress}`);
        
        if (!(window as any).ethereum) throw new Error("Wallet not detected");
        
        // 1. Ensure fresh provider/signer
        const browserProvider = new BrowserProvider((window as any).ethereum);
        await this.switchToChain(137);
        const signer = await browserProvider.getSigner();

        // 2. Setup contract
        const tokenContract = new Contract(tokenAddress, USDC_ABI, signer);
        
        try {
            const decimals = await tokenContract.decimals();
            const amountUnits = parseUnits(amount, decimals);
            
            // 3. Balance Check
            const balance = await tokenContract.balanceOf(await signer.getAddress());
            if (balance < amountUnits) {
                throw new Error(`Insufficient balance. You have ${formatUnits(balance, decimals)} USDC`);
            }

            // 4. Polygon Gas Optimization
            // Polygon RPCs often under-estimate gas prices. We fetch current and add a 20% buffer.
            const feeData = await browserProvider.getFeeData();
            const gasPrice = feeData.gasPrice ? (feeData.gasPrice * 120n) / 100n : undefined;

            console.log(`[Web3Service] Sending transfer transaction...`);
            const tx = await tokenContract.transfer(toAddress, amountUnits, {
                gasPrice: gasPrice
            });
            
            console.log(`[Web3Service] Transaction sent: ${tx.hash}. Waiting for confirmation...`);
            const receipt = await tx.wait();
            
            if (receipt.status === 0) throw new Error("Transaction reverted on-chain.");
            
            console.log('[Web3Service] Deposit confirmed successfully.');
            return tx.hash;
        } catch (e: any) {
            console.error("[Web3Service] Deposit failed:", e);
            throw this.parseError(e);
        }
    }

  async depositNative(toAddress: string, amount: string): Promise<string> {
      if (!(window as any).ethereum) throw new Error("Wallet not detected");
      
      const browserProvider = new BrowserProvider((window as any).ethereum);
      await this.switchToChain(137);
      const signer = await browserProvider.getSigner();

      try {
          const amountUnits = parseEther(amount);
          const feeData = await browserProvider.getFeeData();
          const gasPrice = feeData.gasPrice ? (feeData.gasPrice * 120n) / 100n : undefined;

          const tx = await signer.sendTransaction({
              to: toAddress,
              value: amountUnits,
              gasPrice: gasPrice
          });
          await tx.wait();
          return tx.hash;
      } catch (e: any) {
          throw this.parseError(e);
      }
  }

  async deposit(toAddress: string, amount: string): Promise<string> {
      return this.depositErc20(toAddress, amount, USDC_POLYGON);
  }

  async getSolanaAddress(): Promise<string | null> {
    try {
        const solana = (window as any).solana;
        if (solana) {
            if (!solana.isConnected) await solana.connect(); 
            if (solana.publicKey) return solana.publicKey.toString();
        }
        return null;
    } catch (e) {
        console.error("Solana connection failed:", e);
        return null;
    }
  }

  private getChainConfig(chainId: number) {
      // Basic configs for popular chains
      if (chainId === 137) return {
          chainId: "0x89",
          chainName: "Polygon Mainnet",
          nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
          rpcUrls: ["https://polygon-rpc.com/"],
          blockExplorerUrls: ["https://polygonscan.com/"]
      };
      if (chainId === 56) return {
          chainId: "0x38",
          chainName: "BNB Smart Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://bsc-dataseed.binance.org/"],
          blockExplorerUrls: ["https://bscscan.com/"]
      };
      if (chainId === 8453) return {
          chainId: "0x2105",
          chainName: "Base Mainnet",
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://mainnet.base.org"],
          blockExplorerUrls: ["https://basescan.org"]
      };
      if (chainId === 42161) return {
          chainId: "0xA4B1",
          chainName: "Arbitrum One",
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://arb1.arbitrum.io/rpc"],
          blockExplorerUrls: ["https://arbiscan.io"]
      };
      return null;
  }

  private parseError(e: any): Error {
      if (e.code === 'ACTION_REJECTED') return new Error("Transaction rejected in wallet.");
      if (e.code === 'INSUFFICIENT_FUNDS') return new Error("Insufficient POL (Matic) for gas fees.");
      if (e.message?.includes('estimateGas') || e.message?.includes('revert')) {
          return new Error("Transaction would fail. Check your USDC balance and try again.");
      }
      return e;
  }
}

export const web3Service = new Web3Service();