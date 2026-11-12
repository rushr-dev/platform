'use client';

import { API_URL, type Candle, type TokenCard, type TokenDetail, type Trade } from '../api';
import { fromApi, fromLive, mergeTrades, TRADE_LIMIT, type LiveTrade, type Tx } from '../trades';
import type { ApiPool } from '../pools';
import type { TopicSpec } from './client';
import type { Delta } from './protocol';

/**
 * How each feed topic is built. These are the only places that know payload shapes, so moving to
 * the v2 protocol means adjusting `fromSnapshot` and the delta kinds here, not the components.
 */

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { signal });
  // 202: the API is still fetching this token from chain; there is no snapshot to read yet.
  if (!r.ok || r.status === 202) {
    await r.body?.cancel();
    throw new Error(`${path}: ${r.status}`);
  }
  return (await r.json()) as T;
}

/* ------------------------------------------------------------------ token:<address> */

export interface TokenState {
  token: TokenDetail;
  /** Newest first, live trades included. Null until the first trade list arrives. */
  trades: Tx[] | null;
  /** How many trades the last full list held (the tail of `trades` is that history). */
  fetched: number;
  /** 1m candles from the feed (v2 snapshot + candle ticks). Null on v1, where the page reads them over HTTP. */
  candles: Candle[] | null;
  /** 1s candles for the last ~30 min (v2). */
  candles1s: Candle[] | null;
  /** Server-side rolling windows (v2 `stats`). Null on v1, where the page derives them. */
  stats: ServerStats | null;
  /** Pools from the snapshot (v2), same shape as GET /tokens/:a/pools. */
  pools: ApiPool[] | null;
}

export interface ServerWindow {
  priceChangePct: number | null;
  volumeUsd: number;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  makers: number;
}
export type ServerStats = Partial<Record<'5m' | '1h' | '6h' | '24h', ServerWindow>> & { asOf?: number };

/** `token:<a>` snapshot data (docs/realtime.md on the data branch). */
interface TokenSnapshotV2 {
  state?: string;
  /** Full GET /tokens/:a detail; null or minimal while hydrating. */
  card?: Partial<TokenDetail> | null;
  /** Null while hydrating (the page derives windows from trades then). */
  stats?: ServerStats | null;
  pools?: ApiPool[];
  trades?: (Trade | LiveTrade)[];
  candles?: { '1s'?: Candle[]; '1m'?: Candle[] };
}

type CandleTick = Candle & { interval?: '1s' | '1m' };

const sortCandles = (list: Candle[]) => [...list].filter((c) => c && Number.isFinite(c.time)).sort((a, b) => a.time - b.time);

/**
 * Merge candle increments into their buckets (spec: a new bucket is inserted as is; otherwise
 * high = max, low = min, close = tick.close, volume and trades add up, open stays).
 */
export function mergeTicks(prev: Candle[] | null, ticks: CandleTick[]): Candle[] {
  const by = new Map((prev ?? []).map((c) => [c.time, c]));
  for (const t of ticks) {
    if (!t || !Number.isFinite(t.time)) continue;
    const c = by.get(t.time);
    by.set(
      t.time,
      c
        ? { ...c, high: Math.max(c.high, t.high), low: Math.min(c.low, t.low), close: t.close, volume: c.volume + (t.volume ?? 0), trades: (c.trades ?? 0) + (t.trades ?? 0) }
        : { time: t.time, open: t.open, high: t.high, low: t.low, close: t.close, volume: t.volume ?? 0, trades: t.trades ?? 0 },
    );
  }
  return [...by.values()].sort((a, b) => a.time - b.time);
}

const toTx = (t: Trade | LiveTrade, decimals: number): Tx =>
  'log_index' in t ? fromApi(t as Trade, decimals) : fromLive(t as LiveTrade, decimals);

