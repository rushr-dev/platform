'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { robinhoodChain } from '@rushr/trade';

/**
 * Wallet balances over Robinhood Chain's public RPC (CORS-open, no key, no Alchemy cost: the same
 * endpoint the trade package quotes against).
 */

export const USDG: Address = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const REFRESH_MS = 15_000;

let client: ReturnType<typeof createPublicClient> | null = null;
export const publicClient = () => (client ??= createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }));

export interface Balances {
  eth: bigint;
  usdg: bigint;
}

export async function readBalances(address: Address): Promise<Balances> {
  const c = publicClient();
  const [eth, usdg] = await Promise.all([
    c.getBalance({ address }),
    c.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  return { eth, usdg };
}

/** Balances for an address, refreshed every 15s while mounted; `refresh()` re-reads now (after a trade). */
export function useBalances(address: Address | null) {
  const [balances, setBalances] = useState<Balances | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address) {
      setBalances(null);
      return;
    }
    let live = true;
    const run = () =>
      readBalances(address)
        .then((b) => {
          if (!live) return;
          setBalances(b);
          setError(false);
        })
        .catch(() => live && setError(true));
    void run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [address, tick]);
  return { balances, error, refresh: () => setTick((t) => t + 1) };
}

/** 1.234567 ETH-style formatting with a fixed number of decimals, trimmed. */
export function fmtUnits(v: bigint, decimals: number, places = 4): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** Re-reads after a confirmed trade: public RPC nodes can lag the receipt by a block or two. */
const AFTER_TRADE_MS = [0, 800, 2_000, 4_500, 9_000];

/**
 * ETH and one token's balance for a wallet: read now, every 15s, whenever `tick` changes, and on a
 * short schedule after this wallet's own confirmed trades (the `rushr:trade` event), so a buy is
 * sellable at once without a page refresh. `refresh()` re-reads on demand (e.g. opening Sell).
 */
export function useTokenBalance(wallet: Address | undefined, token: Address, tick = 0) {
  const [bal, setBal] = useState<{ eth: bigint; token: bigint } | null>(null);
  const [n, setN] = useState(0);
  const key = wallet ? `${wallet.toLowerCase()}:${token.toLowerCase()}` : null;
  // A new wallet or token starts from "unknown" (a skeleton), never the previous answer.
  useEffect(() => setBal(null), [key]);
  useEffect(() => {
    if (!wallet) return setBal(null);
    let gone = false;
    Promise.all([
      publicClient().getBalance({ address: wallet }),
      publicClient().readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    ])
      .then(([eth, tok]) => !gone && setBal({ eth, token: tok }))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [wallet, token, tick, n]);
  useEffect(() => {
    if (!wallet) return;
    const w = wallet.toLowerCase();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const bump = () => setN((x) => x + 1);
    const id = setInterval(bump, REFRESH_MS);
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ phase?: string; wallet?: string }>).detail;
      if (d?.wallet?.toLowerCase() !== w || (d.phase !== 'confirmed' && d.phase !== 'failed')) return;
      for (const ms of AFTER_TRADE_MS) timers.push(setTimeout(bump, ms));
    };
    window.addEventListener('rushr:trade', on);
    return () => {
      clearInterval(id);
      timers.forEach(clearTimeout);
      window.removeEventListener('rushr:trade', on);
    };
  }, [wallet]);
  return { bal, refresh: () => setN((x) => x + 1) };
}
