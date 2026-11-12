'use client';

import { API_URL, type Candle, type TokenCard, type TokenDetail, type Trade } from '../api';
import { fromApi, fromLive, mergeTrades, TRADE_LIMIT, type LiveTrade, type Tx } from '../trades';
import type { TopicSpec } from './client';
import type { Delta } from './protocol';

/**
 * How each feed topic is built. These are the only places that know payload shapes, so moving to
 * the v2 protocol means adjusting `fromSnapshot` and the delta kinds here, not the components.
 */

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { signal });
  if (!r.ok) {
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
  /**
   * 1m candles when the feed carries them (v2: in the snapshot, then `candles` deltas as history
   * streams in for a hydrating token). Null on v1, where the page reads candles over HTTP.
   */
  candles: Candle[] | null;
}

/** v2 snapshot payload proposed for `token:<a>` (docs/team-plan.md, Requests). */
interface TokenSnapshotV2 {
  token: TokenDetail;
  trades?: (Trade | LiveTrade)[];
  candles?: Candle[];
}

/** Upsert candles by bucket time (history backfill and the live bucket both land here). */
function upsertCandles(prev: Candle[] | null, next: Candle[]): Candle[] {
  const by = new Map((prev ?? []).map((c) => [c.time, c]));
  for (const c of next) if (c && Number.isFinite(c.time)) by.set(c.time, c);
  return [...by.values()].sort((a, b) => a.time - b.time);
}

const toTx = (t: Trade | LiveTrade, decimals: number): Tx =>
  'log_index' in t ? fromApi(t as Trade, decimals) : fromLive(t as LiveTrade, decimals);

export function tokenSpec(detail: TokenDetail, ssrTrades: Promise<Tx[]>): Omit<TopicSpec<TokenState>, 'topic'> {
  const decimals = detail.decimals;
  return {
    kind: 'token',
    initial: { token: detail, trades: null, fetched: 0, candles: null },
    apply(state, deltas: Delta[]) {
      let { token, trades, candles } = state;
      for (const d of deltas) {
        if (d.kind === 'token' && d.data) token = { ...token, ...(d.data as Partial<TokenDetail>) };
        if (d.kind === 'trades' && Array.isArray(d.data)) {
          const fresh = (d.data as (LiveTrade | Trade)[]).map((x) => toTx(x, decimals));
          trades = mergeTrades(fresh, trades ?? []);
        }
        if (d.kind === 'candles' && d.data) candles = upsertCandles(candles, (Array.isArray(d.data) ? d.data : [d.data]) as Candle[]);
      }
      return token === state.token && trades === state.trades && candles === state.candles ? state : { ...state, token, trades, candles };
    },
    fromSnapshot(data, prev) {
      const s = data as TokenSnapshotV2;
      const list = (s.trades ?? []).map((x) => toTx(x, decimals));
      return {
        token: { ...prev.token, ...s.token },
        trades: mergeTrades(list, []),
        fetched: list.length,
        candles: s.candles ? upsertCandles(null, s.candles) : prev.candles,
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
      return (prev) => ({ ...prev, token: { ...prev.token, ...token }, trades: mergeTrades(list, prev.trades ?? []), fetched: list.length });
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
