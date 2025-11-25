
import axios from 'axios';
import { TraderProfile } from '../domain/alpha.types';

/**
 * Client-side service to talk to the Global Registry API.
 * Uses relative paths by default to support production deployments where frontend and backend share a domain.
 */
export class AlphaRegistryService {
  private apiUrl: string = '/api';

  constructor(apiUrl?: string) {
    if(apiUrl) this.apiUrl = apiUrl;
  }

  setApiUrl(url: string) {
    this.apiUrl = url;
  }

  async getRegistry(): Promise<TraderProfile[]> {
    try {
      const res = await axios.get<TraderProfile[]>(`${this.apiUrl}/registry`);
      return res.data;
    } catch (error) {
      console.error('Failed to fetch registry:', error);
      return [];
    }
  }

  async getListerForWallet(walletAddress: string): Promise<string | null> {
    try {
        const res = await axios.get<TraderProfile>(`${this.apiUrl}/registry/${walletAddress}`);
        return res.data.listedBy;
    } catch (e) {
        return null;
    }
  }

  async addWallet(targetAddress: string, finderAddress: string): Promise<{ success: boolean; message: string; profile?: TraderProfile }> {
    try {
      const res = await axios.post(`${this.apiUrl}/registry`, {
        address: targetAddress,
        listedBy: finderAddress
      });
      return { success: true, message: 'Wallet Listed Successfully', profile: res.data.profile };
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message;
      return { success: false, message: msg };
    }
  }
}

export const alphaRegistry = new AlphaRegistryService();
