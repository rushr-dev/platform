'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseEther, type Address, type Hex, type PublicClient } from 'viem';
import {
  autoSlippageBps,
  explorerTxUrl,
  fetchApiPools,
  isFresh,
  probeTokenSafety,
  quickBuy,
  quickSell,
  resolveConfig,
  type ApiPoolRow,
  type QuickTrade,
  type TokenRiskInfo,
  type TokenSafety,
} from '@rushr/trade';
import { API_URL } from '@/lib/api';
import { auth, useAuth } from '@/lib/auth';
import { publicClient } from '@/lib/balances';
import { useSettings, type TradeSettings } from '@/lib/settings';
import { useRiskAck } from './risk-ack';

/**
 * Quote → guardrails → silent send for one token (beta trading v0).
 *
 * One Privy setup: sign-in state and signing come from Terminal's `lib/auth` store, which the lazily
 * loaded Privy bridge fills (`auth.sendTransaction` sends from the user's embedded wallet with Privy's
 * confirmation UI off). This module never imports Privy, so the trade UI adds nothing to the page
 * bundle. Settings (presets, max slippage, per-trade cap) are Terminal's `lib/settings`.
 * Nothing is signed by Rushr's servers.
 */

export const chainClient = publicClient as unknown as () => PublicClient;
const cfg = resolveConfig();
/** Quotes for signed-out visitors use an empty address (balance guards are skipped for it). */
const GUEST: Address = '0x0000000000000000000000000000000000000001';

export interface TradeToken {
  address: Address;
  symbol: string;
  decimals: number;
  risk?: TokenRiskInfo['risk'];
  verdict?: string | null;
  createdAt?: string | null;
  mainPool?: `0x${string}` | null;
  createdBlock?: string | null;
  /** |5-minute price change| in %, if known: widens automatic slippage on volatile tokens. */
  priceChange5mPct?: number | null;
}

export type TradeStatus =
  | { kind: 'idle' }
  | { kind: 'quoting' }
  | { kind: 'sending'; step: number; total: number; label: string }
  | { kind: 'pending'; hash: Hex; step: number; total: number }
  | { kind: 'success'; hash: Hex; url: string }
  | { kind: 'failed'; message: string; hash?: Hex; url?: string };

function friendly(e: unknown): string {
  const m = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  if (/user rejected|denied|cancel/i.test(m)) return 'Cancelled.';
  if (/insufficient funds/i.test(m)) return 'Not enough ETH for this trade and gas.';
  if (/still loading/i.test(m)) return 'Sign-in is still loading, try again in a moment.';
  return m.replace(/https?:\/\/\S+/g, '').slice(0, 180);
}

/**
 * Slippage: automatic (5–15% by token age, volatility and impact, plus measured tax), never above the
 * user's "Max slippage" setting. If the token's tax needs more than that, the guard tells them.
 */
function slippageFor(s: TradeSettings, auto: number): number {
  return Math.min(auto, Math.round(s.slippagePct * 100));
}

