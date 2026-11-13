'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CaretDown, Globe, MagnifyingGlass, TelegramLogo, XLogo } from '@phosphor-icons/react';
import type { TokenDetail } from '@/lib/api';
import { auth, useAuth } from '@/lib/auth';
import { compact, countFmt, pctSigned, usd } from '@/lib/format';
import { getMe, setMe, useMe } from '@/lib/members';
import { CALL_MAX, postCallout } from '@/lib/callouts';
import { useHint } from '@/lib/session-hint';
import type { LivePosition } from '@/lib/position';
import { TRADE_LIMIT, WINDOWS, type Tx, type WindowId, type WindowStats } from '@/lib/trades';
import { MemberAvatar } from './member-avatar';
import { TokenAvatar } from './bits';

/* ------------------------------------------------------------------ position */

/** Your position in this token: value now, PnL, what you put in and your average entry (as market cap). */
export function PositionCard({ t, position, supply }: { t: TokenDetail; position: LivePosition; supply: number }) {
  if (!position.loaded || position.held <= 0) return null;
  const up = (position.pnlUsd ?? 0) >= 0;
  const tone = position.pnlUsd == null ? 'text-muted' : up ? 'text-go' : 'text-risk-high';
  const avgEntry = position.boughtTokens > 0 ? position.boughtUsd / position.boughtTokens : null;
  return (
    <section className="shrink-0 rounded-2xl border border-white/[0.06] bg-surface p-4" aria-label="Your position">
      <div className="flex items-center gap-3">
        <TokenAvatar t={t} size={40} />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-2xl font-semibold leading-tight">{usd(position.heldUsd)}</div>
          <div className="truncate font-mono text-xs text-muted">
            {compact(position.held)} {t.symbol}
          </div>
        </div>
        <div className={`text-right font-mono ${tone}`}>
          <div className="text-base font-semibold">{position.pnlUsd == null ? '—' : `${up ? '+' : '-'}${usd(Math.abs(position.pnlUsd))}`}</div>
          <div className="text-xs">{position.pnlPct == null ? '' : pctSigned(position.pnlPct, 1)}</div>
        </div>
      </div>
      <dl className="mt-3 space-y-1.5 border-t border-white/[0.05] pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Invested</dt>
          <dd className="font-mono">{usd(position.boughtUsd)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Avg entry</dt>
          <dd className="font-mono">{avgEntry != null && supply ? `${usd(avgEntry * supply)} MC` : '—'}</dd>
        </div>
        {position.syncing && <p className="text-[11px] text-muted">Updating with your latest trade…</p>}
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------ call composer */

/**
 * Post your call on this token (POST /v1/callouts), visible to everyone; your most recent buy of
 * the token is linked by the server. The stance starts from your last trade here, and right after
 * a buy the box offers to share the call. Posting needs a registered member (sign-up is invite-only).
 */
export function ThesisBox({ t, position }: { t: TokenDetail; position: LivePosition }) {
  const session = useAuth();
  const me = useMe();
  const member = me?.status === 'registered' ? me.member : null;
  const lastSide = [...position.trades].reverse().find((x) => !x.pending)?.side ?? null;
  const [text, setText] = useState('');
  const [stance, setStance] = useState<'bullish' | 'bearish'>('bullish');
  const [touched, setTouched] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Default the stance from the last trade until the user picks one.
  useEffect(() => {
    if (!touched && lastSide) setStance(lastSide === 'buy' ? 'bullish' : 'bearish');
  }, [lastSide, touched]);

  // After a confirmed buy of this token from this browser: "Share your call?"
  useEffect(() => {
    const wallet = session.user?.wallet?.toLowerCase();
    if (!wallet) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ phase?: string; side?: string; wallet?: string; token?: string }>).detail;
      if (d?.phase !== 'confirmed' || d.side !== 'buy' || d.wallet?.toLowerCase() !== wallet || d.token?.toLowerCase() !== t.address.toLowerCase()) return;
      setNudge(true);
      setStance('bullish');
      setText((cur) => cur || `Just bought $${t.symbol}. `);
    };
    window.addEventListener('rushr:trade', on);
    return () => window.removeEventListener('rushr:trade', on);
  }, [session.user?.wallet, t.address, t.symbol]);

  const post = async () => {
    if (!member || !text.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    const r = await postCallout({ token: t.address, stance, body: text.trim() });
    setBusy(false);
    if (r.ok) {
      setText('');
      setNudge(false);
      setMsg({ ok: true, text: 'Posted. Your call is live on the chart.' });
    } else setMsg({ ok: false, text: r.message });
  };

  // While the session or the member is still loading, show a neutral state, never "Sign up".
  const hint = useHint();
  const loading = !member && (hint === undefined || (!session.ready && !!hint) || (session.authenticated && me == null));
  // A member painted from the session hint can write; posting waits for the real session.
  const canPost = !!member;
  const live = session.ready && session.authenticated;

  return (
    <section
      className={`shrink-0 rounded-2xl border bg-surface p-3 transition ${nudge ? 'border-brand/40 shadow-[0_0_0_3px] shadow-brand/10' : 'border-white/[0.06]'}`}
      aria-label="Post your call"
    >
      {nudge && <p className="mb-2 text-sm font-medium text-brand">Share your call?</p>}
      <div className="flex items-center gap-2">
        {member ? (
          <Link href={`/u/${member.handle}`} className="flex min-w-0 items-center gap-2 hover:opacity-90">
            <MemberAvatar member={member} size={28} />
            <span className="min-w-0 truncate text-sm font-medium">@{member.handle}</span>
          </Link>
        ) : (
          <span className="text-sm font-medium">Your call</span>
        )}
        <span className="rounded-md bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">Thesis</span>
        <div className="ml-auto flex rounded-lg bg-white/[0.04] p-0.5 text-[11px]" role="radiogroup" aria-label="Stance">
          {(['bullish', 'bearish'] as const).map((st) => (
            <button
              key={st}
              type="button"
              role="radio"
              aria-checked={stance === st}
              onClick={() => {
                setTouched(true);
                setStance(st);
              }}
              className={`rounded-md px-2 py-0.5 capitalize ${stance === st ? (st === 'bullish' ? 'bg-go/20 text-go' : 'bg-risk-high/20 text-risk-high') : 'text-muted'}`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>
      {canPost ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, CALL_MAX))}
            placeholder={`Add a thesis to your trade: why $${t.symbol}?`}
            rows={3}
            aria-label="Your call"
            className="mt-2 w-full resize-none rounded-xl border border-white/[0.06] bg-bg px-3 py-2 text-sm outline-none placeholder:text-muted/70 focus:border-white/20"
          />
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
            <span>Visible to everyone</span>
            <span className="font-mono">
              {text.length}/{CALL_MAX}
            </span>
            <button
              type="button"
              onClick={() => void post()}
              disabled={busy || !text.trim() || !live}
              title={live ? undefined : 'Signing you in…'}
              className="ml-auto rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-bg hover:bg-white disabled:opacity-40"
            >
              {busy ? 'Posting…' : 'Post call'}
            </button>
          </div>
        </>
      ) : loading ? (
        <div className="mt-2 h-[86px] animate-pulse rounded-xl bg-white/[0.03]" aria-busy aria-label="Loading" />
      ) : session.authenticated && me?.status === 'unavailable' ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-dashed border-white/[0.08] px-3 py-3 text-sm text-muted">
          <span>Couldn’t check your Rushr profile.</span>
          <button type="button" onClick={() => void getMe().then(setMe)} className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/10">
            Retry
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-dashed border-white/[0.08] px-3 py-3 text-sm text-muted">
          <span>Sign up to post your call.</span>
          {session.authenticated ? (
            <Link href="/me" className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/10">
              Sign up
            </Link>
          ) : (
            <button type="button" onClick={() => auth.login()} className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/10">
              Sign up
            </button>
          )}
        </div>
      )}
      {msg && <p className={`mt-1.5 text-xs ${msg.ok ? 'text-go' : 'text-risk-high'}`}>{msg.text}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ about */

const LABEL: Record<WindowId, string> = { m5: '5M', h1: '1H', h6: '6H', h24: '1D' };

/**
 * About the token: description, price change per window, and for the chosen window who is buying
 * versus selling (trades, volume, wallets). "View more" opens the full stats, pools, contract and
 * safety notes (passed in by the page).
 */
export function AboutCard({
  t,
  windows,
  trades,
  nowMs,
  more,
}: {
  t: TokenDetail;
  windows: Record<WindowId, WindowStats> | null;
  trades: Tx[] | null;
  nowMs: number;
  more: React.ReactNode;
}) {
  const [w, setW] = useState<WindowId>('h24');
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const cur = windows?.[w] ?? null;
  const secs = WINDOWS.find((x) => x.id === w)!.secs;
  // Distinct buyers and sellers in the window, from the live trade list when it reaches back far enough.
  const wallets = useMemo(() => {
    if (!trades?.length) return null;
    const since = Math.floor(nowMs / 1000) - secs;
    // A full page that doesn't reach the window start means older trades are missing.
    if (trades[trades.length - 1]!.time > since && trades.length >= TRADE_LIMIT) return null;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    for (const x of trades) {
      if (x.time < since) break;
      (x.side === 'buy' ? buyers : sellers).add(x.trader.toLowerCase());
    }
    return { buyers: buyers.size, sellers: sellers.size };
  }, [trades, secs, nowMs]);
  const links: { href: string; label: string; Icon: typeof Globe }[] = [];
  if (t.website) links.push({ href: t.website, label: 'Website', Icon: Globe });
  if (t.twitter) links.push({ href: t.twitter, label: 'Twitter', Icon: XLogo });
  if (t.telegram) links.push({ href: t.telegram, label: 'Telegram', Icon: TelegramLogo });
  links.push({ href: `https://x.com/search?q=${encodeURIComponent(`$${t.symbol} OR ${t.address}`)}&f=live`, label: 'Search on X', Icon: MagnifyingGlass });

  return (
    <section className="shrink-0 rounded-2xl border border-white/[0.06] bg-surface p-4" aria-label={`About ${t.symbol}`}>
      <h2 className="text-sm font-semibold">About {t.symbol}</h2>
      {t.description ? (
        <p className={`mt-1.5 whitespace-pre-line text-sm text-ink/80 ${full ? '' : 'line-clamp-3'}`}>
          {t.description}
          {!full && t.description.length > 140 && (
            <button type="button" onClick={() => setFull(true)} className="ml-1 text-muted underline">
              more
            </button>
          )}
        </p>
      ) : (
        <p className="mt-1.5 text-sm text-muted">{t.name} has no description yet.</p>
      )}

      <div className="mt-3 grid grid-cols-4 gap-1 rounded-xl bg-white/[0.03] p-1">
        {WINDOWS.map((x) => {
          const ch = windows?.[x.id].change ?? null;
          return (
            <button key={x.id} type="button" onClick={() => setW(x.id)} className={`rounded-lg py-1.5 text-center ${w === x.id ? 'bg-white/[0.08]' : 'hover:bg-white/[0.03]'}`}>
              <span className="block text-[11px] text-muted">{LABEL[x.id]}</span>
              <span className={`block font-mono text-xs font-semibold ${ch == null || Math.abs(ch) < 0.05 ? 'text-muted' : ch > 0 ? 'text-go' : 'text-risk-high'}`}>{ch == null ? '—' : Math.abs(ch) < 0.05 ? '0.0%' : pctSigned(ch, 1)}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 space-y-2.5">
        <Split leftLabel="Buys" rightLabel="Sells" left={cur?.buys ?? null} right={cur?.sells ?? null} fmt={countFmt} />
        <Split leftLabel="Buy vol" rightLabel="Sell vol" left={cur?.buyUsd ?? null} right={cur?.sellUsd ?? null} fmt={(n) => usd(n)} />
        <Split leftLabel="Buyers" rightLabel="Sellers" left={wallets?.buyers ?? null} right={wallets?.sellers ?? null} fmt={countFmt} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {links.map(({ href, label, Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] px-2.5 py-1 text-xs text-ink/80 hover:border-white/20 hover:text-ink"
          >
            <Icon size={13} /> {label}
          </a>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-3 flex w-full items-center justify-center gap-1 rounded-xl py-2 text-xs text-muted hover:bg-white/[0.03] hover:text-ink"
      >
        {open ? 'View less' : 'View more'} <CaretDown size={12} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-2 space-y-2">{more}</div>}
    </section>
  );
}

function Split({ leftLabel, rightLabel, left, right, fmt }: { leftLabel: string; rightLabel: string; left: number | null; right: number | null; fmt: (n: number) => string }) {
  const known = left != null && right != null;
  const total = known ? left + right : 0;
  const share = known && total > 0 ? (left / total) * 100 : 50;
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted">
          {leftLabel} <span className="font-mono text-go">{left == null ? '—' : fmt(left)}</span>
        </span>
        <span className="text-muted">
          <span className="font-mono text-risk-high">{right == null ? '—' : fmt(right)}</span> {rightLabel}
        </span>
      </div>
      <div className="mt-1 flex h-1.5 gap-0.5 overflow-hidden rounded-full" title={known ? undefined : 'Not enough recent trades to tell'}>
        <span className={`h-full rounded-full ${known ? 'bg-go' : 'bg-white/[0.08]'}`} style={{ width: `${share}%` }} />
        <span className={`h-full flex-1 rounded-full ${known ? 'bg-risk-high' : 'bg-white/[0.08]'}`} />
      </div>
    </div>
  );
}

