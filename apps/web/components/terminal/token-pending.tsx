'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { API_URL, type TokenDetail } from '@/lib/api';
import { feed } from '@/lib/feed/client';
import { useFeedStatus } from '@/lib/feed/react';
import { EXPLORER, short } from '@/lib/format';
import { TokenAvatar } from './bits';
import { HydratingPill } from './chart';

/** How long a v1 server gets to start indexing an address before we say it isn't tracked. */
const GIVE_UP_MS = 20_000;
const POLL_MS = 4_000;

/**
 * Shell for an address the index doesn't know yet. On the v2 feed the server fetches it from chain
 * and streams it in: we subscribe and swap to the full page as soon as a token snapshot arrives.
 * On v1 we poll the HTTP API for a short while, then say it isn't tracked.
 */
export function TokenPending({ address }: { address: string }) {
  const router = useRouter();
  const status = useFeedStatus();
  const [hydration, setHydration] = useState<{ source?: 'chain' | 'index' | 'mixed'; progress?: number | null } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  // v2: the snapshot (even a hydrating one) means the server knows the token now.
  useEffect(() => {
    const topic = `token:${address}`;
    const release = feed.retain<TokenDetail | null>({
      topic,
      kind: 'token-pending',
      initial: null,
      initialIsSnapshot: true,
      apply: (s) => s,
      fromSnapshot: (data) => ((data as { token?: TokenDetail })?.token ?? null),
    });
    let refreshed = false;
    const stop = feed.watch(topic, () => {
      const v = feed.view<TokenDetail | null>(topic, 'token-pending');
      if (v?.hydration.state === 'hydrating') setHydration({ source: v.hydration.source, progress: v.hydration.progress });
      // The server knows the token now: render the full page (once).
      if (v?.data?.symbol && !refreshed) {
        refreshed = true;
        router.refresh();
      }
    });
    return () => {
      stop();
      release();
    };
  }, [address, router]);

  // v1 (and while the socket is down): poll the HTTP API.
  useEffect(() => {
    if (status.protocol === 2) return;
    const started = Date.now();
    const ctl = new AbortController();
    const id = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        setGaveUp(true);
        clearInterval(id);
        return;
      }
      fetch(`${API_URL}/tokens/${address}`, { signal: ctl.signal })
        .then(async (r) => {
          if (r.ok) router.refresh();
          else await r.body?.cancel();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(id);
      ctl.abort();
    };
  }, [address, router, status.protocol]);

  return (
    <div className="grid h-full place-items-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.06] bg-surface p-6 text-center">
        <div className="mx-auto w-fit">
          <TokenAvatar t={{ address, symbol: '?', launchpad: null }} size={56} />
        </div>
        <p className="mt-3 font-mono text-sm">{short(address, 6, 6)}</p>
        {gaveUp && !hydration ? (
          <>
            <h1 className="mt-4 text-lg font-semibold">Rushr isn&apos;t tracking this token yet</h1>
            <p className="mt-1 text-sm text-muted">
              It may not be a token on Robinhood Chain, or it launched somewhere we don&apos;t index yet.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-4 text-lg font-semibold">Fetching this token from chain…</h1>
            <p className="mt-1 text-sm text-muted">The page fills in as soon as its first data arrives.</p>
            <div className="relative mt-4 h-8">
              <HydratingPill hydration={{ state: 'hydrating', source: hydration?.source ?? 'chain', progress: hydration?.progress ?? null }} className="!static mx-auto w-fit" />
            </div>
          </>
        )}
        <a
          href={`${EXPLORER}/token/${address}`}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
        >
          View on explorer <ArrowSquareOut size={12} />
        </a>
      </div>
    </div>
  );
}