export function useQuickTrade(token: TradeToken) {
  const session = useAuth();
  const settings = useSettings();
  const [ack, setAck] = useRiskAck(token.address);
  const [trade, setTrade] = useState<QuickTrade | null>(null);
  const [status, setStatus] = useState<TradeStatus>({ kind: 'idle' });
  const [safety, setSafety] = useState<TokenSafety | null>(null);
  const apiPools = useRef<{ token: string; rows: ApiPoolRow[] | null } | null>(null);
  const lastReq = useRef<{ side: 'buy' | 'sell'; amount: bigint } | null>(null);
  const wallet = (session.user?.wallet ?? undefined) as Address | undefined;
  const trader = wallet ?? GUEST;

  useEffect(() => {
    setTrade(null);
    setSafety(null);
    setStatus({ kind: 'idle' });
    apiPools.current = null;
  }, [token.address]);

  const risk = useCallback(
    (probe: TokenSafety | null): TokenRiskInfo => ({
      risk: token.risk ?? null,
      verdict: token.verdict ?? null,
      ageMinutes: token.createdAt ? (Date.now() - new Date(token.createdAt).getTime()) / 60_000 : null,
      priceChange5mPct: token.priceChange5mPct ?? null,
      honeypot: probe?.honeypot ?? false,
      buyTaxBps: probe?.buyTaxBps ?? null,
      sellTaxBps: probe?.sellTaxBps ?? null,
    }),
    [token],
  );

  const prepare = useCallback(
    async (side: 'buy' | 'sell', amount: bigint, probe: TokenSafety | null = safety): Promise<QuickTrade | null> => {
      if (amount <= 0n) {
        setTrade(null);
        return null;
      }
      lastReq.current = { side, amount };
      setStatus({ kind: 'quoting' });
      try {
        const client = chainClient();
        if (apiPools.current?.token !== token.address) apiPools.current = { token: token.address, rows: await fetchApiPools(token.address, { apiUrl: API_URL }) };
        const r = risk(probe);
        const auto = autoSlippageBps({ side, ageMinutes: r.ageMinutes, priceChange5mPct: r.priceChange5mPct, taxBps: side === 'buy' ? r.buyTaxBps : r.sellTaxBps });
        const opts = {
          settings: { maxTradeWei: parseEther(String(settings.maxTradeEth)), slippageBps: slippageFor(settings, auto) },
          risk: r,
          acknowledgedHighRisk: ack,
          discover: { mainPool: token.mainPool ?? null, createdBlock: token.createdBlock ? BigInt(token.createdBlock) : undefined, apiPools: apiPools.current.rows },
          simulate: trader !== GUEST,
        };
        let t = side === 'buy' ? await quickBuy(client, { token: token.address, ethWei: amount, trader }, opts) : await quickSell(client, { token: token.address, trader, amount }, opts);
        if (trader === GUEST) t = { ...t, blockers: t.blockers.filter((b) => b.code !== 'INSUFFICIENT_ETH' && b.code !== 'INSUFFICIENT_TOKEN') };
        // Honeypot / tax probe once per token, on the first buy quote (one eth_simulateV1 call).
        if (side === 'buy' && t.quote && !probe) {
          const p = await probeTokenSafety(client, { ...t.quote, request: { ...t.quote.request, trader: GUEST } }, cfg).catch(() => null);
          if (p) {
            setSafety(p);
            if (p.honeypot || (p.buyTaxBps ?? 0) > 0 || (p.sellTaxBps ?? 0) > 0) return prepare(side, amount, p);
          }
        }
        setTrade(t);
        setStatus({ kind: 'idle' });
        return t;
      } catch (e) {
        setTrade(null);
        setStatus({ kind: 'failed', message: friendly(e) });
        return null;
      }
    },
    [token, settings, ack, trader, risk, safety],
  );

  const execute = useCallback(async () => {
    if (!session.authenticated || !wallet) {
      auth.login();
      return;
    }
    let t = trade;
    // Never send a stale quote: refresh first (prices move every block on this chain).
    if (!t || !isFresh(t)) {
      if (!lastReq.current) return;
      t = await prepare(lastReq.current.side, lastReq.current.amount);
    }
    if (!t || !t.ok) return;
    const total = t.calls.length;
    let lastHash: Hex | undefined;
    try {
      for (const [i, c] of t.calls.entries()) {
        setStatus({ kind: 'sending', step: i + 1, total, label: c.label });
        const hash = await auth.sendTransaction({ to: c.to, data: c.data, value: c.value, gas: c.gas });
        lastHash = hash;
        setStatus({ kind: 'pending', hash, step: i + 1, total });
        const receipt = await chainClient().waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status !== 'success') throw new Error(`${c.label} reverted on-chain`);
      }
      setStatus({ kind: 'success', hash: lastHash!, url: explorerTxUrl(lastHash!) });
      setTrade(null);
    } catch (e) {
      setStatus({ kind: 'failed', message: friendly(e), hash: lastHash, url: lastHash ? explorerTxUrl(lastHash) : undefined });
    }
  }, [session.authenticated, wallet, trade, prepare]);

  return { session, wallet, trade, status, prepare, execute, ack, setAck, safety, settings };
}
