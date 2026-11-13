'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { formatUnits, parseUnits, type Address } from 'viem';
import { ArrowDown, CaretDown, Check, Copy, Gear, GasPump, PencilSimple, Plus, ShareNetwork, Wallet, XLogo } from '@phosphor-icons/react';
import { feeLine, type QuickTrade } from '@rushr/trade';
import { tradingAvailable } from '@/components/trade/flag';
import { Status } from '@/components/trade/trade-box';
import { useQuickTrade, type TradeToken } from '@/components/trade/use-quick-trade';
import { compact, pctSigned, short, usd } from '@/lib/format';
import type { LivePosition } from '@/lib/position';
import { useEthUsd } from '@/lib/profile';
import { updateSettings, useSettings, type TradePreset, type TradeSettings } from '@/lib/settings';
import { useTokenBalance } from '@/lib/balances';
import { DepositPanel } from './profile/funding';
import { Modal } from './profile/modal';

/**
 * GMGN-style trade panel for the token page: your position in this token (balance, bought, sold,
 * PnL in $ or ETH, Sell All, share), P1/P2/P3 presets, Buy/Sell with preset amounts and sell
 * percentages with previews, then slippage and gas. Quoting and signing live in
 * components/trade/use-quick-trade.ts; this file only arranges them. Balances are read on-chain, updated optimistically when the swap is
 * broadcast, and re-read on confirmation and whenever the live feed shows a trade from this wallet.
 */
export function TradePanel(props: { token: TradeToken; priceUsd: number | null; position: LivePosition }) {
  if (!tradingAvailable()) return null;
  return <Panel {...props} />;
}

type Side = 'buy' | 'sell';
type Bal = { eth: bigint; token: bigint };

