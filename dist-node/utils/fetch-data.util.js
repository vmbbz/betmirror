import axios from 'axios';
import { MARKET_RATE_LIMITER } from './rate-limiter.util.js';
export async function httpGet(url, config) {
    const res = await axios.get(url, config);
    return res.data;
}
export async function httpPost(url, body, config) {
    const res = await axios.post(url, body, config);
    return res.data;
}
export async function getMarket(marketId) {
    return await MARKET_RATE_LIMITER.add(async () => {
        const res = await axios.get(`https://clob.polymarket.com/markets/${marketId}`);
        return res.data;
    });
}
