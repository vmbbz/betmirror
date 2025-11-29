
import { BrowserProvider, Contract, parseUnits, Eip1193Provider } from 'ethers';
import { createWalletClient, custom, WalletClient } from 'viem';
import { polygon } from 'viem/chains';

export const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
export const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
];

export class Web3Service {
  private provider: BrowserProvider | null = null;
  private signer: any = null;
  private viemClient: WalletClient | null = null;

  async connect(): Promise<string> {
    if (!(window as any).ethereum) {
      throw new Error("No wallet found. Please install MetaMask, Rabbit, or Coinbase Wallet.");
    }

    this.provider = new BrowserProvider((window as any).ethereum as Eip1193Provider);
    await this.provider.send("eth_requestAccounts", []);
    this.signer = await this.provider.getSigner();
    
    // Auto-switch to Polygon on connect for best UX
    await this.switchToChain(137);

    return await this.signer.getAddress();
  }

  /**
   * Returns a Viem Wallet Client (Required for ZeroDev / AA)
   * Automatically enforces the correct chain context.
   */
  async getViemWalletClient(targetChainId: number = 137): Promise<WalletClient> {
      if (!(window as any).ethereum) throw new Error("No Wallet");

      // CRITICAL: Force switch before creating client to prevent "Provider not connected to requested chain" error
      await this.switchToChain(targetChainId);
      
      const [account] = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
          
      // Always recreate the client to ensure it binds to the freshly switched provider context
      this.viemClient = createWalletClient({
        account,
        chain: polygon, // ZeroDev expects Polygon
        transport: custom((window as any).ethereum)
      });
      
      return this.viemClient;
  }

  async switchToChain(chainId: number) {
      if(!this.provider) {
          this.provider = new BrowserProvider((window as any).ethereum as Eip1193Provider);
      }
      
      const hexChainId = "0x" + chainId.toString(16);
      
      try {
          await this.provider!.send("wallet_switchEthereumChain", [{ chainId: hexChainId }]);
      } catch (switchError: any) {
          // Error 4902: Chain not added. Add it.
          // Also catch generic -32603 which sometimes happens on mobile wallets
          if (switchError.code === 4902 || switchError.code === -32603 || switchError.data?.originalError?.code === 4902 || switchError.message?.includes("Unrecognized chain")) {
             const chainConfig = this.getChainConfig(chainId);
             if(chainConfig) {
                 try {
                    await this.provider!.send("wallet_addEthereumChain", [chainConfig]);
                 } catch (addError: any) {
                    throw new Error(`Failed to add network: ${addError.message}`);
                 }
             } else {
                 throw new Error(`Chain ID ${chainId} configuration not found.`);
             }
          } else {
              throw switchError;
          }
      }
  }

  async deposit(toAddress: string, amount: string): Promise<string> {
      if (!this.signer) await this.connect();
      // Ensure we are on Polygon for direct deposit
      await this.switchToChain(137);
      
      // Refresh signer after switch to avoid "underlying network changed" errors
      this.signer = await this.provider?.getSigner();

      const usdc = new Contract(USDC_POLYGON, USDC_ABI, this.signer);
      const decimals = await usdc.decimals();
      const amountUnits = parseUnits(amount, decimals);
      
      const tx = await usdc.transfer(toAddress, amountUnits);
      await tx.wait();
      return tx.hash;
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
}

export const web3Service = new Web3Service();
