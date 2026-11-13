'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseEther, type Address, type Hex, type PublicClient } from 'viem';
import {
  autoSlippageBps,
  discoverPools,
  explorerTxUrl,
  fetchApiPools,
  isFresh,
  probeTokenSafety,
  quickBuy,
  quickSell,
  resolveConfig,
  SendError,
  TxPipeline,
  type ApiPoolRow,
  type Pool,
  type QuickTrade,
  type SendResult,
  type TokenRiskInfo,
  type TokenSafety,
  type WalletCall,
} from '@rushr/trade';
import { API_URL } from '@/lib/api';
import { auth, useAuth } from '@/lib/auth';
import { publicClient } from '@/lib/balances';
import { useSettings, type TradeSettings } from '@/lib/settings';
import { useRiskAck } from './risk-ack';

/**
 * Quote → guardrails → silent send for one token (beta trading v0), built for speed:
 *
 * - Trades are PREBUILT: the current amount (token page) or the quick-buy amount (trenches, on hover)
 *   is quoted, guarded and simulated ahead of the click and refreshed every few seconds, so a click
 *   only signs and broadcasts.
 * - The embedded wallet only SIGNS (`auth.signTransaction`, Privy UI off). Nonce, fee cap and a
 *   generous gas limit come from a local cache (TxPipeline), so Privy makes no RPC calls, and the
 *   signed tx goes to the chain's RPC with eth_sendRawTransactionSync: one round trip to the receipt.
 * - The UI shows "Sending" on click, "Submitted" when the hash is final, then "Confirmed".
 *
 * One Privy setup: sign-in state and signing come from `lib/auth`. This module never imports
 * Privy. Settings (presets, slippage, per-trade cap) come from `lib/settings`. Nothing is signed by
 * Rushr's servers.
 */

export const chainClient = publicClient as unknown as () => PublicClient;
const cfg = resolveConfig();
/** Quotes for signed-out visitors use an empty address (balance guards are skipped for it). */
const GUEST: Address = '0x0000000000000000000000000000000000000001';
/** Prebuilt trades are refreshed this often while warm (quotes stay valid for 10s). */
export const REFRESH_MS = 4_000;
const POOLS_TTL_MS = 20_000;
/** Stop background refresh after this long without any pointer/key activity on the page. */
const IDLE_STOP_MS = 60_000;

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
  | { kind: 'success'; hash: Hex; url: string; ms: number }
  | { kind: 'failed'; message: string; hash?: Hex; url?: string };

/** Per-trade stage timings (ms), kept on `window.__rushrTradeTimings` (last 20) and logged. */
export interface TradeTimings {
  side: 'buy' | 'sell';
  token: Address;
  /** The click found a fresh prebuilt trade (no quoting at click time). */
  prebuilt: boolean;
  /** Click → trade ready (0 when prebuilt). */
  readyMs: number;
  /** Waiting for nonce/fees (0 when cached). */
  prepMs: number;
  /** Privy signing round trip. */
  signMs: number;
  clickToSubmittedMs: number;
  /** Broadcast → receipt. */
  confirmMs: number;
  clickToConfirmedMs: number;
  via: 'sync' | 'poll';
  txs: number;
}

/**
 * `rushr:trade` window event, for optimistic UI elsewhere (positions, toasts): `submitting` on click,
 * `submitted` once the hash is final, then `confirmed` or `failed`.
 */
export interface TradeEventDetail {
  phase: 'submitting' | 'submitted' | 'confirmed' | 'failed';
  token: Address;
  symbol: string;
  decimals: number;
  side: 'buy' | 'sell';
  /** Buys: ETH wei in; sells: token amount in. */
  amountIn: string;
  /** Expected output (token amount on buys, ETH wei on sells). */
  expectedOut: string | null;
  wallet: Address;
  hash?: Hex;
  message?: string;
  timings?: TradeTimings;
}

function emit(detail: TradeEventDetail) {
  try {
    window.dispatchEvent(new CustomEvent<TradeEventDetail>('rushr:trade', { detail }));
  } catch {
    /* no window */
  }
}

