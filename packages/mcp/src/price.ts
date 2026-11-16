import { formatEther, parseEther } from 'viem';
import { TRADE_ADDRESSES } from '@rushr/trade/addresses';
import type { Api } from './api.ts';
import { GuardError } from './guards.ts';

const WETH = TRADE_ADDRESSES.weth.toLowerCase();
const USDG = TRADE_ADDRESSES.usdg.toLowerCase();

/**
 * USD per ETH from two independent sources, or a refusal (as in Talos). Primary: Rushr's
 * `GET /transparency` (`treasury.ethUsd`). Cross-check: DexScreener's deepest WETH/USDG pair on
 * Robinhood Chain. They must agree within 10% and sit in $500-20,000. Cached for 5 minutes.
 */
export function createEthUsd(api: Api, f: typeof fetch = fetch) {
  let cache: { at: number; usd: number } | null = null;
  return async function ethUsd(): Promise<number> {
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.usd;
    const rushr = await api<{ treasury?: { ethUsd?: number } }>('GET', '/transparency', { auth: false })
      .then((j) => j.treasury?.ethUsd ?? null)
      .catch(() => null);
    const dex = await f(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`)
      .then((r) => r.json() as Promise<{ pairs?: { chainId: string; baseToken: { address: string }; quoteToken: { address: string }; priceUsd?: string; liquidity?: { usd?: number } }[] }>)
      .then((j) => {
        const pairs = (j.pairs ?? []).filter((p) => p.chainId === 'robinhood' && p.baseToken.address.toLowerCase() === WETH && p.quoteToken.address.toLowerCase() === USDG && Number(p.priceUsd) > 0);
        pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        return pairs[0] ? Number(pairs[0].priceUsd) : null;
      })
      .catch(() => null);
    return (cache = { at: Date.now(), usd: checkEthUsd(rushr, dex) }).usd;
  };
}

/** The sanity rules on their own, for tests. */
export function checkEthUsd(rushr: number | null, dex: number | null): number {
  if (rushr === null || dex === null) throw new GuardError('refused_price_unavailable', `can't price ETH: Rushr ${rushr ?? 'unavailable'}, DexScreener ${dex ?? 'unavailable'}; refusing to size a trade`);
  if (Math.abs(rushr - dex) / dex > 0.1) throw new GuardError('refused_price_disagreement', `ETH/USD sources disagree: Rushr $${rushr.toFixed(2)} vs DexScreener $${dex.toFixed(2)} (over 10%)`);
  if (!(rushr > 500 && rushr < 20_000)) throw new GuardError('refused_price_out_of_band', `ETH/USD ${rushr} is outside $500-20,000`);
  return rushr;
}

export const usdToWei = (usd: number, ethUsd: number) => parseEther((usd / ethUsd).toFixed(18));
export const weiToUsd = (wei: bigint, ethUsd: number) => Number(formatEther(wei)) * ethUsd;
