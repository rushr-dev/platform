'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Star } from '@phosphor-icons/react';
import { API_URL, type TokenCard } from '@/lib/api';
import { pctSigned, usd } from '@/lib/format';
import { toggleWatch, useWatchlist } from '@/lib/watchlist';
import { TokenAvatar } from './bits';

const REFRESH_MS = 30_000;

type Tick = { t: TokenCard; change24h: number | null };

/** Reads each watched token's card and 24h stats, refreshing every 30 s; keeps the last values on errors. */
function useTicks(addresses: string[]): Map<string, Tick> {
  const [ticks, setTicks] = useState(new Map<string, Tick>());
  const key = addresses.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const list = key.split(',');
    const load = async () => {
      const rows = await Promise.all(
        list.map(async (a) => {
          try {
            const [t, s] = await Promise.all([
              fetch(`${API_URL}/tokens/${a}`).then((r) => (r.ok ? (r.json() as Promise<TokenCard>) : null)),
              fetch(`${API_URL}/tokens/${a}/stats`)
                .then((r) => (r.ok ? (r.json() as Promise<{ '24h'?: { priceChangePct?: number | null } }>) : null))
                .catch(() => null),
            ]);
            return t ? ([a, { t, change24h: s?.['24h']?.priceChangePct ?? null }] as const) : null;
          } catch {
            return null;
          }
        }),
      );
      if (!live) return;
      setTicks((prev) => {
        const next = new Map(prev);
        for (const r of rows) if (r) next.set(r[0], r[1]);
        return next;
      });
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [key]);
  return ticks;
}

/**
 * The watchlist as a ticker bar under the top bar (like a trading terminal's): each starred token with its
 * market cap and 24h change, linking to its page. Hidden until something is starred.
 */
export function WatchBar() {
  const list = useWatchlist();
  const ticks = useTicks(list);
  const path = usePathname();
  if (!list.length) return null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] bg-bg/90 px-3 text-xs [scrollbar-width:none]">
      <Star size={13} weight="fill" className="mr-1 shrink-0 text-risk-medium" aria-label="Watchlist" />
      {list.map((a) => {
        const tick = ticks.get(a);
        const on = path === `/token/${a}`;
        const ch = tick?.change24h;
        return (
          <Link
            key={a}
            href={`/token/${a}`}
            className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 transition hover:bg-white/[0.05] ${on ? 'bg-white/[0.06]' : ''}`}
          >
            <TokenAvatar t={tick?.t ?? { address: a, symbol: '?', launchpad: null }} size={16} />
            <span className="font-medium text-ink">{tick?.t.symbol ?? '…'}</span>
            <span className="font-mono text-muted">{usd(tick?.t.market_cap_usd)}</span>
            {ch != null && Number.isFinite(ch) && <span className={`font-mono ${ch >= 0 ? 'text-brand' : 'text-risk-high'}`}>{pctSigned(ch, 2)}</span>}
          </Link>
        );
      })}
    </div>
  );
}

/** Star toggle for a token's page header. */
export function WatchStar({ address, size = 16 }: { address: string; size?: number }) {
  const on = useWatchlist().includes(address.toLowerCase());
  return (
    <button
      type="button"
      onClick={() => toggleWatch(address)}
      aria-pressed={on}
      title={on ? 'Remove from watchlist' : 'Add to watchlist'}
      className={`rounded-md p-1 transition hover:bg-white/[0.06] ${on ? 'text-risk-medium' : 'text-muted hover:text-ink'}`}
    >
      <Star size={size} weight={on ? 'fill' : 'regular'} />
    </button>
  );
}
