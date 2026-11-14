'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { formatUnits, parseEther, parseUnits } from 'viem';
import { Gear, Info } from '@phosphor-icons/react';
import { feeLine, maxBuyWei, type QuickTrade } from '@rushr/trade';
import { tradingAvailable } from '@/components/trade/flag';
import { useQuickTrade, type TradeToken } from '@/components/trade/use-quick-trade';
import { compact, usd } from '@/lib/format';
import { useEthUsd } from '@/lib/profile';
import { LIMITS, updateSettings, useSettings } from '@/lib/settings';
import { Modal } from './profile/modal';
import { useTokenBalance } from '@/lib/balances';

/**
 * The simple trade card (the token page's default): Buy/Sell, one big amount in US dollars,
 * dollar presets (percentages of the holding when selling), the balance with Max, and one button.
 * Dollars convert to ETH at the live ETH price; the trade itself is the same ETH quote and silent
 * send as the full panel (components/trade/use-quick-trade.ts). Slippage, the cap, presets, gas and
 * quote details sit behind the gear, next to the Pro mode switch.
 */
export function SimpleTrade(props: { token: TradeToken; priceUsd: number | null; initialSide?: Side; onDone?: () => void }) {
  if (!tradingAvailable()) return null;
  return <Card {...props} />;
}

type Side = 'buy' | 'sell';

const BUY_PRESETS = [10, 100, 500, 1000];
const SELL_PRESETS = [25, 50, 75, 100];
/** ETH kept back on Max buys so the wallet can still pay gas (a swap costs well under this). */
const GAS_RESERVE = parseEther('0.0005');

