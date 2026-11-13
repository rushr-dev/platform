'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Lightning, MagnifyingGlass } from '@phosphor-icons/react';
import { API_URL, type TokenCard } from '@/lib/api';
import { usd } from '@/lib/format';
import { useLiveStatus } from '@/lib/live';
import { updateSettings, useSettings } from '@/lib/settings';
import { TokenAvatar, RiskDot } from './bits';
import { AccountMenu } from './auth/account-menu';

const NAV = [
  { href: '/trenches', label: 'Trenches' },
  { href: '#', label: 'Feed', soon: true },
  { href: '#', label: 'Agents', soon: true },
  { href: '#', label: 'Leaderboard', soon: true },
];

export function TopBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 grid h-14 grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-white/[0.05] bg-bg/80 px-4 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2">
        <Image src="/logo-mark.png" alt="" width={22} height={22} priority />
        <span className="text-lg font-semibold tracking-[-0.04em]">rushr</span>
      </Link>
      <nav className="hidden items-center justify-center gap-1 text-sm md:flex">
        {NAV.map((n) => (
          <Link
            key={n.label}
            href={n.href}
            aria-disabled={n.soon}
            className={`rounded-full px-3.5 py-1.5 transition ${
              path.startsWith(n.href) && !n.soon ? 'bg-white/[0.07] text-ink' : 'text-muted hover:text-ink'
            } ${n.soon ? 'pointer-events-none' : ''}`}
          >
            {n.label}
            {n.soon && <span className="ml-1.5 text-[10px] text-muted/60">soon</span>}
          </Link>
        ))}
      </nav>
      <div className="col-start-3 flex items-center justify-end gap-2">
        <Search />
        <QuickBuyPill />
        <LivePill />
        <AccountMenu />
      </div>
    </header>
  );
}

/** Live connection and how far behind the chain the last update arrived. */
function LivePill() {
  const { connected, latencyMs } = useLiveStatus();
  const s = latencyMs == null ? null : Math.max(0, latencyMs) / 1000;
  return (
    <div
      className="hidden items-center gap-2 rounded-full border border-white/[0.07] px-3 py-1.5 font-mono text-xs text-muted sm:flex"
      title={
        connected
          ? s == null
            ? 'Live: updates stream as blocks are produced.'
            : `Live. Last update arrived ${s < 10 ? s.toFixed(1) : Math.round(s)}s after its block (block timestamps are whole seconds, so this reads up to 1s high).`
          : 'Reconnecting to the live feed…'
      }
    >
      <span className={`size-2 rounded-full ${connected ? 'bg-brand shadow-[0_0_8px] shadow-brand' : 'bg-risk-high'}`} />
      {connected ? 'live' : 'reconnecting'}
    </div>
  );
}

function Search() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TokenCard[]>([]);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Ctrl K (Cmd K on a Mac) or "/" focuses search.
  const [hint, setHint] = useState('Ctrl K');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setHint('⌘K');
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '');
      if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${API_URL}/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => r.json() as Promise<{ tokens: TokenCard[] }>)
        .then((d) => setResults(d.tokens ?? []))
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const go = (address: string) => {
    setOpen(false);
    setQ('');
    router.push(`/token/${address}`);
  };

  return (
    <div className="relative hidden w-56 lg:block xl:w-64">
      <MagnifyingGlass size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = q.trim();
            if (/^0x[0-9a-fA-F]{40}$/.test(v)) go(v.toLowerCase());
            else if (results[0]) go(results[0].address);
          }
        }}
        placeholder="Search"
        aria-label="Search token, contract or ticker"
        className="w-full rounded-full border border-white/[0.07] bg-white/[0.02] py-1.5 pl-9 pr-14 text-sm outline-none placeholder:text-muted focus:border-white/20"
      />
      <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-white/10 px-1.5 font-mono text-[10px] text-muted">{hint}</kbd>
      {open && q.trim().length >= 2 && results.length > 0 && (
        <ul className="absolute right-0 top-full mt-2 max-h-96 w-80 overflow-auto rounded-2xl border border-white/10 bg-surface-2 p-1 shadow-2xl">
          {results.map((t) => (
            <li key={t.address}>
              <button
                type="button"
                onMouseDown={() => go(t.address)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/[0.05]"
              >
                <TokenAvatar t={t} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {t.symbol} <RiskDot risk={t.risk} />
                  </span>
                  <span className="block truncate text-xs text-muted">{t.name}</span>
                </span>
                <span className="font-mono text-xs">{usd(t.market_cap_usd)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The one-tap buy amount used by the Buy pills across the terminal (saved with trading settings). */
function QuickBuyPill() {
  const { quickBuy } = useSettings();
  // Local text so partial input ("0.") can be typed; valid amounts are saved as they're entered.
  const [text, setText] = useState(quickBuy);
  useEffect(() => setText(quickBuy), [quickBuy]);
  return (
    <label className="hidden items-center gap-1.5 rounded-full border border-white/[0.07] py-1.5 pl-3 pr-3 text-xs xl:flex" title="Quick buy amount for every Buy button">
      <Lightning size={13} weight="fill" className="text-brand" />
      <span className="text-muted">Quick buy</span>
      <input
        value={text}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '').slice(0, 8);
          setText(v);
          if (/^\d*\.?\d+$/.test(v) && Number(v) > 0) updateSettings({ quickBuy: v });
        }}
        onBlur={() => setText(quickBuy)}
        inputMode="decimal"
        aria-label="Quick buy amount in ETH"
        className="w-10 bg-transparent text-right font-mono text-ink outline-none"
      />
      <span className="font-mono text-muted">ETH</span>
    </label>
  );
}