function logTimings(t: TradeTimings) {
  try {
    const w = window as unknown as { __rushrTradeTimings?: TradeTimings[] };
    (w.__rushrTradeTimings ??= []).push(t);
    if (w.__rushrTradeTimings.length > 20) w.__rushrTradeTimings.shift();
    console.info(
      `[rushr trade] ${t.side} ${t.prebuilt ? 'prebuilt' : 'cold'}: submitted ${t.clickToSubmittedMs.toFixed(0)}ms (ready ${t.readyMs.toFixed(0)} · prep ${t.prepMs.toFixed(0)} · sign ${t.signMs.toFixed(0)}), confirmed +${t.confirmMs.toFixed(0)}ms via ${t.via} = ${t.clickToConfirmedMs.toFixed(0)}ms, ${t.txs} tx`,
    );
  } catch {
    /* best effort */
  }
}

/**
 * Trade ledger (POST /v1/trades, Privy access token). Sent as soon as the swap hash is final;
 * the server derives trader, side, amounts and the treasury fee from the chain, and the referrer from
 * the member's signup attribution, so only the hash goes up. 404 tx_not_found right after broadcast is
 * retried once. Idempotent per hash. Errors are ignored: it never blocks or fails a trade.
 */
export async function recordTrade(txHash: Hex): Promise<void> {
  try {
    const token = await auth.getAccessToken();
    if (!token) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${API_URL}/v1/trades`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ txHash, chainId: 4663, source: { kind: 'web' } }),
        keepalive: true,
      });
      const body = res.status === 404 ? await res.text().catch(() => '') : (await res.body?.cancel().catch(() => undefined), '');
      if (res.status === 404 && /tx_not_found/.test(body) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }
      return;
    }
  } catch {
    /* best effort */
  }
}

function friendly(e: unknown): string {
  if (e instanceof SendError) return e.message;
  const m = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  if (/user rejected|denied|cancel/i.test(m)) return 'Cancelled.';
  if (/insufficient funds/i.test(m)) return 'Not enough ETH for this trade and gas.';
  if (/still loading/i.test(m)) return 'Sign-in is still loading, try again in a moment.';
  return m.replace(/https?:\/\/\S+/g, '').slice(0, 180);
}

/**
 * Slippage from the user's settings: 'auto' (the planned default) → automatic 5–15% by token age,
 * volatility and impact, plus the measured tax; a number → exactly that fixed percentage.
 */
function slippageFor(s: TradeSettings, auto: number): number {
  const v = s.slippagePct as number | 'auto';
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : auto;
}

// ---- shared caches (per page) ---------------------------------------------------------------------

const pipes = new Map<string, TxPipeline>();
/** One send pipeline per wallet: cached nonce/fees, sends serialized in nonce order. */
export function pipelineFor(wallet: Address): TxPipeline {
  const k = wallet.toLowerCase();
  let p = pipes.get(k);
  if (!p) pipes.set(k, (p = new TxPipeline(chainClient(), wallet)));
  return p;
}

type PoolSet = { pools: Pool[]; rows: ApiPoolRow[] | null };
const poolCache = new Map<string, { at: number; pools: Promise<PoolSet> }>();
function poolsFor(token: TradeToken, trader: Address): Promise<PoolSet> {
  const k = token.address.toLowerCase();
  const hit = poolCache.get(k);
  if (hit && Date.now() - hit.at < POOLS_TTL_MS) return hit.pools;
  const pools = (async () => {
    const apiPools = await fetchApiPools(token.address, { apiUrl: API_URL });
    const pools = await discoverPools(chainClient(), token.address, {
      mainPool: token.mainPool ?? null,
      createdBlock: token.createdBlock ? BigInt(token.createdBlock) : undefined,
      apiPools,
      quoteAsset: 'ETH',
      trader,
    });
    return { pools, rows: apiPools };
  })();
  pools.catch(() => poolCache.delete(k));
  poolCache.set(k, { at: Date.now(), pools });
  return pools;
}
function dropPools(token: Address) {
  poolCache.delete(token.toLowerCase());
}

let lastActivity = Date.now();
if (typeof window !== 'undefined') {
  const bump = () => (lastActivity = Date.now());
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'scroll', 'focus'] as const) window.addEventListener(ev, bump, { passive: true });
}
const pageActive = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && Date.now() - lastActivity < IDLE_STOP_MS;

const keyOf = (side: 'buy' | 'sell', amount: bigint) => `${side}:${amount}`;

// ---- hook -----------------------------------------------------------------------------------------

export function useQuickTrade(tokenArg: TradeToken) {
  // Callers often pass a fresh object each render: key everything on the fields, so `prepare`,
  // `warm` and `execute` keep their identity (safe in effect dependencies).
  const { address, symbol, decimals, risk: tokenRisk, verdict, createdAt, mainPool, createdBlock, priceChange5mPct } = tokenArg;
  const token = useMemo<TradeToken>(
    () => ({ address, symbol, decimals, risk: tokenRisk, verdict, createdAt, mainPool, createdBlock, priceChange5mPct }),
    [address, symbol, decimals, tokenRisk, verdict, createdAt, mainPool, createdBlock, priceChange5mPct],
  );
  const session = useAuth();
  const settings = useSettings();
  const [ack, setAck] = useRiskAck(token.address);
  const [trade, setTrade] = useState<QuickTrade | null>(null);
  const [status, setStatus] = useState<TradeStatus>({ kind: 'idle' });
  const [safety, setSafety] = useState<TokenSafety | null>(null);
  const [timings, setTimings] = useState<TradeTimings | null>(null);
  const safetyRef = useRef<TokenSafety | null>(null);
  const cache = useRef(new Map<string, QuickTrade>());
  const inflight = useRef(new Map<string, Promise<QuickTrade | null>>());
  const lastReq = useRef<{ side: 'buy' | 'sell'; amount: bigint } | null>(null);
  const sending = useRef(false);
  const wallet = (session.user?.wallet ?? undefined) as Address | undefined;
  const trader = wallet ?? GUEST;

  // Load the wallet SDK now (not after the idle delay) and warm nonce/fees for this wallet.
  useEffect(() => {
    auth.preload();
  }, []);
  useEffect(() => {
    if (wallet) void pipelineFor(wallet).warm().catch(() => undefined);
  }, [wallet]);

  useEffect(() => {
    setTrade(null);
    setSafety(null);
    safetyRef.current = null;
    setStatus({ kind: 'idle' });
    cache.current.clear();
    inflight.current.clear();
  }, [token.address]);
  // Inputs to the guards changed: prebuilt trades are no longer valid.
  useEffect(() => {
    cache.current.clear();
  }, [settings, ack, trader]);

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

  /** Builds (or rebuilds) the trade for side/amount. `silent`: background refresh, no status change. */
  const build = useCallback(
    async (side: 'buy' | 'sell', amount: bigint, silent: boolean, probe: TokenSafety | null = safetyRef.current): Promise<QuickTrade | null> => {
      const client = chainClient();
      const { pools, rows } = await poolsFor(token, trader);
      const r = risk(probe);
      const auto = autoSlippageBps({ side, ageMinutes: r.ageMinutes, priceChange5mPct: r.priceChange5mPct, taxBps: side === 'buy' ? r.buyTaxBps : r.sellTaxBps });
      const opts = {
        settings: { maxTradeWei: parseEther(String(settings.maxTradeEth)), slippageBps: slippageFor(settings, auto) },
        risk: r,
        acknowledgedHighRisk: ack,
        discover: { pools, apiPools: rows },
        simulate: trader !== GUEST,
      };
      let t = side === 'buy' ? await quickBuy(client, { token: token.address, ethWei: amount, trader }, opts) : await quickSell(client, { token: token.address, trader, amount }, opts);
      if (trader === GUEST) t = { ...t, blockers: t.blockers.filter((b) => b.code !== 'INSUFFICIENT_ETH' && b.code !== 'INSUFFICIENT_TOKEN') };
      // Honeypot / tax probe once per token, on the first buy quote (one eth_simulateV1 call).
      if (side === 'buy' && t.quote && !probe) {
        const p = await probeTokenSafety(client, { ...t.quote, request: { ...t.quote.request, trader: GUEST } }, cfg).catch(() => null);
        if (p) {
          safetyRef.current = p;
          setSafety(p);
          if (p.honeypot || (p.buyTaxBps ?? 0) > 0 || (p.sellTaxBps ?? 0) > 0) return build(side, amount, silent, p);
        }
      }
      return t;
    },
    [token, settings, ack, trader, risk],
  );

  /** Returns a fresh trade for side/amount: cached, the one being built, or a new build. */
  const get = useCallback(
    (side: 'buy' | 'sell', amount: bigint, silent: boolean): Promise<QuickTrade | null> => {
      const k = keyOf(side, amount);
      const hit = cache.current.get(k);
      if (hit && isFresh(hit, Date.now() + 1_000)) return Promise.resolve(hit);
      const running = inflight.current.get(k);
      if (running) return running;
      const p = build(side, amount, silent)
        .then((t) => {
          if (t) cache.current.set(k, t);
          return t;
        })
        .finally(() => inflight.current.delete(k));
      inflight.current.set(k, p);
      return p;
    },
    [build],
  );

  /** Foreground quote for the trade box / button (shows "quoting", sets `trade`). */
  const prepare = useCallback(
    async (side: 'buy' | 'sell', amount: bigint): Promise<QuickTrade | null> => {
      if (amount <= 0n) {
        lastReq.current = null;
        setTrade(null);
        return null;
      }
      lastReq.current = { side, amount };
      const k = keyOf(side, amount);
      const cached = cache.current.get(k);
      if (!cached || !isFresh(cached, Date.now() + 1_000)) setStatus((s) => (s.kind === 'idle' || s.kind === 'failed' || s.kind === 'quoting' ? { kind: 'quoting' } : s));
      try {
        const t = await get(side, amount, false);
        if (lastReq.current?.side === side && lastReq.current.amount === amount) {
          setTrade(t);
          setStatus((s) => (s.kind === 'quoting' ? { kind: 'idle' } : s));
        }
        return t;
      } catch (e) {
        setTrade(null);
        setStatus({ kind: 'failed', message: friendly(e) });
        return null;
      }
    },
    [get],
  );

  /** Background: keep side/amount prebuilt (refreshes every REFRESH_MS while the page is in use). */
  const warm = useCallback(
    (side: 'buy' | 'sell', amount: bigint) => {
      if (amount <= 0n || !pageActive() || sending.current) return;
      void get(side, amount, true)
        .then((t) => {
          if (t && lastReq.current?.side === side && lastReq.current.amount === amount) setTrade(t);
        })
        .catch(() => undefined);
      if (wallet) void pipelineFor(wallet).warm().catch(() => undefined);
    },
    [get, wallet],
  );

  /**
   * Sends side/amount (default: the last prepared one). Uses the prebuilt trade when fresh; otherwise
   * quotes first. Returns when confirmed or failed.
   */
  const execute = useCallback(
    async (req?: { side: 'buy' | 'sell'; amount: bigint }) => {
      if (!session.authenticated || !wallet) {
        auth.login();
        return;
      }
      const r = req ?? lastReq.current;
      if (!r || sending.current) return;
      sending.current = true;
      const click = performance.now();
      const k = keyOf(r.side, r.amount);
      const pre = cache.current.get(k);
      const prebuilt = !!pre && isFresh(pre);
      setStatus({ kind: 'sending', step: 1, total: 1, label: r.side === 'buy' ? 'buy' : 'sell' });
      const base = { token: token.address, symbol: token.symbol, decimals: token.decimals, side: r.side, amountIn: r.amount.toString(), wallet } as const;
      let t: QuickTrade | null = prebuilt ? pre! : null;
      let lastHash: Hex | undefined;
      try {
        if (!t) {
          cache.current.delete(k);
          t = await get(r.side, r.amount, false);
        }
        const ready = performance.now();
        if (!t || !t.ok) {
          if (t) setTrade(t);
          setStatus(t?.blockers[0] ? { kind: 'failed', message: t.blockers[0].message } : { kind: 'idle' });
          return;
        }
        setTrade(t);
        cache.current.delete(k); // one send per prebuilt trade
        emit({ ...base, phase: 'submitting', expectedOut: t.quote?.amountOut.toString() ?? null });
        const pipe = pipelineFor(wallet);
        const total = t.calls.length;
        let submittedAt = 0;
        let res: SendResult | null = null;
        let prepMs = 0;
        let signMs = 0;
        let confirmMs = 0;
        for (const [i, c] of t.calls.entries()) {
          setStatus({ kind: 'sending', step: i + 1, total, label: c.label === 'swap' ? r.side : c.label });
          res = await sendWithRetry(pipe, c, (hash) => {
            lastHash = hash;
            setStatus({ kind: 'pending', hash, step: i + 1, total });
            if (c.label === 'swap') {
              submittedAt = performance.now();
              void recordTrade(hash);
              emit({ ...base, phase: 'submitted', hash, expectedOut: t!.quote?.amountOut.toString() ?? null });
            }
          });
          prepMs += res.timings.prepMs;
          signMs += res.timings.signMs;
          confirmMs = res.timings.confirmMs;
          if (res.receipt.status !== 'success') throw new Error(`${c.label} reverted on-chain`);
        }
        const done = performance.now();
        const tm: TradeTimings = {
          side: r.side,
          token: token.address,
          prebuilt,
          readyMs: ready - click,
          prepMs,
          signMs,
          clickToSubmittedMs: submittedAt - click,
          confirmMs,
          clickToConfirmedMs: done - click,
          via: res!.timings.via,
          txs: total,
        };
        logTimings(tm);
        setTimings(tm);
        setStatus({ kind: 'success', hash: lastHash!, url: explorerTxUrl(lastHash!), ms: done - click });
        emit({ ...base, phase: 'confirmed', hash: lastHash, expectedOut: t.quote?.amountOut.toString() ?? null, timings: tm });
        // After a buy: approve the token for selling now, in the background, so the sell is one tx.
        if (r.side === 'buy' && t.sellApprovals.length) void preApprove(pipe, t.sellApprovals);
      } catch (e) {
        setStatus({ kind: 'failed', message: friendly(e), hash: lastHash, url: lastHash ? explorerTxUrl(lastHash) : undefined });
        emit({ ...base, phase: 'failed', hash: lastHash, expectedOut: null, message: friendly(e) });
      } finally {
        sending.current = false;
        // Balances and allowances changed: rebuild from fresh chain state.
        cache.current.clear();
        dropPools(token.address);
        if (lastReq.current) warm(lastReq.current.side, lastReq.current.amount);
      }
    },
    [session.authenticated, wallet, token, get, warm],
  );

  return { session, wallet, trade, status, prepare, warm, execute, ack, setAck, safety, settings, timings };
}

/** Set when the wallet can't sign without sending: later trades use the wallet's own send directly. */
let signOnlyUnavailable = false;

/**
 * Fast path: sign only + our broadcast. One retry with a fresh nonce/fee cap if the chain moved under
 * us (a new signature, same trade). If the wallet can't return a signed transaction (nothing was
 * signed or broadcast), falls back to the wallet's own send for this and later trades.
 */
async function sendWithRetry(pipe: TxPipeline, call: WalletCall, onSubmitted: (h: Hex) => void): Promise<SendResult> {
  if (signOnlyUnavailable) return walletSend(pipe, call, onSubmitted);
  let signed = false;
  const sign = async (tx: Parameters<typeof auth.signTransaction>[0]) => {
    const raw = await auth.signTransaction(tx);
    signed = true;
    return raw;
  };
  try {
    return await pipe.send(call, sign, { onSubmitted });
  } catch (e) {
    if (e instanceof SendError && (e.code === 'NONCE' || e.code === 'FEE')) {
      await pipe.warm(true);
      return pipe.send(call, sign, { onSubmitted });
    }
    const userCancelled = /user rejected|denied|cancel/i.test(String((e as Error)?.message));
    const unsupported = (e instanceof SendError && e.code === 'UNSUPPORTED') || (!signed && !(e instanceof SendError) && !userCancelled);
    if (!unsupported) throw e;
    console.warn('[rushr trade] sign-only unavailable, using the wallet\'s own send:', friendly(e));
    signOnlyUnavailable = true;
    return walletSend(pipe, call, onSubmitted);
  }
}

/** The wallet signs and broadcasts (Privy fills nonce/fees itself); receipt polled every 150ms. */
async function walletSend(pipe: TxPipeline, call: WalletCall, onSubmitted: (h: Hex) => void): Promise<SendResult> {
  const t1 = performance.now();
  const hash = await auth.sendTransaction({ to: call.to, data: call.data, value: call.value, gas: call.gas });
  const t2 = performance.now();
  pipe.resetNonce();
  onSubmitted(hash);
  const receipt = await chainClient().waitForTransactionReceipt({ hash, pollingInterval: 150, timeout: 60_000 });
  return { hash, receipt, timings: { prepMs: 0, signMs: t2 - t1, confirmMs: performance.now() - t2, via: 'poll' } };
}

async function preApprove(pipe: TxPipeline, calls: WalletCall[]) {
  for (const c of calls) {
    try {
      const r = await sendWithRetry(pipe, c, () => undefined);
      if (r.receipt.status !== 'success') return;
    } catch (e) {
      console.warn('[rushr trade] pre-approval for selling skipped:', friendly(e));
      return; // the next sell includes whatever is still missing
    }
  }
}

/**
 * Keeps `side/amount` prebuilt while `enabled`: now, then every REFRESH_MS while the page is in use.
 * The token page uses it for the typed amount; trenches buttons while hovered.
 */
export function useKeepWarm(q: Pick<ReturnType<typeof useQuickTrade>, 'warm'>, side: 'buy' | 'sell', amount: bigint, enabled: boolean) {
  const { warm } = q;
  useEffect(() => {
    if (!enabled || amount <= 0n) return;
    warm(side, amount);
    const id = window.setInterval(() => warm(side, amount), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [warm, side, amount, enabled]);
}