export function tokenSpec(detail: TokenDetail, ssrTrades: Promise<Tx[]>): Omit<TopicSpec<TokenState>, 'topic'> {
  const decimals = detail.decimals;
  return {
    kind: 'token',
    initial: { token: detail, trades: null, fetched: 0, candles: null, candles1s: null, stats: null, pools: null },
    apply(state, deltas: Delta[]) {
      let { token, trades, candles, candles1s, stats, pools } = state;
      for (const d of deltas) {
        if (!d.data) continue;
        switch (d.kind) {
          case 'token': // v2 sends the full card; keep the detail-only fields from the page
            token = { ...token, ...(d.data as Partial<TokenDetail>) };
            break;
          case 'trades':
            if (Array.isArray(d.data)) trades = mergeTrades((d.data as (LiveTrade | Trade)[]).map((x) => toTx(x, decimals)), trades ?? []);
            break;
          case 'candle': {
            const ticks = (Array.isArray(d.data) ? d.data : [d.data]) as CandleTick[];
            const m1 = ticks.filter((t) => (t.interval ?? '1m') === '1m');
            const s1 = ticks.filter((t) => t.interval === '1s');
            // On v1 the page reads 1m candles over HTTP; only start keeping them once a snapshot has.
            if (m1.length && candles) candles = mergeTicks(candles, m1);
            if (s1.length) candles1s = mergeTicks(candles1s, s1).slice(-1800);
            break;
          }
          case 'stats':
            stats = d.data as ServerStats;
            break;
          case 'pools':
            if (Array.isArray(d.data)) pools = d.data as ApiPool[];
            break;
        }
      }
      return token === state.token && trades === state.trades && candles === state.candles && candles1s === state.candles1s && stats === state.stats && pools === state.pools
        ? state
        : { ...state, token, trades, candles, candles1s, stats, pools };
    },
    fromSnapshot(data, prev) {
      const s = data as TokenSnapshotV2;
      const list = (s.trades ?? []).map((x) => toTx(x, decimals));
      return {
        // Snapshots replace the topic; the card merges over the page's detail (deployer, signals, dev…).
        token: { ...prev.token, ...(s.card ?? {}) },
        trades: mergeTrades(list, []),
        fetched: list.length,
        candles: s.candles?.['1m'] ? sortCandles(s.candles['1m']) : prev.candles,
        candles1s: s.candles?.['1s'] ? sortCandles(s.candles['1s']) : prev.candles1s,
        // A snapshot replaces the topic: null stats (hydrating) means "derive them here".
        stats: s.stats ?? null,
        // Hydrating snapshots send no pools yet; keep HTTP/DexScreener until they do.
        pools: s.pools?.length ? s.pools : prev.pools,
      };
    },
    async fetchSnapshot(signal, attempt) {
      // First time: the trade list the server started fetching while rendering the page.
      if (attempt === 0) {
        // A failed server read shows "no trades" rather than a skeleton forever.
        const list = await Promise.resolve(ssrTrades).catch(() => [] as Tx[]);
        return (prev) => ({ ...prev, trades: prev.trades ? mergeTrades(prev.trades, list) : list, fetched: list.length });
      }
      const [token, body] = await Promise.all([
        getJson<TokenDetail>(`/tokens/${detail.address}`, signal),
        getJson<{ trades: Trade[] }>(`/tokens/${detail.address}/trades?limit=${TRADE_LIMIT}`, signal),
      ]);
      const list = body.trades.map((t) => fromApi(t, decimals));
      // 202 while the server fetches it from chain: no card yet, keep what we have.
      const card = token && 'symbol' in token ? token : null;
      return (prev) => ({ ...prev, token: card ? { ...prev.token, ...card } : prev.token, trades: mergeTrades(list, prev.trades ?? []), fetched: list.length });
    },
  };
}

/* ------------------------------------------------------------------ trenches */

export type TrenchesState = Map<string, TokenCard>;

/** Rows per column fetched over HTTP after the server-rendered first screen. */
const BACKFILL = 80;
/** Memory bound: past this many tokens, keep the newest. */
const MAX_TOKENS = 1500;
const KEEP_TOKENS = 1000;

const created = (t: TokenCard) => (t.created_at ? new Date(t.created_at).getTime() : 0);