function units(v: bigint, decimals: number, max = 6) {
  const [i, f = ''] = formatUnits(v, decimals).split('.');
  const frac = f.slice(0, max).replace(/0+$/, '');
  return `${Number(i).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
const whole = (v: bigint, decimals: number) => Number(formatUnits(v, decimals));


function Panel({ token, priceUsd, position }: { token: TradeToken; priceUsd: number | null; position: LivePosition }) {
  const q = useQuickTrade(token);
  const settings = useSettings();
  const ethUsd = useEthUsd();
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const chainBal = useTokenBalance(q.wallet, token.address, tick);
  // Applied when the swap is broadcast, dropped once the chain is re-read.
  const [optimistic, setOptimistic] = useState<Bal | null>(null);
  const bal = optimistic ?? chainBal;
  const [modal, setModal] = useState<'deposit' | 'presets' | 'share' | null>(null);

  const busy = q.status.kind === 'sending' || q.status.kind === 'pending';
  const amountIn = useMemo(() => {
    try {
      const v = parseUnits(amount || '0', side === 'buy' ? 18 : token.decimals);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [amount, side, token.decimals]);

  /* ---- submit: quote for exactly this side and amount, then send it */
  const [armed, setArmed] = useState<{ side: Side; amount: bigint } | null>(null);
  const submitted = useRef<QuickTrade | null>(null);

  // q.prepare is a new function on every render (the page passes a fresh token object), so effects
  // read it through a ref and re-quote only when an input that matters changes.
  const prepareRef = useRef(q.prepare);
  prepareRef.current = q.prepare;
  const executeRef = useRef(q.execute);
  executeRef.current = q.execute;

  // Debounced quote while typing (never while a trade is in flight or a submit is waiting).
  useEffect(() => {
    if (busy || armed) return;
    const t = setTimeout(() => void prepareRef.current(side, amountIn), 350);
    return () => clearTimeout(t);
  }, [side, amountIn, settings, q.ack, q.wallet]);

  useEffect(() => {
    if (!armed) return;
    if (q.status.kind === 'failed') return setArmed(null);
    const t = q.trade;
    const r = t?.quote?.request;
    if (!t || !r || r.side !== armed.side || r.amountIn !== armed.amount) return;
    setArmed(null);
    if (!t.ok) return; // blockers show below
    submitted.current = t;
    void executeRef.current();
  }, [armed, q.trade, q.status.kind]);

  const submit = (s: Side, amt: bigint) => {
    if (!q.session.authenticated || !q.wallet) return void q.execute(); // opens sign-in
    if (amt <= 0n || busy) return;
    setArmed({ side: s, amount: amt });
    const r = q.trade?.quote?.request;
    if (!r || r.side !== s || r.amountIn !== amt) void prepareRef.current(s, amt);
  };

  const sellAll = () => {
    if (!bal || bal.token <= 0n || busy) return;
    setSide('sell');
    setAmount(formatUnits(bal.token, token.decimals));
    submit('sell', bal.token);
  };

  /* ---- optimistic balance on broadcast, chain re-read on confirmation or failure */
  const statusKind = q.status.kind;
  const statusStep = q.status.kind === 'pending' ? q.status.step === q.status.total : false;
  useEffect(() => {
    const t = submitted.current;
    if (statusKind === 'pending' && statusStep && t?.quote && chainBal) {
      const { side: s, amountIn: inAmt } = t.quote.request;
      const out = t.quote.amountOut;
      setOptimistic(
        s === 'buy'
          ? { eth: chainBal.eth - inAmt, token: chainBal.token + out }
          : { eth: chainBal.eth + out, token: chainBal.token > inAmt ? chainBal.token - inAmt : 0n },
      );
    }
    if (statusKind === 'success' || statusKind === 'failed') {
      submitted.current = null;
      refresh();
      if (statusKind === 'success') setAmount('');
    }
  }, [statusKind, statusStep]);
  // A fresh chain read replaces the optimistic numbers.
  useEffect(() => setOptimistic(null), [chainBal]);

  // A new confirmed trade from this wallet (here, another device or the feed) re-reads the balance.
  const settled = position.trades.filter((x) => !x.pending).length;
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (seen.current !== null && settled !== seen.current) refresh();
    seen.current = settled;
  }, [settled, refresh]);

  const t = q.trade;
  const needsAck = t?.blockers.some((b) => b.code === 'RISK_ACK_REQUIRED');
  const preset = settings.presets[settings.activePreset];
  const signedIn = q.session.authenticated && !!q.wallet;

  return (
    <section className="shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-surface text-sm" aria-label={`Trade ${token.symbol}`}>
      {signedIn && (
        <PositionStrip
          token={token}
          bal={bal}
          position={position}
          priceUsd={priceUsd}
          ethUsd={ethUsd}
          busy={busy}
          onSellAll={sellAll}
          onShare={() => setModal('share')}
        />
      )}

      <div className="space-y-3 p-3">
        {/* presets, wallet, ETH balance */}
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-lg bg-white/[0.04] p-0.5" role="tablist" aria-label="Trading preset">
            {([0, 1, 2] as const).map((i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={settings.activePreset === i}
                onClick={() => updateSettings({ activePreset: i })}
                className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold transition ${settings.activePreset === i ? 'bg-white/10 text-ink' : 'text-muted hover:text-ink'}`}
              >
                P{i + 1}
              </button>
            ))}
          </div>
          {signedIn && <WalletChip wallet={q.wallet!} />}
          <div className="ml-auto flex items-center gap-1">
            {signedIn && (
              <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted" title="ETH balance">
                {bal ? units(bal.eth, 18, 4) : '…'} ETH
              </span>
            )}
            {signedIn && (
              <IconButton label="Deposit" onClick={() => setModal('deposit')}>
                <Plus size={13} weight="bold" />
              </IconButton>
            )}
            <IconButton label="Preset settings" onClick={() => setModal('presets')}>
              <Gear size={14} />
            </IconButton>
          </div>
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 border-b border-white/[0.06]">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                if (busy) return;
                setSide(s);
                setAmount('');
              }}
              className={`-mb-px border-b-2 px-3 pb-2 text-sm font-semibold capitalize transition ${
                side === s ? (s === 'buy' ? 'border-go text-go' : 'border-risk-high text-risk-high') : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {s}
            </button>
          ))}
          {['Auto', 'Limit'].map((x) => (
            <span key={x} className="flex items-center gap-1 px-2 pb-2 text-xs text-muted/60" title="Coming soon">
              {x} <span className="rounded bg-white/[0.05] px-1 text-[9px] uppercase tracking-wide">soon</span>
            </span>
          ))}
        </div>

        {side === 'buy' ? (
          <BuyInputs preset={preset} amount={amount} setAmount={setAmount} maxTradeEth={settings.maxTradeEth} />
        ) : (
          <SellInputs
            token={token}
            preset={preset}
            presetIndex={settings.activePreset}
            settings={settings}
            bal={bal}
            amount={amount}
            setAmount={setAmount}
            priceUsd={priceUsd}
            ethUsd={ethUsd}
          />
        )}

        {/* what you get */}
        {amountIn > 0n && (
          <div className="flex items-center justify-between rounded-xl bg-white/[0.03] px-3 py-2 font-mono text-xs tabular-nums">
            <span className="text-muted">
              {side === 'buy' ? `${amount} ETH` : `${compact(whole(amountIn, token.decimals))} ${token.symbol}`}
            </span>
            <ArrowDown size={12} className="-rotate-90 text-muted" />
            <span>
              {t?.quote && t.quote.request.amountIn === amountIn
                ? side === 'buy'
                  ? `${compact(whole(t.quote.amountOut, token.decimals))} ${token.symbol}`
                  : `${units(t.quote.amountOut, 18, 4)} ETH`
                : q.status.kind === 'quoting'
                  ? 'Quoting…'
                  : '—'}
            </span>
          </div>
        )}
        {t?.quote && t.quote.request.amountIn === amountIn && (
          <dl className="space-y-1 text-[11px]">
            <Row label={`Min received (${(t.slippageBps / 100).toFixed(1)}%)`} value={side === 'buy' ? `${compact(whole(t.quote.minAmountOut, token.decimals))} ${token.symbol}` : `${units(t.quote.minAmountOut, 18, 5)} ETH`} />
            <Row label={feeLine(t.quote)} value={`${units(t.quote.fee.feeAmount, 18, 6)} ETH`} />
            {t.quote.priceImpactBps != null && <Row label="Price impact" value={`${(t.quote.priceImpactBps / 100).toFixed(2)}%`} warn={t.quote.priceImpactBps > 500} />}
            {t.calls.length > 1 && <Row label="Transactions" value={`${t.calls.length} (first sell approves)`} />}
          </dl>
        )}

        {t?.warnings.map((w) => (
          <p key={w} className="rounded-lg bg-risk-medium/10 px-2 py-1 text-xs text-risk-medium">
            {w}
          </p>
        ))}
        {t?.blockers
          .filter((b) => b.code !== 'RISK_ACK_REQUIRED')
          .map((b) => (
            <p key={b.code} className="rounded-lg bg-risk-high/10 px-2 py-1 text-xs text-risk-high">
              {b.message}
            </p>
          ))}
        {(needsAck || (q.ack && token.risk === 'high')) && (
          <label className="flex items-start gap-2 rounded-lg bg-risk-high/10 px-2 py-1.5 text-xs text-risk-high">
            <input type="checkbox" checked={q.ack} onChange={(e) => q.setAck(e.target.checked)} className="mt-0.5" />
            <span>I understand this token is high risk{token.verdict ? ` (${token.verdict})` : ''} and I may lose what I put in.</span>
          </label>
        )}

        <button
          type="button"
          disabled={!q.session.ready || busy || !!armed || (signedIn && amountIn <= 0n)}
          onClick={() => submit(side, amountIn)}
          className={`w-full rounded-xl py-3 text-[15px] font-semibold text-bg transition hover:brightness-110 disabled:opacity-40 ${side === 'buy' ? 'bg-go' : 'bg-risk-high'}`}
        >
          {!q.session.authenticated
            ? 'Sign in to trade'
            : busy || armed
              ? side === 'buy'
                ? 'Buying…'
                : 'Selling…'
              : side === 'buy'
                ? `Buy ${token.symbol}`
                : bal && amountIn === bal.token && amountIn > 0n
                  ? `Sell all ${token.symbol}`
                  : `Sell ${token.symbol}`}
        </button>
        <Status status={q.status} />

        <div className="flex items-center gap-3 border-t border-white/[0.05] pt-2 font-mono text-[11px] text-muted">
          <button type="button" onClick={() => setModal('presets')} className="hover:text-ink" title="Slippage for this preset">
            Slippage{' '}
            <span className="text-ink">
              {preset.slippagePct === 'auto' ? `Auto${t?.quote ? ` ${(t.slippageBps / 100).toFixed(1)}%` : ''}` : `${preset.slippagePct}%`}
            </span>
          </button>
          <span className="flex items-center gap-1" title="Estimated network fee (gas is set automatically)">
            <GasPump size={12} /> Gas
            {t?.gasCostWei ? (
              <span className="text-ink">{ethUsd ? usd(whole(t.gasCostWei, 18) * ethUsd) : `${units(t.gasCostWei, 18, 6)} ETH`}</span>
            ) : (
              <span className="text-ink">Auto</span>
            )}
          </span>
          <span className="ml-auto" title="Per-trade cap (settings)">
            Cap <span className="text-ink">{settings.maxTradeEth} ETH</span>
          </span>
        </div>
      </div>

      {modal === 'deposit' && q.wallet && (
        <Modal title="Deposit" onClose={() => setModal(null)} wide>
          <DepositPanel address={q.wallet} />
        </Modal>
      )}
      {modal === 'presets' && <PresetEditor settings={settings} onClose={() => setModal(null)} />}
      {modal === 'share' && (
        <ShareCard token={token} position={position} bal={bal} priceUsd={priceUsd} onClose={() => setModal(null)} />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ position strip */

/**
 * Strip numbers from the live position (repriced on every tick, own trades applied as soon as they're
 * signed). Before the first server read, the on-chain balance stands in for the amount held.
 */
function positionNumbers(token: TradeToken, bal: Bal | null, p: LivePosition, priceUsd: number | null) {
  const held = p.loaded ? p.held : bal ? whole(bal.token, token.decimals) : 0;
  const heldUsd = priceUsd != null ? held * priceUsd : null;
  const has = p.loaded && (p.boughtUsd > 0 || p.held > 0);
  return { held, heldUsd, bought: has ? p.boughtUsd : null, sold: has ? p.soldUsd : null, pnl: has ? p.pnlUsd : null, pnlPct: has ? p.pnlPct : null };
}

function PositionStrip({
  token,
  bal,
  position,
  priceUsd,
  ethUsd,
  busy,
  onSellAll,
  onShare,
}: {
  token: TradeToken;
  bal: Bal | null;
  position: LivePosition;
  priceUsd: number | null;
  ethUsd: number | null;
  busy: boolean;
  onSellAll: () => void;
  onShare: () => void;
}) {
  const [unit, setUnit] = useState<'usd' | 'eth'>('usd');
  const [balAs, setBalAs] = useState<'usd' | 'token'>('usd');
  const n = positionNumbers(token, bal, position, priceUsd);
  const money = (v: number | null, signed = false) => {
    if (v == null) return '—';
    if (unit === 'eth') {
      if (!ethUsd) return '—';
      const e = v / ethUsd;
      return `${signed && e >= 0 ? '+' : ''}${e.toFixed(Math.abs(e) >= 1 ? 3 : 4)}`;
    }
    return signed ? `${v >= 0 ? '+' : '-'}${usd(Math.abs(v))}` : usd(v);
  };
  const tone = n.pnl == null ? '' : n.pnl >= 0 ? 'text-go' : 'text-risk-high';
  return (
    <div className="border-b border-white/[0.06] bg-white/[0.015] px-3 pb-2.5 pt-2">
      <div className="grid grid-cols-4 gap-2">
        <Stat label="Bal" onLabel={() => setBalAs(balAs === 'usd' ? 'token' : 'usd')} labelHint={balAs === 'usd' ? `Show ${token.symbol}` : 'Show $'}>
          {balAs === 'token' ? compact(n.held) : money(n.heldUsd)}
        </Stat>
        <Stat label="Bought">{money(n.bought)}</Stat>
        <Stat label="Sold">{money(n.sold)}</Stat>
        <Stat label="PnL" className={tone}>
          {money(n.pnl, true)}
          <span className="block text-[10px] font-medium leading-tight">{n.pnlPct != null ? pctSigned(n.pnlPct, 1) : '\u00a0'}</span>
        </Stat>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <div className="flex rounded-md bg-white/[0.04] p-0.5 font-mono text-[10px]">
          {(['usd', 'eth'] as const).map((u) => (
            <button key={u} type="button" onClick={() => setUnit(u)} className={`rounded px-1.5 py-px ${unit === u ? 'bg-white/10 text-ink' : 'text-muted hover:text-ink'}`}>
              {u === 'usd' ? '$' : 'ETH'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onShare}
          disabled={n.pnl == null}
          aria-label="Share PnL card"
          title="Share PnL card"
          className="rounded-md p-1 text-muted hover:bg-white/[0.05] hover:text-ink disabled:opacity-30"
        >
          <ShareNetwork size={13} />
        </button>
        <button
          type="button"
          onClick={onSellAll}
          disabled={busy || !bal || bal.token <= 0n}
          className="ml-auto rounded-md bg-risk-high/20 px-2 py-0.5 text-[11px] font-semibold text-risk-high transition hover:bg-risk-high/30 disabled:opacity-30"
        >
          Sell All
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  children,
  className = '',
  onLabel,
  labelHint,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  onLabel?: () => void;
  labelHint?: string;
}) {
  return (
    <div className="min-w-0">
      {onLabel ? (
        <button type="button" onClick={onLabel} title={labelHint} className="flex items-center gap-0.5 text-[10px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink">
          {label}
        </button>
      ) : (
        <div className="text-[10px] text-muted">{label}</div>
      )}
      <div className={`truncate font-mono text-[12px] font-semibold tabular-nums ${className}`}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

function BuyInputs({ preset, amount, setAmount, maxTradeEth }: { preset: TradePreset; amount: string; setAmount: (v: string) => void; maxTradeEth: number }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1.5">
        {preset.buy.map((p, i) => (
          <button
            key={`${p}-${i}`}
            type="button"
            onClick={() => setAmount(p)}
            className={`rounded-lg border py-1.5 font-mono text-xs transition ${amount === p ? 'border-go/60 bg-go/10 text-go' : 'border-white/[0.06] text-ink/80 hover:border-white/20'}`}
          >
            {p}
          </button>
        ))}
      </div>
      <AmountInput value={amount} onChange={setAmount} suffix="ETH" label="ETH to spend" hint={Number(amount) > maxTradeEth ? `Above your ${maxTradeEth} ETH cap` : undefined} />
    </div>
  );
}

function SellInputs({
  token,
  preset,
  presetIndex,
  settings,
  bal,
  amount,
  setAmount,
  priceUsd,
  ethUsd,
}: {
  token: TradeToken;
  preset: TradePreset;
  presetIndex: 0 | 1 | 2;
  settings: TradeSettings;
  bal: Bal | null;
  amount: string;
  setAmount: (v: string) => void;
  priceUsd: number | null;
  ethUsd: number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preset.sell.map(String));
  useEffect(() => setDraft(preset.sell.map(String)), [preset.sell]);
  const save = () => {
    const sell = draft.map((v, i) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : preset.sell[i]!;
    }) as TradePreset['sell'];
    updateSettings({ presets: settings.presets.map((p, j) => (j === presetIndex ? { ...p, sell } : p)) as TradeSettings['presets'] });
    setEditing(false);
  };
  // Partial sells round down to 4 decimals (readable, never above the balance); 100% sells exactly all.
  const fill = (pctV: number) => {
    const v = formatUnits(part(pctV), token.decimals);
    if (pctV >= 100) return v;
    const [i, f = ''] = v.split('.');
    const frac = f.slice(0, 4).replace(/0+$/, '');
    return frac ? `${i}.${frac}` : i!;
  };
  const part = (pctV: number) => (bal ? (pctV >= 100 ? bal.token : (bal.token * BigInt(Math.round(pctV * 100))) / 10_000n) : 0n);
  const ethFor = (tokens: bigint) => (priceUsd != null && ethUsd ? (whole(tokens, token.decimals) * priceUsd) / ethUsd : null);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_auto] gap-1.5">
        {preset.sell.map((p, i) =>
          editing ? (
            <input
              key={i}
              inputMode="numeric"
              value={draft[i]}
              onChange={(e) => setDraft(draft.map((d, j) => (j === i ? e.target.value.replace(/[^\d]/g, '').slice(0, 3) : d)))}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              aria-label={`Sell preset ${i + 1} percent`}
              className="w-full rounded-lg border border-white/20 bg-bg py-1.5 text-center font-mono text-xs outline-none focus:border-risk-high/60"
            />
          ) : (
            <button
              key={i}
              type="button"
              disabled={!bal || bal.token <= 0n}
              onClick={() => setAmount(fill(p))}
              className={`rounded-lg border py-1.5 font-mono text-xs transition disabled:opacity-40 ${
                bal && amount && amount === fill(p) ? 'border-risk-high/60 bg-risk-high/10 text-risk-high' : 'border-white/[0.06] text-ink/80 hover:border-white/20'
              }`}
            >
              {p}%
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => (editing ? save() : setEditing(true))}
          aria-label={editing ? 'Save sell presets' : 'Edit sell presets'}
          className="rounded-lg border border-white/[0.06] px-2 text-muted hover:text-ink"
        >
          {editing ? <Check size={13} /> : <PencilSimple size={13} />}
        </button>
      </div>
      {bal && bal.token > 0n && !editing && (
        <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_auto] gap-1.5 font-mono text-[10px] leading-tight text-muted">
          {preset.sell.map((p, i) => {
            const e = ethFor(part(p));
            return (
              <span
                key={i}
                className="truncate text-center"
                title={`${p}%: ${units(part(p), token.decimals, 2)} ${token.symbol}${e != null ? ` ≈ ${e.toPrecision(3)} ETH` : ''}`}
              >
                {compact(whole(part(p), token.decimals))}
                <br />≈{e != null ? (e >= 1 ? e.toFixed(2) : Number(e.toPrecision(2)).toString()) : '—'}
              </span>
            );
          })}
          <span className="w-[30px] self-end text-center">ETH</span>
        </div>
      )}
      <AmountInput
        value={amount}
        onChange={setAmount}
        suffix={token.symbol}
        label={`${token.symbol} to sell`}
        hint={bal ? `Balance ${units(bal.token, token.decimals, 2)}` : undefined}
      />
    </div>
  );
}

function AmountInput({ value, onChange, suffix, label, hint }: { value: string; onChange: (v: string) => void; suffix: string; label: string; hint?: string }) {
  return (
    <div>
      <label className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-bg px-3 py-2 focus-within:border-white/25">
        <span className="text-[11px] text-muted">Amount</span>
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
          placeholder="0.0"
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent text-right font-mono tabular-nums outline-none"
        />
        <span className="max-w-[72px] truncate text-xs text-muted">{suffix}</span>
      </label>
      {hint && <p className="mt-1 text-right font-mono text-[10px] text-muted">{hint}</p>}
    </div>
  );
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 truncate text-right font-mono tabular-nums ${warn ? 'text-risk-medium' : ''}`}>{value}</dd>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded-md p-1 text-muted hover:bg-white/[0.05] hover:text-ink">
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ wallet chip */

