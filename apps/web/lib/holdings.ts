'use client';

import { useEffect, useMemo, useState } from 'react';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { publicClient, USDG, useBalances } from './balances';
import { useEthQuote, useWalletPnl, type Position } from './profile';

/**
 * A wallet's holdings for the wallet views: ETH and USDG plus every token it holds, valued in $.
 *
 * Stopgap until this reads the API's holdings endpoint (/wallets/:w/holdings): the token list
 * comes from the wallet's positions (/wallets/:w/pnl), amounts and decimals are read on-chain in one
 * multicall, and prices are the positions' `price_usd`. ETH's price and 24h change come from
 * DexScreener. Per-token 24h change is null until the API provides it.
 */

export interface Holding {
  /** null for native ETH. */
  address: Address | null;
  symbol: string;
  name: string;
  imageUrl: string | null;
  amount: number;
  /** Raw balance and decimals, for exact displays. */
  raw: bigint;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  change24hPct: number | null;
  /** ETH and USDG: pinned to the top and never hidden as dust. */
  cash: boolean;
}

export interface Holdings {
  state: 'loading' | 'ready';
  items: Holding[];
  totalUsd: number | null;
  /**
   * $ change over 24h. Null unless the holdings with a known 24h change make up at least 90% of
   * the value (otherwise ETH's move alone would pass for the whole wallet's).
   */
  change24hUsd: number | null;
  change24hPct: number | null;
  refresh: () => void;
}

type Onchain = Record<string, { raw: bigint; decimals: number }>;

/** Balances and decimals for many tokens in one multicall; refreshed every 30s and on `tick`. */
function useTokenBalances(wallet: Address | null, tokens: Address[], tick: number) {
  const [data, setData] = useState<Onchain | null>(null);
  const key = tokens.join(',');
  useEffect(() => {
    if (!wallet || !tokens.length) return setData(tokens.length ? null : {});
    let live = true;
    const run = async () => {
      try {
        const contracts = tokens.flatMap((t) => [
          { address: t, abi: erc20Abi, functionName: 'balanceOf' as const, args: [wallet] as const },
          { address: t, abi: erc20Abi, functionName: 'decimals' as const },
        ]);
        const res = await publicClient().multicall({ contracts, allowFailure: true });
        const out: Onchain = {};
        tokens.forEach((t, i) => {
          const bal = res[i * 2];
          const dec = res[i * 2 + 1];
          if (bal?.status === 'success') out[t.toLowerCase()] = { raw: bal.result as bigint, decimals: dec?.status === 'success' ? Number(dec.result) : 18 };
        });
        if (live) setData(out);
      } catch {
        // keep the last read
      }
    };
    void run();
    const id = setInterval(run, 30_000);
    return () => {
      live = false;
      clearInterval(id);
    };
    // `key` stands for `tokens`.
  }, [wallet, key, tick]);
  return data;
}

export function useWalletHoldings(wallet: Address | null): Holdings {
  const [tick, setTick] = useState(0);
  const { balances, refresh: refreshCash } = useBalances(wallet);
  const eth = useEthQuote();
  const pnl = useWalletPnl(wallet, tick);
  // Fresh every 15s, and right after this wallet's own trades (the `rushr:trade` event from
  // components/trade/use-quick-trade.ts): once on confirmation and again when the indexer has caught up.
  useEffect(() => {
    if (!wallet) return;
    const w = wallet.toLowerCase();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const bump = () => {
      setTick((x) => x + 1);
      refreshCash();
    };
    const id = setInterval(bump, 15_000);
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ phase?: string; wallet?: string }>).detail;
      if (d?.wallet?.toLowerCase() !== w || (d.phase !== 'confirmed' && d.phase !== 'failed')) return;
      bump();
      timers.push(setTimeout(bump, 4_000));
    };
    window.addEventListener('rushr:trade', on);
    return () => {
      clearInterval(id);
      timers.forEach(clearTimeout);
      window.removeEventListener('rushr:trade', on);
    };
    // refreshCash is a new function each render; the wallet decides the subscription.
  }, [wallet]);
  const positions: Position[] = pnl.state === 'ready' ? pnl.data.positions : [];
  // Tokens the indexer thinks are held; the chain decides the amount.
  const tokens = useMemo(
    () => positions.filter((p) => p.held_tokens && p.held_tokens !== '0' && p.token.toLowerCase() !== USDG).map((p) => p.token as Address),
    [positions],
  );
  const onchain = useTokenBalances(wallet, tokens, tick);

  return useMemo(() => {
    const items: Holding[] = [];
    if (balances) {
      const ethAmt = Number(formatUnits(balances.eth, 18));
      items.push({
        address: null,
        symbol: 'ETH',
        name: 'Ether',
        imageUrl: null,
        amount: ethAmt,
        raw: balances.eth,
        decimals: 18,
        priceUsd: eth?.usd ?? null,
        valueUsd: eth ? ethAmt * eth.usd : null,
        change24hPct: eth?.change24h ?? null,
        cash: true,
      });
      const usdgAmt = Number(formatUnits(balances.usdg, 6));
      items.push({
        address: USDG,
        symbol: 'USDG',
        name: 'Global Dollar',
        imageUrl: null,
        amount: usdgAmt,
        raw: balances.usdg,
        decimals: 6,
        priceUsd: 1,
        valueUsd: usdgAmt,
        change24hPct: 0,
        cash: true,
      });
    }
    for (const p of positions) {
      const c = onchain?.[p.token.toLowerCase()];
      if (!c || c.raw <= 0n) continue;
      const amount = Number(formatUnits(c.raw, c.decimals));
      items.push({
        address: p.token as Address,
        symbol: p.symbol,
        name: p.name,
        imageUrl: p.image_url,
        amount,
        raw: c.raw,
        decimals: c.decimals,
        priceUsd: p.price_usd,
        valueUsd: p.price_usd != null ? amount * p.price_usd : null,
        change24hPct: null,
        cash: false,
      });
    }
    items.sort((a, b) => Number(b.cash) - Number(a.cash) || (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

    const ready = !!balances && pnl.state !== 'loading' && (tokens.length === 0 || onchain != null);
    const totalUsd = balances ? items.reduce((t, h) => t + (h.valueUsd ?? 0), 0) : null;
    let change: number | null = null;
    let covered = 0;
    for (const h of items) {
      if (h.valueUsd == null || h.change24hPct == null || h.change24hPct <= -100) continue;
      covered += h.valueUsd;
      change = (change ?? 0) + (h.valueUsd * h.change24hPct) / (100 + h.change24hPct);
    }
    if (!totalUsd || covered / totalUsd < 0.9) change = null;
    const before = totalUsd != null && change != null ? totalUsd - change : null;
    return {
      state: ready ? 'ready' : 'loading',
      items,
      totalUsd,
      change24hUsd: change,
      change24hPct: before && before > 0 && change != null ? (change / before) * 100 : null,
      refresh: () => {
        refreshCash();
        setTick((t) => t + 1);
      },
    };
  }, [balances, eth, positions, onchain, pnl.state, tokens.length, refreshCash]);
}
