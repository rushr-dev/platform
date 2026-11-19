'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { API_URL, type TokenCard } from '@/lib/api';
import { usd } from '@/lib/format';
import { TokenAvatar } from './bits';

/** The platform's own token, pinned in the top bar so anyone can find and buy it from any page. */
export const RUSHR_TOKEN = '0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed';
const REFRESH_MS = 60_000;

/**
 * A ticker-style chip for $RUSHR: logo, symbol and live market cap, linking to its token page (where the trade
 * panel is). Renders with the symbol alone until the first read, and keeps the last value if a refresh fails.
 */
export function RushrPill() {
  const [t, setT] = useState<TokenCard | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`${API_URL}/tokens/${RUSHR_TOKEN}`)
        .then((r) => (r.ok ? (r.json() as Promise<TokenCard>) : null))
        .then((d) => live && d && setT(d))
        .catch(() => undefined);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  return (
    <Link
      href={`/token/${RUSHR_TOKEN}`}
      title="$RUSHR, the Rushr token: hold it for lower trading fees"
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-brand/30 bg-brand/[0.08] py-1 pl-1 pr-3 text-xs transition hover:border-brand/60 hover:bg-brand/[0.14]"
    >
      <TokenAvatar t={t ?? { address: RUSHR_TOKEN, symbol: 'RUSHR', launchpad: 'pons' }} size={20} />
      <span className="font-semibold text-ink">$RUSHR</span>
      {t?.market_cap_usd != null && <span className="hidden font-mono text-muted sm:inline">{usd(t.market_cap_usd)}</span>}
    </Link>
  );
}
