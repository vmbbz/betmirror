import axios, { AxiosRequestConfig } from 'axios';
import { MARKET_RATE_LIMITER } from './rate-limiter.util.js';

export async function httpGet<T = unknown>(url: string, config?: AxiosRequestConfig) {
  const res = await axios.get<T>(url, config);
  return res.data;
}

export async function httpPost<T = unknown>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
) {
  const res = await axios.post<T>(url, body, config);
  return res.data;
}

export async function getMarket(marketId: string) {
  return await MARKET_RATE_LIMITER.add(async () => {
    const res = await axios.get(`https://clob.polymarket.com/markets/${marketId}`);
    return res.data;
  });
}