const cents = (n: number) => (Math.floor(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
const whole = (v: bigint, decimals: number) => Number(formatUnits(v, decimals));

function Card({ token, priceUsd, initialSide = 'buy', onDone }: { token: TradeToken; priceUsd: number | null; initialSide?: Side; onDone?: () => void }) {
  const q = useQuickTrade(token);
  const settings = useSettings();
  const ethUsd = useEthUsd();
  const [side, setSide] = useState<Side>(initialSide);
  const [amount, setAmount] = useState('');
  /** Exact token amount from a sell percentage (so Max sells everything, not a rounded dollar value). */
  const [sellExact, setSellExact] = useState<{ pct: number; v: bigint } | null>(null);
  const [tick, setTick] = useState(0);
  const bal = useTokenBalance(q.wallet, token.address, tick);
  const [gear, setGear] = useState(false);
  const signedIn = q.session.authenticated && !!q.wallet;
  const busy = q.status.kind === 'sending' || q.status.kind === 'pending';
  const dollars = Number(amount) || 0;

  const amountIn = useMemo(() => {
    try {
      if (side === 'buy') return dollars > 0 && ethUsd ? parseEther((dollars / ethUsd).toFixed(15)) : 0n;
      if (sellExact) return sellExact.v;
      if (!(dollars > 0) || !priceUsd) return 0n;
      const v = parseUnits((dollars / priceUsd).toFixed(Math.min(token.decimals, 8)), token.decimals);
      return bal && v > bal.token ? bal.token : v;
    } catch {
      return 0n;
    }
  }, [side, dollars, ethUsd, sellExact, priceUsd, token.decimals, bal]);

  // Quote as the amount changes (debounced), then send exactly the quote that matches on submit.
  const prepareRef = useRef(q.prepare);
  prepareRef.current = q.prepare;
  const executeRef = useRef(q.execute);
  executeRef.current = q.execute;
  const [armed, setArmed] = useState<{ side: Side; amount: bigint } | null>(null);
  useEffect(() => {
    if (busy || armed) return;
    const t = setTimeout(() => void prepareRef.current(side, amountIn), 350);
    return () => clearTimeout(t);
  }, [side, amountIn, settings, q.ack, q.wallet]);
  useEffect(() => {
    if (!armed) return;
    if (q.status.kind === 'failed') return setArmed(null);
    const r = q.trade?.quote?.request;
    if (!q.trade || !r || r.side !== armed.side || r.amountIn !== armed.amount) return;
    setArmed(null);
    if (q.trade.ok) void executeRef.current();
  }, [armed, q.trade, q.status.kind]);
  useEffect(() => {
    if (q.status.kind === 'success' || q.status.kind === 'failed') setTick((x) => x + 1);
    if (q.status.kind === 'success') {
      setAmount('');
      setSellExact(null);
      onDone?.();
    }
  }, [q.status.kind]);

  const submit = () => {
    if (!signedIn) return void q.execute(); // opens sign-in
    if (amountIn <= 0n || busy) return;
    setArmed({ side, amount: amountIn });
    const r = q.trade?.quote?.request;
    if (!r || r.side !== side || r.amountIn !== amountIn) void prepareRef.current(side, amountIn);
  };

  const ethBalUsd = bal && ethUsd ? whole(bal.eth, 18) * ethUsd : null;
  const holdUsd = bal && priceUsd != null ? whole(bal.token, token.decimals) * priceUsd : null;
  const maxBuyUsd = (() => {
    if (!bal || !ethUsd) return null;
    // Curve trades pay the Rushr fee on top of the amount (a follow-up transfer): leave room for it.
    const spendable = maxBuyWei(bal.eth > GAS_RESERVE ? bal.eth - GAS_RESERVE : 0n, q.trade?.feeFollowUp?.feeBps ?? 0);
    const capWei = parseEther(String(settings.maxTradeEth));
    return whole(spendable < capWei ? spendable : capWei, 18) * ethUsd;
  })();
  const pickSell = (pct: number) => {
    if (!bal || bal.token <= 0n) return;
    const v = pct >= 100 ? bal.token : (bal.token * BigInt(pct)) / 100n;
    setSellExact({ pct, v });
    setAmount(priceUsd != null ? cents(whole(v, token.decimals) * priceUsd) : '');
  };

  const t = q.trade;
  const fresh = t?.quote && t.quote.request.amountIn === amountIn && t.quote.request.side === side ? t : null;
  // The latest result for this amount; a failed route has no quote but still says why.
  const shown = fresh ?? (amountIn > 0n && t && !t.quote ? t : null);
  const needsAck = !!shown?.blockers.some((b) => b.code === 'RISK_ACK_REQUIRED');
  const blocked = !!shown?.blockers.some((b) => b.code !== 'RISK_ACK_REQUIRED') || (needsAck && !q.ack);
  const note = noteFor({ token, trade: shown, status: q.status });

  return (
    <section className="shrink-0 rounded-2xl border border-white/[0.06] bg-surface p-3" aria-label={`Trade ${token.symbol}`}>
      <div className="flex items-center gap-2">
        <div className="grid flex-1 grid-cols-2 rounded-xl bg-white/[0.04] p-1" role="tablist">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => {
                if (busy) return;
                setSide(s);
                setAmount('');
                setSellExact(null);
              }}
              className={`rounded-lg py-2 text-sm font-semibold capitalize transition ${
                side === s ? (s === 'buy' ? 'bg-go text-bg' : 'bg-risk-high text-bg') : 'text-muted hover:text-ink'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setGear(true)} aria-label="Trade settings" title="Trade settings" className="rounded-lg p-2 text-muted hover:bg-white/[0.05] hover:text-ink">
          <Gear size={18} />
        </button>
      </div>

      <label className="mt-4 block text-center">
        <span className="sr-only">{side === 'buy' ? 'Amount to spend in US dollars' : 'Amount to sell in US dollars'}</span>
        <span className="flex items-baseline justify-center font-mono text-[40px] font-semibold leading-none tracking-tight">
          <span className={amount ? 'text-ink' : 'text-muted/50'}>$</span>
          <input
            inputMode="decimal"
            value={amount}
            placeholder="0"
            onChange={(e) => {
              setSellExact(null);
              setAmount(e.target.value.replace(',', '.').replace(/[^\d.]/g, '').slice(0, 12));
            }}
            className="w-[6ch] min-w-0 bg-transparent text-left outline-none placeholder:text-muted/50"
            style={{ width: `${Math.max(1, amount.length || 1) + 0.5}ch` }}
          />
        </span>
        <span className="mt-1 block text-xs text-muted">
          {amount
            ? side === 'buy'
              ? fresh?.quote
                ? `≈ ${compact(whole(fresh.quote.amountOut, token.decimals))} ${token.symbol}`
                : ethUsd
                  ? `≈ ${(dollars / ethUsd).toFixed(5)} ETH`
                  : ' '
              : `${compact(whole(amountIn, token.decimals))} ${token.symbol}`
            : 'Enter amount'}
        </span>
      </label>

      <div className="mt-4 grid grid-cols-4 gap-1.5">
        {side === 'buy'
          ? BUY_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setSellExact(null);
                  setAmount(String(p));
                }}
                className={`rounded-xl border py-2 font-mono text-sm transition ${amount === String(p) ? 'border-go/60 bg-go/10 text-go' : 'border-white/[0.06] text-ink/85 hover:border-white/20'}`}
              >
                ${p}
              </button>
            ))
          : SELL_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!bal || bal.token <= 0n}
                onClick={() => pickSell(p)}
                className={`rounded-xl border py-2 font-mono text-sm transition disabled:opacity-40 ${sellExact?.pct === p ? 'border-risk-high/60 bg-risk-high/10 text-risk-high' : 'border-white/[0.06] text-ink/85 hover:border-white/20'}`}
              >
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
      </div>

      {signedIn && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>
            {side === 'buy' ? 'Balance' : `Your ${token.symbol}`}{' '}
            <span className="font-mono text-ink/85">{side === 'buy' ? (ethBalUsd == null ? '…' : `$${cents(ethBalUsd)}`) : holdUsd == null ? '…' : `$${cents(holdUsd)}`}</span>
          </span>
          <button
            type="button"
            onClick={() => (side === 'buy' ? maxBuyUsd != null && (setSellExact(null), setAmount(cents(maxBuyUsd))) : pickSell(100))}
            className="font-semibold text-ink/85 hover:text-ink"
          >
            Max
          </button>
        </div>
      )}

      {needsAck && (
        <label className="mt-3 flex items-center gap-2 text-xs text-risk-high">
          <input type="checkbox" checked={q.ack} onChange={(e) => q.setAck(e.target.checked)} />
          <span>I understand this token is high risk and I could lose what I put in.</span>
        </label>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={!q.session.ready || busy || !!armed || (signedIn && (amountIn <= 0n || blocked))}
        className={`mt-3 w-full rounded-xl py-3.5 text-[15px] font-semibold text-bg transition hover:brightness-110 disabled:opacity-40 ${side === 'buy' ? 'bg-go' : 'bg-risk-high'}`}
      >
        {!q.session.authenticated
          ? side === 'buy'
            ? 'Sign in to buy'
            : 'Sign in to sell'
          : busy || armed
            ? side === 'buy'
              ? 'Buying…'
              : 'Selling…'
            : `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`}
      </button>

      {note && (
        <p className={`mt-2 flex items-start justify-center gap-1 text-center text-xs ${note.tone}`} title={note.detail}>
          {note.link ? (
            <a href={note.link} target="_blank" rel="noreferrer" className="underline">
              {note.text}
            </a>
          ) : (
            note.text
          )}
          {note.detail && <Info size={13} className="mt-px shrink-0 opacity-70" aria-label={note.detail} />}
        </p>
      )}

      {gear && <TradeSettings trade={fresh} side={side} token={token} ethUsd={ethUsd} onClose={() => setGear(false)} />}
    </section>
  );
}

type Note = { text: string; tone: string; detail?: string; link?: string };

/** The one quiet line under the button: what happened, what blocks the trade, or what to know. */
function noteFor({ token, trade, status }: { token: TradeToken; trade: QuickTrade | null; status: ReturnType<typeof useQuickTrade>['status'] }): Note | null {
  if (status.kind === 'success') return { text: 'Done. View transaction', tone: 'text-go', link: status.url };
  if (status.kind === 'sending') return { text: 'Signing…', tone: 'text-muted' };
  if (status.kind === 'pending') return { text: 'Waiting for the chain…', tone: 'text-muted' };
  if (status.kind === 'failed') return { text: status.message, tone: 'text-risk-high', link: status.url };
  // Signed-out quotes already leave out balance checks, so what's left applies to everyone.
  const blocker = trade?.blockers.find((b) => b.code !== 'RISK_ACK_REQUIRED');
  if (blocker) return { text: blocker.message, tone: 'text-risk-high' };
  if (token.risk === 'high') return { text: 'High risk token', tone: 'text-risk-high', detail: token.verdict ?? 'Rushr flagged this token. Read the safety notes before buying.' };
  if (token.risk === 'medium') return { text: 'Trade with care', tone: 'text-risk-medium', detail: token.verdict ?? 'Rushr found some risk signals on this token.' };
  if (!token.risk || token.risk === 'unknown')
    return { text: 'Unverified token', tone: 'text-muted', detail: "Rushr hasn't finished checking this token's contract and holders yet." };
  if (trade?.warnings[0]) return { text: trade.warnings[0], tone: 'text-risk-medium' };
  return null;
}

/* ------------------------------------------------------------------ settings behind the gear */

function TradeSettings({ trade, side, token, ethUsd, onClose }: { trade: QuickTrade | null; side: Side; token: TradeToken; ethUsd: number | null; onClose: () => void }) {
  const s = useSettings();
  const [slip, setSlip] = useState(s.slippagePct === 'auto' ? '' : String(s.slippagePct));
  const [cap, setCap] = useState(String(s.maxTradeEth));
  const q = trade?.quote;
  const outDec = side === 'buy' ? token.decimals : 18;
  const outSym = side === 'buy' ? token.symbol : 'ETH';
  const fmtOut = (v: bigint) => (side === 'buy' ? compact(whole(v, outDec)) : whole(v, 18).toFixed(6));
  const saveCap = () => {
    const n = Number(cap);
    if (Number.isFinite(n) && n > 0) updateSettings({ maxTradeEth: n });
    else setCap(String(s.maxTradeEth));
  };
  return (
    <Modal title="Trade settings" onClose={onClose}>
      <div className="space-y-5 text-sm">
        <Field label="Profile" hint="Each profile keeps its own slippage and quick-buy amounts.">
          <div className="grid grid-cols-3 rounded-xl bg-white/[0.04] p-1">
            {([0, 1, 2] as const).map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  updateSettings({ activePreset: i });
                  const p = s.presets[i];
                  setSlip(p.slippagePct === 'auto' ? '' : String(p.slippagePct));
                }}
                className={`rounded-lg py-1.5 font-mono text-xs font-semibold ${s.activePreset === i ? 'bg-white/10 text-ink' : 'text-muted'}`}
              >
                P{i + 1}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Slippage" hint="Auto picks 5–15% from the token's age, volatility and price impact, plus its measured tax.">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setSlip('');
                updateSettings({ slippagePct: 'auto' });
              }}
              className={`rounded-xl border px-4 py-2 text-xs ${s.slippagePct === 'auto' ? 'border-go/60 bg-go/10 text-go' : 'border-white/[0.08] text-muted'}`}
            >
              Auto
            </button>
            <label className="flex flex-1 items-center rounded-xl border border-white/[0.08] bg-bg px-3 focus-within:border-white/25">
              <input
                inputMode="decimal"
                value={slip}
                placeholder="Custom"
                onChange={(e) => setSlip(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
                onBlur={() => {
                  const n = Number(slip);
                  if (slip && Number.isFinite(n) && n > 0) updateSettings({ slippagePct: Math.min(LIMITS.slippagePct[1], Math.max(LIMITS.slippagePct[0], n)) });
                }}
                aria-label="Custom slippage percent"
                className="min-w-0 flex-1 bg-transparent py-2 font-mono text-xs outline-none"
              />
              <span className="text-xs text-muted">%</span>
            </label>
          </div>
        </Field>
        <Field label="Max per trade" hint="Buys above this are refused before anything is signed.">
          <label className="flex items-center rounded-xl border border-white/[0.08] bg-bg px-3 focus-within:border-white/25">
            <input
              inputMode="decimal"
              value={cap}
              onChange={(e) => setCap(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
              onBlur={saveCap}
              aria-label="Maximum ETH per trade"
              className="min-w-0 flex-1 bg-transparent py-2 font-mono text-xs outline-none"
            />
            <span className="text-xs text-muted">ETH{ethUsd ? ` ≈ ${usd(s.maxTradeEth * ethUsd)}` : ''}</span>
          </label>
        </Field>
        <Field label="Quote">
          {q ? (
            <dl className="space-y-1 rounded-xl bg-white/[0.03] p-3 text-xs">
              <Line k="You receive (est.)" v={`${fmtOut(q.amountOut)} ${outSym}`} />
              <Line k={`Min received (${(trade!.slippageBps / 100).toFixed(1)}%)`} v={`${fmtOut(q.minAmountOut)} ${outSym}`} />
              <Line k={feeLine(q)} v={`${whole(q.fee.feeAmount, 18).toFixed(6)} ETH`} />
              <Line k="Route" v={q.pool.venueFeeLabel} />
              {q.priceImpactBps != null && <Line k="Price impact" v={`${(q.priceImpactBps / 100).toFixed(2)}%`} />}
              <Line k="Network fee (est.)" v={trade!.gasCostWei ? (ethUsd ? usd(whole(trade!.gasCostWei, 18) * ethUsd) : `${whole(trade!.gasCostWei, 18).toFixed(6)} ETH`) : 'Automatic'} />
              {trade!.calls.length > 1 && <Line k="Transactions" v={`${trade!.calls.length} (the first sell approves the token)`} />}
            </dl>
          ) : (
            <p className="text-xs text-muted">Enter an amount to see the route, fees and minimum received. Gas is set automatically.</p>
          )}
        </Field>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3 py-2.5">
          <span>
            <span className="block text-sm">Pro mode</span>
            <span className="block text-xs text-muted">Full trade panel with presets, PnL strip and every stat.</span>
          </span>
          <Toggle on={s.proMode} onChange={(v) => updateSettings({ proMode: v })} label="Pro mode" />
        </label>
        <Link href="/settings" onClick={onClose} className="block text-center text-xs text-muted underline hover:text-ink">
          All trading settings
        </Link>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-muted">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted/80">{hint}</p>}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 truncate text-right font-mono">{v}</dd>
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition ${on ? 'bg-go' : 'bg-white/[0.12]'}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}
