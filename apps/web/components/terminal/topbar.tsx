'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { MagnifyingGlass, Wallet } from '@phosphor-icons/react';
import { API_URL, type TokenCard } from '@/lib/api';
import { usd } from '@/lib/format';
import { useLiveStatus } from '@/lib/live';
import { TokenAvatar, RiskDot } from './bits';

const NAV = [
  { href: '/trenches', label: 'Trenches' },
  { href: '#', label: 'Feed', soon: true },
  { href: '#', label: 'Agents', soon: true },
  { href: '#', label: 'Leaderboard', soon: true },
];

export function TopBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-6 border-b border-white/[0.06] bg-bg/90 px-4 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2">
        <Image src="/logo-mark.png" alt="" width={22} height={22} priority />
        <span className="text-lg font-semibold tracking-[-0.04em]">rushr</span>
      </Link>
      <nav className="hidden items-center gap-1 text-sm md:flex">
        {NAV.map((n) => (
          <Link
            key={n.label}
            href={n.href}
            aria-disabled={n.soon}
            className={`rounded-lg px-3 py-1.5 transition ${
              path.startsWith(n.href) && !n.soon ? 'bg-white/[0.07] text-ink' : 'text-muted hover:text-ink'
            } ${n.soon ? 'pointer-events-none' : ''}`}
          >
            {n.label}
            {n.soon && <span className="ml-1.5 text-[10px] text-muted/60">soon</span>}
          </Link>
        ))}
      </nav>
      <Search />
      <div className="ml-auto flex items-center gap-2">
        <LivePill />
        <button
          type="button"
          disabled
          title="Trading opens soon"
          className="flex items-center gap-2 rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-bg opacity-90"
        >
          <Wallet size={16} weight="bold" />
          <span className="hidden sm:inline">Connect</span>
        </button>
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
      className="hidden items-center gap-2 rounded-xl border border-white/[0.06] bg-surface px-3 py-2 font-mono text-xs sm:flex"
      title="Time from the block being produced to this update reaching your browser (block timestamps are whole seconds, so this reads up to 1s high)"
    >
      <span className={`size-2 rounded-full ${connected ? 'bg-brand shadow-[0_0_8px] shadow-brand' : 'bg-risk-high'}`} />
      {connected ? (s == null ? 'live' : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`) : 'reconnecting'}
    </div>
  );
}

function Search() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TokenCard[]>([]);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // "/" focuses search, like most terminals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
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
    <div className="relative hidden w-full max-w-md lg:block">
      <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
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
        placeholder="Search token, contract or ticker"
        className="w-full rounded-xl border border-white/[0.06] bg-surface py-2 pl-9 pr-10 text-sm outline-none placeholder:text-muted focus:border-white/15"
      />
      <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-white/10 px-1.5 font-mono text-[10px] text-muted">/</kbd>
      {open && q.trim().length >= 2 && results.length > 0 && (
        <ul className="absolute inset-x-0 top-full mt-2 max-h-96 overflow-auto rounded-xl border border-white/10 bg-surface-2 p-1 shadow-2xl">
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