function WalletChip({ wallet }: { wallet: Address }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-ink"
      >
        <Wallet size={12} /> {short(wallet, 2, 3)} <CaretDown size={9} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-xl border border-white/[0.08] bg-surface p-1 shadow-xl">
          <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5 text-xs">
            <Check size={12} className="text-go" />
            <span className="min-w-0 flex-1">
              <span className="block">Rushr wallet</span>
              <span className="font-mono text-[10px] text-muted">{short(wallet, 4, 4)}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(wallet).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-white/[0.04] hover:text-ink"
          >
            <Copy size={12} /> {copied ? 'Copied' : 'Copy address'}
          </button>
          <Link href="/me" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-white/[0.04] hover:text-ink">
            <Wallet size={12} /> Wallet and portfolio
          </Link>
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-muted/80">More wallets per account are coming.</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ preset editor */

function PresetEditor({ settings, onClose }: { settings: TradeSettings; onClose: () => void }) {
  const [which, setWhich] = useState<0 | 1 | 2>(settings.activePreset);
  const [drafts, setDrafts] = useState(() =>
    settings.presets.map((p) => ({ buy: [...p.buy], sell: p.sell.map(String), slip: p.slippagePct === 'auto' ? '' : String(p.slippagePct), auto: p.slippagePct === 'auto' })),
  );
  const d = drafts[which]!;
  const set = (patch: Partial<typeof d>) => setDrafts(drafts.map((x, i) => (i === which ? { ...x, ...patch } : x)));
  const save = () => {
    updateSettings({
      presets: drafts.map((x) => ({
        buy: x.buy as TradePreset['buy'],
        sell: x.sell.map(Number) as TradePreset['sell'],
        slippagePct: x.auto || !x.slip ? 'auto' : Number(x.slip),
      })) as TradeSettings['presets'],
      activePreset: which,
    });
    onClose();
  };
  const input = 'w-full rounded-lg border border-white/[0.08] bg-bg px-2 py-1.5 text-center font-mono text-xs outline-none focus:border-white/25';
  return (
    <Modal title="Trading presets" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {([0, 1, 2] as const).map((i) => (
            <button key={i} type="button" onClick={() => setWhich(i)} className={`flex-1 rounded-md py-1 font-mono text-xs font-semibold ${which === i ? 'bg-white/10 text-ink' : 'text-muted'}`}>
              P{i + 1}
            </button>
          ))}
        </div>
        <fieldset>
          <legend className="mb-1 text-xs text-muted">Buy amounts (ETH)</legend>
          <div className="grid grid-cols-4 gap-1.5">
            {d.buy.map((v, i) => (
              <input
                key={i}
                inputMode="decimal"
                value={v}
                aria-label={`Buy amount ${i + 1}`}
                onChange={(e) => set({ buy: d.buy.map((x, j) => (j === i ? e.target.value.replace(',', '.').replace(/[^\d.]/g, '') : x)) })}
                className={input}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-xs text-muted">Sell percentages</legend>
          <div className="grid grid-cols-4 gap-1.5">
            {d.sell.map((v, i) => (
              <input
                key={i}
                inputMode="numeric"
                value={v}
                aria-label={`Sell percent ${i + 1}`}
                onChange={(e) => set({ sell: d.sell.map((x, j) => (j === i ? e.target.value.replace(/[^\d]/g, '').slice(0, 3) : x)) })}
                className={input}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-xs text-muted">Slippage</legend>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => set({ auto: true })}
              className={`rounded-lg border px-3 py-1.5 text-xs ${d.auto ? 'border-go/60 bg-go/10 text-go' : 'border-white/[0.08] text-muted'}`}
            >
              Auto
            </button>
            <label className="flex flex-1 items-center gap-1 rounded-lg border border-white/[0.08] bg-bg px-2 focus-within:border-white/25">
              <input
                inputMode="decimal"
                value={d.slip}
                placeholder="Custom"
                onFocus={() => set({ auto: false })}
                onChange={(e) => set({ slip: e.target.value.replace(',', '.').replace(/[^\d.]/g, ''), auto: false })}
                aria-label="Custom slippage percent"
                className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-xs outline-none"
              />
              <span className="text-xs text-muted">%</span>
            </label>
          </div>
          <p className="mt-1 text-[11px] text-muted">Auto picks 5–15% from the token&apos;s age, volatility and price impact, plus its measured tax.</p>
        </fieldset>
        <p className="text-[11px] leading-relaxed text-muted">
          <GasPump size={12} className="mr-1 inline align-[-2px]" />
          Gas is set automatically. The per-trade cap ({settings.maxTradeEth} ETH) is in{' '}
          <Link href="/settings" className="underline hover:text-ink" onClick={onClose}>
            settings
          </Link>
          .
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/[0.08] py-2.5 text-sm text-muted hover:text-ink">
            Cancel
          </button>
          <button type="button" onClick={save} className="rounded-xl bg-ink py-2.5 text-sm font-semibold text-bg hover:bg-white">
            Save P{which + 1}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ share card */

function ShareCard({ token, position, bal, priceUsd, onClose }: { token: TradeToken; position: LivePosition; bal: Bal | null; priceUsd: number | null; onClose: () => void }) {
  const n = positionNumbers(token, bal, position, priceUsd);
  const [copied, setCopied] = useState(false);
  const up = (n.pnl ?? 0) >= 0;
  const url = typeof window !== 'undefined' ? `${window.location.origin}/token/${token.address}` : `https://rushr.trade/token/${token.address}`;
  const text = `${up ? 'Up' : 'Down'} ${n.pnlPct != null ? pctSigned(n.pnlPct, 1) : ''} on $${token.symbol} (${n.pnl != null ? `${up ? '+' : '-'}${usd(Math.abs(n.pnl))}` : '—'}) on Rushr`;
  return (
    <Modal title="Share PnL" onClose={onClose}>
      <div
        className="relative overflow-hidden rounded-2xl border border-white/[0.08] p-5"
        style={{ background: up ? 'radial-gradient(120% 90% at 100% 0%, rgba(54,212,42,.22), transparent 60%), #0b0d0b' : 'radial-gradient(120% 90% at 100% 0%, rgba(255,107,91,.2), transparent 60%), #0d0b0b' }}
      >
        <div className="flex items-center justify-between text-xs text-muted">
          <span className="font-semibold text-ink">rushr</span>
          <span className="font-mono">Robinhood Chain</span>
        </div>
        <div className="mt-5 font-mono text-sm text-muted">${token.symbol}</div>
        <div className={`mt-1 font-mono text-4xl font-bold tabular-nums ${up ? 'text-go' : 'text-risk-high'}`}>{n.pnlPct != null ? pctSigned(n.pnlPct, 1) : '—'}</div>
        <div className={`font-mono text-lg tabular-nums ${up ? 'text-go' : 'text-risk-high'}`}>{n.pnl != null ? `${up ? '+' : '-'}${usd(Math.abs(n.pnl))}` : '—'}</div>
        <dl className="mt-5 grid grid-cols-3 gap-2 font-mono text-xs">
          <div>
            <dt className="text-muted">Bought</dt>
            <dd>{usd(n.bought)}</dd>
          </div>
          <div>
            <dt className="text-muted">Sold</dt>
            <dd>{usd(n.sold)}</dd>
          </div>
          <div>
            <dt className="text-muted">Holding</dt>
            <dd>{usd(n.heldUsd)}</dd>
          </div>
        </dl>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(`${text}\n${url}`).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
          className="flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] py-2.5 text-sm text-muted hover:text-ink"
        >
          <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1.5 rounded-xl bg-ink py-2.5 text-sm font-semibold text-bg hover:bg-white"
        >
          <XLogo size={14} /> Post
        </a>
      </div>
    </Modal>
  );
}
