'use client';

import { useEffect, useMemo, useState } from 'react';
import { erc20Abi, formatUnits, parseEther, parseUnits } from 'viem';
import Link from 'next/link';
import { feeLine } from '@rushr/trade';
import { tradingAvailable } from './flag';
import { chainClient, useKeepWarm, useQuickTrade, type TradeStatus, type TradeToken } from './use-quick-trade';

/**
 * Trade box for the token page. Beta v0: quick buy / sell from the user's Privy
 * embedded wallet with no confirmation popup, through Uniswap's Universal Router, with the Rushr fee in
 * the same tx. Renders nothing unless NEXT_PUBLIC_SWAP_ENABLED=1 and a Privy app id are set. Sign-in
 * and signing go through lib/auth (one Privy setup); settings come from /settings.
 */
export function TradeBox({ token }: { token: TradeToken }) {
  if (!tradingAvailable()) return null;
  return <TradeBoxInner token={token} />;
}

function fmt(v: bigint, decimals: number, max = 6) {
  const [i, f = ''] = formatUnits(v, decimals).split('.');
  const frac = f.slice(0, max).replace(/0+$/, '');
  return `${Number(i).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

function TradeBoxInner({ token }: { token: TradeToken }) {
  const q = useQuickTrade(token);
  const settings = q.settings;
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [bal, setBal] = useState<{ eth: bigint; token: bigint } | null>(null);

  // Balances of the embedded wallet (refreshed after each trade).
  useEffect(() => {
    if (!q.wallet) return setBal(null);
    let gone = false;
    Promise.all([
      chainClient().getBalance({ address: q.wallet }),
      chainClient().readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [q.wallet] }),
    ])
      .then(([eth, tok]) => !gone && setBal({ eth, token: tok }))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [q.wallet, token.address, q.status.kind === 'success']);

  const amountIn = useMemo(() => {
    try {
      const v = parseUnits(amount || '0', side === 'buy' ? 18 : token.decimals);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [amount, side, token.decimals]);

  // Debounced quote on input change, then kept prebuilt (refreshed every few seconds) while signed in,
  // so pressing Buy/Sell only signs and broadcasts.
  useEffect(() => {
    const t = setTimeout(() => void q.prepare(side, amountIn), 350);
    return () => clearTimeout(t);
  }, [side, amountIn, settings, q.ack, q.wallet]);
  useKeepWarm(q, side, amountIn, !!q.wallet);

  const t = q.trade;
  const busy = q.status.kind === 'sending' || q.status.kind === 'pending';
  const presetWei = (p: number | string) => {
    try {
      return parseEther(String(p));
    } catch {
      return 0n;
    }
  };
  const outDecimals = side === 'buy' ? token.decimals : 18;
  const outSymbol = side === 'buy' ? token.symbol : 'ETH';
  const needsAck = t?.blockers.some((b) => b.code === 'RISK_ACK_REQUIRED');

  return (
    <section className="rounded-2xl border border-line bg-surface p-3 text-sm" aria-label={`Trade ${token.symbol}`}>
      <div className="flex items-center gap-2">
        <div className="flex rounded-xl bg-surface-2 p-1" role="tablist">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => {
                setSide(s);
                setAmount('');
              }}
              className={`rounded-lg px-4 py-1 font-medium capitalize transition ${side === s ? (s === 'buy' ? 'bg-go text-bg' : 'bg-risk-high text-bg') : 'text-muted hover:text-ink'}`}
            >
              {s}
            </button>
          ))}
        </div>
        <Link href="/settings" className="ml-auto rounded-lg px-2 py-1 text-xs text-muted hover:text-ink" title={`Cap ${settings.maxTradeEth} ETH · slippage ${typeof settings.slippagePct === 'number' ? `${settings.slippagePct}%` : 'auto'}`}>
          Settings
        </Link>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
          placeholder={side === 'buy' ? '0.0 ETH' : `0 ${token.symbol}`}
          aria-label={side === 'buy' ? 'ETH to spend' : `${token.symbol} to sell`}
          className="min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono tabular-nums outline-none focus:border-brand/60"
        />
        <span className="text-xs text-muted">{side === 'buy' ? 'ETH' : token.symbol}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {side === 'buy'
          ? settings.buyPresets.map((p) => (
              <button key={p} type="button" onClick={() => setAmount(String(p))} onPointerEnter={() => q.wallet && q.warm('buy', presetWei(p))} className="rounded-lg bg-surface-2 px-2 py-1 font-mono text-xs text-muted hover:text-ink">
                {p}
              </button>
            ))
          : settings.sellPresets.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!bal}
                onClick={() => bal && setAmount(formatUnits((bal.token * BigInt(p)) / 100n, token.decimals))}
                className="rounded-lg bg-surface-2 px-2 py-1 font-mono text-xs text-muted hover:text-ink disabled:opacity-40"
              >
                {p}%
              </button>
            ))}
        {bal && (
          <span className="ml-auto self-center font-mono text-[11px] text-muted">
            {side === 'buy' ? `${fmt(bal.eth, 18, 4)} ETH` : `${fmt(bal.token, token.decimals, 2)} ${token.symbol}`}
          </span>
        )}
      </div>

      {t?.quote && (
        <dl className="mt-3 space-y-1 text-xs">
          <Row label="You receive (est.)" value={`${fmt(t.quote.amountOut, outDecimals)} ${outSymbol}`} />
          <Row label={`Min received (${(t.slippageBps / 100).toFixed(1)}% slippage)`} value={`${fmt(t.quote.minAmountOut, outDecimals)} ${outSymbol}`} />
          <Row label={feeLine(t.quote)} value={`${fmt(t.quote.fee.feeAmount, 18)} ETH`} />
          <Row label="Route" value={t.quote.pool.venueFeeLabel} />
          {t.calls.length > 1 && <Row label="Transactions" value={`${t.calls.length} (first sell approves the token)`} />}
        </dl>
      )}
      {t?.warnings.map((w) => (
        <p key={w} className="mt-2 rounded-lg bg-risk-medium/10 px-2 py-1 text-xs text-risk-medium">
          {w}
        </p>
      ))}
      {t?.blockers
        .filter((b) => b.code !== 'RISK_ACK_REQUIRED')
        .map((b) => (
          <p key={b.code} className="mt-2 rounded-lg bg-risk-high/10 px-2 py-1 text-xs text-risk-high">
            {b.message}
          </p>
        ))}
      {(needsAck || (q.ack && token.risk === 'high')) && (
        <label className="mt-2 flex items-start gap-2 rounded-lg bg-risk-high/10 px-2 py-1.5 text-xs text-risk-high">
          <input type="checkbox" checked={q.ack} onChange={(e) => q.setAck(e.target.checked)} className="mt-0.5" />
          <span>I understand this token is high risk{token.verdict ? ` (${token.verdict})` : ''} and I may lose what I put in.</span>
        </label>
      )}

      <button
        type="button"
        disabled={!q.session.ready || busy || (q.session.authenticated && (!t || !t.ok))}
        onClick={() => void q.execute()}
        className={`mt-3 w-full rounded-xl py-2.5 font-semibold text-bg transition disabled:opacity-40 ${side === 'buy' ? 'bg-go' : 'bg-risk-high'}`}
      >
        {!q.session.authenticated ? 'Sign in to trade' : busy ? 'Trading…' : side === 'buy' ? `Buy ${token.symbol}` : `Sell ${token.symbol}`}
      </button>
      <Status status={q.status} />
      <p className="mt-2 text-[11px] leading-snug text-muted">
        Trades are signed in your own Rushr wallet without a confirmation popup, up to your per-trade cap ({settings.maxTradeEth} ETH). Non-custodial: export your key any time.
      </p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono tabular-nums">{value}</dd>
    </div>
  );
}

export function Status({ status }: { status: TradeStatus }) {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'quoting':
      return <p className="mt-2 text-xs text-muted">Getting a fresh quote…</p>;
    case 'sending':
      return (
        <p className="mt-2 text-xs text-muted">
          {status.label === 'buy' ? 'Buying' : status.label === 'sell' ? 'Selling' : `Step ${status.step}/${status.total}: ${status.label}`}…
        </p>
      );
    case 'pending':
      return (
        <p className="mt-2 text-xs text-muted">
          Submitted{status.total > 1 ? ` ${status.step}/${status.total}` : ''}, confirming…{' '}
          <a className="underline" href={`https://robinhoodchain.blockscout.com/tx/${status.hash}`} target="_blank" rel="noreferrer">
            view
          </a>
        </p>
      );
    case 'success':
      return (
        <p className="mt-2 text-xs text-brand">
          Confirmed in {(status.ms / 1000).toFixed(1)}s.{' '}
          <a className="underline" href={status.url} target="_blank" rel="noreferrer">
            View on explorer
          </a>
        </p>
      );
    case 'failed':
      return (
        <p className="mt-2 text-xs text-risk-high">
          Failed: {status.message}
          {status.url && (
            <>
              {' '}
              <a className="underline" href={status.url} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            </>
          )}
        </p>
      );
  }
}