function cap(m: TrenchesState): TrenchesState {
  if (m.size <= MAX_TOKENS) return m;
  return new Map([...m.values()].sort((a, b) => created(b) - created(a)).slice(0, KEEP_TOKENS).map((t) => [t.address, t]));
}

/**
 * Today one `trenches` topic carries every card update and launch. With v2 this becomes one topic
 * per column (`trenches:new|almost|migrated`) using the same reducer.
 */
export function trenchesSpec(initial: TokenCard[]): Omit<TopicSpec<TrenchesState>, 'topic'> {
  return {
    kind: 'trenches',
    initial: new Map(initial.map((t) => [t.address, t])),
    apply(state, deltas) {
      let next: TrenchesState | null = null;
      for (const d of deltas) {
        if (d.kind === 'remove') {
          const a = (d.data as { address?: string } | null)?.address;
          if (a && (next ?? state).has(a)) (next ??= new Map(state)).delete(a);
          continue;
        }
        if (d.kind !== 'token' && d.kind !== 'launch') continue;
        const cards = (Array.isArray(d.data) ? d.data : [d.data]) as TokenCard[];
        for (const t of cards) {
          if (!t?.address) continue;
          next ??= new Map(state);
          next.set(t.address, { ...next.get(t.address), ...t });
        }
      }
      return next ? cap(next) : state;
    },
    fromSnapshot(data) {
      const cards = (Array.isArray(data) ? data : ((data as { tokens?: TokenCard[] })?.tokens ?? [])) as TokenCard[];
      return new Map(cards.filter(Boolean).map((t) => [t.address, t]));
    },
    async fetchSnapshot(signal) {
      const paths = [
        ...(['new', 'almost', 'migrated'] as const).map((c) => `/tokens?column=${c}&limit=${BACKFILL}`),
        `/tokens?column=new&limit=60&plain=1`,
      ];
      const lists = await Promise.all(
        paths.map((p) =>
          getJson<{ tokens: (TokenCard | null)[] }>(p, signal)
            .then((d) => d.tokens.filter((t): t is TokenCard => t != null))
            .catch((e: Error) => {
              if (e.name === 'AbortError') throw e;
              return [] as TokenCard[];
            }),
        ),
      );
      // Merge: the snapshot is newer than what we had; deltas held meanwhile are replayed on top.
      return (prev) => cap(new Map([...prev, ...lists.flat().map((t) => [t.address, t] as const)]));
    },
  };
}

/* ------------------------------------------------------------------ trenches:<column> (v2) */

export type TrenchesColumn = 'new' | 'almost' | 'migrated';

/**
 * One trenches column on v2. The server owns membership: `launch`/`token` upsert a card, and
 * `move {address, from, to, card}` arrives on both columns (remove from `from`, insert into `to`).
 * No HTTP snapshot: on v1 the page uses the single `trenches` topic instead.
 */
export function trenchesColumnSpec(column: TrenchesColumn, initial: TokenCard[]): Omit<TopicSpec<TrenchesState>, 'topic'> {
  return {
    kind: 'trenches-column',
    initial: new Map(initial.map((t) => [t.address, t])),
    initialIsSnapshot: true,
    apply(state, deltas) {
      let next: TrenchesState | null = null;
      const edit = () => (next ??= new Map(state));
      for (const d of deltas) {
        if (d.kind === 'move') {
          const mv = d.data as { address?: string; from?: string; to?: string; card?: TokenCard } | null;
          if (!mv?.address) continue;
          if (mv.from === column && mv.to !== column) edit().delete(mv.address);
          if (mv.to === column && mv.card) edit().set(mv.address, mv.card);
          continue;
        }
        if (d.kind !== 'token' && d.kind !== 'launch') continue;
        const cards = (Array.isArray(d.data) ? d.data : [d.data]) as TokenCard[];
        for (const t of cards) if (t?.address) edit().set(t.address, t); // full card: replace
      }
      return next ?? state;
    },
    fromSnapshot(data) {
      const cards = ((data as { tokens?: (TokenCard | null)[] })?.tokens ?? []).filter((t): t is TokenCard => !!t);
      return new Map(cards.map((t) => [t.address, t]));
    },
  };
}
