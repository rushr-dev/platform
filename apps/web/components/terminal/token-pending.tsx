'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { API_URL, type TokenDetail } from '@/lib/api';
import { feed } from '@/lib/feed/client';
import { useFeedStatus } from '@/lib/feed/react';
import { EXPLORER, short } from '@/lib/format';
import { TokenAvatar } from './bits';
import { HydratingPill, isHydrating } from './chart';
import { TokenView } from './token-view';
import type { Hydration } from '@/lib/feed/protocol';

/** How long an address may keep answering 404 before we say it isn't tracked. */
const GIVE_UP_MS = 20_000;
/** While the API answers 202 (it is fetching the token from chain) we keep waiting this long. */
const FETCHING_MAX_MS = 3 * 60_000;
const POLL_MS = 4_000;

/** What everything is priced in: the server never hydrates these (it answers not_token). */
const QUOTE_ASSETS: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
};

/**
 * A token page built from a v2 snapshot card while the HTTP API doesn't know the token yet: the
 * fields only the full detail has get neutral defaults (created_at '' = unknown) until the indexed
 * snapshot replaces them.
 */
function detailFromCard(address: string, card: Partial<TokenDetail>): TokenDetail {
  return {
    symbol: '…', name: '', launchpad: null, status: 'new', created_at: '', market_cap_usd: null, volume_24h_usd: null,
    holders: 0, bonding_progress: null, risk: null, verdict: null, top10_pct: null, dev_pct: null, bundled_pct: null, snipers_pct: null,
    insiders_pct: null, fresh_pct: null, airdropped: null, copycat: null, serial_launcher: null, deployer: '', total_supply: '0', decimals: 18,
    created_block: '0', launch_indexed: false, description: null, signals: null, dev: null, trades_24h: 0,
    ...card,
    address,
  };
}

/**
 * Shell for an address the index doesn't know yet. On the v2 feed the server fetches it from chain
 * and streams it in: as soon as a snapshot carries a card we hand over to the full token page
 * (built from that card), which keeps hydrating live. On v1 we poll the HTTP API: 202 means the
 * server is fetching it (keep waiting), 200 re-renders the full page, and repeated 404s mean it
 * isn't tracked.
 */
export function TokenPending({
  address,
  serverNow,
  fetching = null,
}: {
  address: string;
  serverNow: number;
  /** The API's 202 state when the page was rendered ('hydrating' | 'busy'), or null after a 404. */
  fetching?: string | null;
}) {
  const router = useRouter();
  const status = useFeedStatus();
  const [hydration, setHydration] = useState<Hydration | null>(fetching === 'busy' ? { state: 'busy', source: 'chain' } : null);
  const [card, setCard] = useState<Partial<TokenDetail> | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [notToken, setNotToken] = useState(false);
  const busy = hydration?.state === 'busy';

  // v2: the first snapshot with a card hands over to the token page.
  useEffect(() => {
    if (card) return;
    const topic = `token:${address}`;
    const release = feed.retain<Partial<TokenDetail> | null>({
      topic,
      kind: 'token-pending',
      initial: null,
      initialIsSnapshot: true,
      apply: (s) => s,
      fromSnapshot: (data) => (data as { card?: Partial<TokenDetail> } | null)?.card ?? null,
    });
    const stop = feed.watch(topic, () => {
      const v = feed.view<Partial<TokenDetail> | null>(topic, 'token-pending');
      const h = v?.hydration;
      if (h?.state === 'not_token') setNotToken(true);
      else if (isHydrating(h) || h?.state === 'busy') setHydration(h!);
      if (v?.data?.symbol) setCard(v.data);
    });
    const stopErr = feed.onError(topic, (code) => (code === 'not_a_token' || code === 'not_token' ? setNotToken(true) : undefined));
    return () => {
      stop();
      stopErr();
      release(); // the token page takes the topic over
    };
  }, [address, card]);

  const detail = useMemo(() => (card ? detailFromCard(address, card) : null), [address, card]);
  const empty = useMemo(() => Promise.resolve([]), []);

  // v1 (and while the socket is down): poll the HTTP API.
  useEffect(() => {
    if (status.protocol === 2 || card || notToken) return;
    const started = Date.now();
    let serverFetching = fetching != null;
    const ctl = new AbortController();
    const id = setInterval(() => {
      const waited = Date.now() - started;
      if (waited > (serverFetching ? FETCHING_MAX_MS : GIVE_UP_MS)) {
        setGaveUp(true);
        clearInterval(id);
        return;
      }
      fetch(`${API_URL}/tokens/${address}`, { signal: ctl.signal })
        .then(async (r) => {
          if (r.status === 200) return router.refresh(); // indexed: render the full page
          if (r.status === 202) {
            serverFetching = true;
            const body = (await r.json().catch(() => ({}))) as { state?: string };
            setHydration(body.state === 'busy' ? { state: 'busy', source: 'chain' } : { state: 'hydrating', source: 'chain' });
            return;
          }
          await r.body?.cancel();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(id);
      ctl.abort();
    };
  }, [address, router, status.protocol, card, notToken, fetching]);

  // After every hook: the shell hands over to the full page once a card arrives.
  if (detail) return <TokenView detail={detail} tradesP={empty} candlesP={empty} serverNow={serverNow} />;
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.06] bg-surface p-6 text-center">
        <div className="mx-auto w-fit">
          <TokenAvatar t={{ address, symbol: '?', launchpad: null }} size={56} />
        </div>
        <p className="mt-3 font-mono text-sm">{short(address, 6, 6)}</p>
        {notToken && QUOTE_ASSETS[address] ? (
          <>
            <h1 className="mt-4 text-lg font-semibold">{QUOTE_ASSETS[address]} is a quote asset</h1>
            <p className="mt-1 text-sm text-muted">Rushr prices tokens in {QUOTE_ASSETS[address]}, so it doesn&apos;t get a token page of its own.</p>
          </>
        ) : notToken ? (
          <>
            <h1 className="mt-4 text-lg font-semibold">This address isn&apos;t a token</h1>
            <p className="mt-1 text-sm text-muted">It isn&apos;t an ERC-20 on Robinhood Chain. Check the address, or open it in the explorer.</p>
          </>
        ) : gaveUp && !hydration ? (
          <>
            <h1 className="mt-4 text-lg font-semibold">Rushr isn&apos;t tracking this token yet</h1>
            <p className="mt-1 text-sm text-muted">
              It may not be a token on Robinhood Chain, or it launched somewhere we don&apos;t index yet.
            </p>
          </>
        ) : busy ? (
          <>
            <h1 className="mt-4 text-lg font-semibold">Rushr is busy fetching other tokens</h1>
            <p className="mt-1 text-sm text-muted">We&apos;ll try this one again in about a minute; keep the page open.</p>
          </>
        ) : (
          <>
            <h1 className="mt-4 text-lg font-semibold">Fetching this token from chain…</h1>
            <p className="mt-1 text-sm text-muted">The page fills in as soon as its first data arrives.</p>
            <div className="relative mt-4 h-8">
              <HydratingPill hydration={hydration ?? { state: 'hydrating', source: 'chain' }} className="!static mx-auto w-fit" />
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
