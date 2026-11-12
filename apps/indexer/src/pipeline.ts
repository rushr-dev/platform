import type { Sql, TransactionSql } from 'postgres';
import type { Address, Hex } from 'viem';
import {
  LAUNCHPADS,
  NATIVE_ETH,
  PAIR_FACTORIES,
  QUOTES,
  TOPICS,
  STOCK_QUOTES,
  acceptsPrice,
  applyTrade,
  emptyPosition,
  decodeLogs,
  launchpadForHook,
  subscribedTopics,
  type DecodeResult,
  type DecodedSwap,
  type DecodedTransfer,
  type RawLog,
  type PoolInfo,
} from '@rushr/core';
import { HistoryTooLarge, type Rpc } from './rpc';

const ETH_LIKE = new Set<string>([NATIVE_ETH, QUOTES.WETH]);
const ZERO = NATIVE_ETH;
const QUOTE_SET = new Set<string>([NATIVE_ETH, QUOTES.WETH, QUOTES.USDG, ...Object.values(STOCK_QUOTES)]);
/** Only start tracking tokens discovered mid-life if they were created within this window. */
const DISCOVER_MAX_AGE_S = 7 * 24 * 3600;
/** A token whose first transfer is this much older than its first pool predates that pool. */
const ORIGIN_GAP_S = 10 * 60;
/** Cap on the Transfer history fetched when a live token is discovered mid-life. */
const HISTORY_BUDGET = { maxLogs: 20_000, maxMs: 10_000 };
/** First ~66s after launch (0.11s blocks): enough for bundle (first blocks) and sniper (first 5s) signals. */
const LAUNCH_WINDOW_BLOCKS = 600n;
const LAUNCHER_TO_PAD = new Map<string, PoolInfo['launchpad']>([
  ...LAUNCHPADS.filter((l) => l.launcher).map((l) => [l.launcher!, l.id] as const),
  ['0x1eef016f22a943abc7dd11422edee9d235942104', 'doppler'], // Doppler Airlock proxy
]);

/** A pool's two sides and how it trades, from PositionManager (v4) or token0()/token1()/factory() (v3/v2). */
interface PoolKey {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  dex: 'uniswap-v4' | 'v3' | 'v2';
  venue: string | null;
  fee: number | null;
  tickSpacing: number | null;
}
const CACHE_LIMIT = 50_000;
/** Discovery limits per decoded range, so a burst of unknown pools can't stall a poll step. */
const MAX_NEW_TOKENS_PER_RANGE = 6;
const MAX_ORIGIN_LOOKUPS = 40;

interface TokenMeta {
  decimals: number;
  totalSupply: bigint;
}

export interface BatchStats {
  logs: number;
  launches: number;
  /** Newly written rows (already-seen rows from the other path are not counted). */
  swaps: number;
  transfers: number;
  newTokens: string[];
  touched: string[];
  /** Newly written trades, for the live feed. */
  trades: LiveTrade[];
}

export interface LiveTrade {
  token: string;
  tx: string;
  logIndex: number;
  time: number;
  trader: string;
  side: 'buy' | 'sell';
  pool: string;
  quote: string;
  tokenAmount: string;
  quoteAmount: string;
  priceUsd: number | null;
  usd: number | null;
}

export interface RangeStats extends BatchStats {
  from: bigint;
  to: bigint;
  ms: number;
}

/**
 * Turns block ranges into rows. Keeps pools/tokens in memory (loaded once from Postgres) so
 * decoding needs no extra queries. Each range is written in one transaction together with the
 * cursor, so a failed range is retried without double-counting balances or candles.
 */
export interface PipelineOptions {
  /**
   * Backfill mode: replaying old blocks. Doesn't overwrite the live ETH/USD price, and token prices
   * only move forward in time (an old swap never replaces a newer price).
   */
  historical?: boolean;
  /** Track tokens of any age when discovered (full-history backfill). Live keeps the 7-day cutoff. */
  anyAge?: boolean;
  /**
   * Use Transfer logs only to resolve traders, never write them (pool-history backfill: balances
   * stay owned by the live path and the holder backfill, so nothing is counted twice).
   */
  skipTransfers?: boolean;
  /** Cap the Transfer history fetched for discovered tokens even in historical mode. */
  boundedHistory?: boolean;
  /** Don't fetch discovered tokens' Transfer history at all (hydration: the holder backfill does it exactly). */
  noHistory?: boolean;
  /** Only discover pools of this token (hydration: other tokens met along the way are left to the poller). */
  onlyToken?: string;
}

/** Quote tokens other than ETH/USDG (stock tokens, coins used as a pair's quote), priced from their own pools. */
interface ExtraQuote {
  decimals: number;
  usd: number | null;
  pricedAt: number;
}
const QUOTE_REFRESH_MS = 60_000;

export class Pipeline {
  private quotes = new Map<string, ExtraQuote>();
  private pools = new Map<string, PoolInfo>();
  private tokens = new Map<string, TokenMeta>();
  /** Last accepted price per token: the reference for the outlier guard. */
  private refPrice = new Map<string, number>();
  private ethUsd: number | null = null;
  private loaded = false;
  /**
   * Pools we looked up and decided not to track, with the token they were rejected for (null when
   * they can never be tracked: no pool key, both sides quotes, ...). A pool rejected because its token
   * wasn't tracked (e.g. too old to discover) is looked at again once that token is tracked.
   */
  private ignoredPools = new Map<string, string | null>();
  private ignoredTokens = new Set<string>();
  /** Resolved keys of pools we looked up (so re-checking an ignored pool needs no RPC). */
  private poolKeyCache = new Map<string, PoolKey | null>();
  /** Pools added by discovery since the last call to takeDiscoveredPools (their recent history gets backfilled). */
  private discoveredPools: string[] = [];

  constructor(
    private sql: Sql,
    private rpc: Rpc,
    private opts: PipelineOptions = {},
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const pools = await this.sql<
      { id: string; token: string; quote: string; token_is_currency0: boolean; dex: string; venue: string | null; fee: number | null; tick_spacing: number | null; launchpad: string | null; hooks: string | null; created_block: string; created_at: Date }[]
    >`select id, token, quote, token_is_currency0, dex, venue, fee, tick_spacing, launchpad, hooks, created_block, created_at from pools`;
    for (const p of pools) {
      this.pools.set(p.id, {
        id: p.id, token: p.token as Address, quote: p.quote as Address, tokenIsCurrency0: p.token_is_currency0,
        dex: p.dex as PoolInfo['dex'], venue: p.venue, fee: p.fee, tickSpacing: p.tick_spacing, launchpad: p.launchpad as PoolInfo['launchpad'], hooks: p.hooks as Address | null,
        block: BigInt(p.created_block), time: Math.floor(p.created_at.getTime() / 1000),
      });
    }
    const toks = await this.sql<{ address: string; decimals: number; total_supply: string; price_usd: string | null }[]>`
      select address, decimals, total_supply, price_usd from tokens`;
    for (const t of toks) {
      this.tokens.set(t.address, { decimals: t.decimals, totalSupply: BigInt(t.total_supply) });
      if (t.price_usd) this.refPrice.set(t.address, Number(t.price_usd));
    }
    const [eth] = await this.sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`;
    this.ethUsd = eth?.value.usd ?? null;
    const extra = [...new Set(pools.map((p) => p.quote).filter((q) => !ETH_LIKE.has(q) && q !== QUOTES.USDG))];
    if (extra.length) {
      const meta = await this.rpc.tokenMetadata(extra as Address[]);
      meta.forEach((m) => this.quotes.set(m.token, { decimals: m.decimals, usd: null, pricedAt: 0 }));
    }
    this.loaded = true;
  }

  /**
   * For plain v4 "launches" (pool init for a token we don't know): the token's first transfer, when it is
   * clearly older than the pool. Launchpad launches create the token in the same tx, so they're skipped.
   */
  private async realOrigins(launches: { token: Address; launchpad: PoolInfo['launchpad']; block: bigint; time: number }[]) {
    const out = new Map<Address, { block: bigint; time: number; tx: Hex }>();
    const plain = launches.filter((l) => !l.launchpad || l.launchpad === 'uniswap-v4');
    for (let i = 0; i < plain.length; i += 4) {
      await Promise.all(
        plain.slice(i, i + 4).map(async (l) => {
          const origin = await this.rpc.tokenOrigin(l.token).catch(() => null);
          if (origin && origin.time && l.time - origin.time > ORIGIN_GAP_S) {
            out.set(l.token, { block: origin.block, time: origin.time, tx: origin.tx });
          }
        }),
      );
    }
    return out;
  }

  /** Tokens with no trades recorded in their first minute (discovered mid-life): backfill their launch window. */
  async backfillMissingLaunches(): Promise<string[]> {
    await this.load();
    const rows = await this.sql<{ address: string; created_block: string }[]>`
      select t.address, t.created_block from tokens t
      where not exists (select 1 from swaps s where s.token = t.address and s.time <= t.created_at + interval '60 seconds')`;
    for (const r of rows) await this.backfillLaunchWindow(r.address as Address, BigInt(r.created_block));
    return rows.map((r) => r.address);
  }

  async cursor(): Promise<bigint | null> {
    const [row] = await this.sql<{ value: { block: string } }[]>`select value from indexer_state where key = 'cursor'`;
    return row ? BigInt(row.value.block) : null;
  }

  /** Polling path: fetch a confirmed block range and advance the cursor. */
  async run(from: bigint, to: bigint): Promise<RangeStats> {
    const started = Date.now();
    const logs = await this.rpc.logs(from, to, subscribedTopics());
    const stats = await this.process(logs, to);
    return { ...stats, from, to, ms: Date.now() - started };
  }

  /** Live path: logs pushed over WebSocket. Doesn't move the cursor; polling confirms later. */
  async ingest(logs: RawLog[]) {
    return this.process(logs.filter((l) => !(l as { removed?: boolean }).removed), null);
  }

  /**
   * Shared write path. Swaps/transfers are keyed by (tx, logIndex) and balances/candles are only
   * applied for rows that were newly inserted, so the live and polling paths can overlap safely.
   */
  private async process(logs: RawLog[], cursorTo: bigint | null) {
    const started = Date.now();
    const T: Record<string, number> = {};
    let t0 = started;
    const lap = (k: string) => { T[k] = Date.now() - t0; t0 = Date.now(); };
    await this.load();
    lap('load');
    // PONS launch events don't say whether the curve is priced in ETH or USDG: ask the curves first.
    const launchedCurves = logs
      .filter((l) => l.topics[0] === TOPICS.ponsLaunch && l.topics[2])
      .map((l) => `0x${l.topics[2]!.slice(26)}`.toLowerCase())
      .filter((c) => !this.pools.has(c));
    const curveQuotes = launchedCurves.length ? await this.rpc.curveQuotes(launchedCurves) : new Map<string, Address>();
    // Curves priced in something other than ETH/USDG (stock tokens, other coins): register those quotes.
    const unseen = [...new Set(curveQuotes.values())].filter((q) => !ETH_LIKE.has(q) && q !== QUOTES.USDG && !this.quotes.has(q));
    if (unseen.length) {
      const meta = await this.rpc.tokenMetadata(unseen);
      meta.forEach((m) => this.quotes.set(m.token, { decimals: m.decimals, usd: null, pricedAt: 0 }));
      await this.refreshQuotePrices(true);
    }
    const ctx = {
      getPool: (id: string) => this.pools.get(id),
      isTracked: (t: string) => this.tokens.has(t),
      curveQuote: (c: string) => curveQuotes.get(c),
      focusToken: this.opts.onlyToken as Address | undefined,
    };
    lap('curves');
    let r = decodeLogs(logs, ctx);
    if (r.unknownPools.length || r.unknownPairs.length) {
      const firstBlock = logs.reduce((m, l) => (BigInt(l.blockNumber) < m ? BigInt(l.blockNumber) : m), BigInt(logs[0]!.blockNumber));
      const v2 = new Set(logs.filter((l) => l.topics[0] === TOPICS.v2Swap).map((l) => l.address.toLowerCase()));
      const t = Date.now();
      if (await this.discover(r.unknownPools, r.unknownPairs, (a) => (v2.has(a) ? 'v2' : 'v3'), firstBlock)) r = decodeLogs(logs, ctx);
      if (Date.now() - t > 3_000) console.warn(`discover took ${Date.now() - t}ms (${r.unknownPools.length} v4 ids, ${r.unknownPairs.length} pairs unresolved after)`, JSON.stringify(this.discoverTimes));
    }

    lap('decode+discover');
    this.updateEthUsd(r);
    await this.refreshQuotePrices();
    lap('quotes');
    // A tracked token showing up in a pool with the PONS v2 hook has graduated from its curve.
    for (const p of r.pools) {
      if (p.hooks && launchpadForHook(p.hooks) === 'pons' && (this.tokens.has(p.token) || r.launches.some((l) => l.token === p.token))) {
        if (!r.migrations.some((m) => m.token === p.token)) r.migrations.push({ token: p.token, pool: p.id, block: p.block, time: p.time });
      }
    }

    // Enrich new tokens before writing: metadata + who launched them.
    const fresh = r.launches.filter((l) => !this.tokens.has(l.token));
    const meta = await this.rpc.tokenMetadata(fresh.map((l) => l.token));
    // A plain v4 pool for an unknown token isn't always a launch: old tokens get new pools too. Use the
    // token's first transfer as its real birth, or it looks newer than its own clones (copycat check).
    const origins = await this.realOrigins(fresh);
    const needCreator = fresh.filter((l) => !l.creator).map((l) => origins.get(l.token)?.tx ?? l.tx);
    const launchers = await this.rpc.launchers([...new Set(needCreator)]);
    lap('enrich');

    const newSwaps = new Set<string>();
    const newTransfers = new Set<string>();
    // Each swap is priced once (the outlier guard is stateful).
    const pricedBy = new Map<string, { priceUsd: string | null; usd: string | null }>();
    await this.sql.begin(async (tx) => {
      if (fresh.length) {
        const rows = fresh.map((l, i) => ({
          address: l.token,
          name: meta[i]!.name.slice(0, 200),
          symbol: meta[i]!.symbol.slice(0, 64),
          decimals: meta[i]!.decimals,
          total_supply: meta[i]!.totalSupply.toString(),
          deployer: l.creator ?? launchers.get(origins.get(l.token)?.tx ?? l.tx) ?? ZERO,
          launchpad: l.launchpad,
          created_block: (origins.get(l.token)?.block ?? l.block).toString(),
          created_at: new Date((origins.get(l.token)?.time ?? l.time) * 1000),
          quote: l.quote,
          main_pool: l.pool,
          launch_indexed: !origins.has(l.token),
        }));
        await tx`insert into tokens ${tx(rows)} on conflict (address) do nothing`;
      }
      if (r.pools.length) {
        const rows = r.pools.map((p) => ({
          id: p.id, token: p.token, quote: p.quote, token_is_currency0: p.tokenIsCurrency0, dex: p.dex, venue: p.venue ?? null, fee: p.fee ?? null, tick_spacing: p.tickSpacing ?? null,
          launchpad: p.launchpad, hooks: p.hooks, created_block: p.block.toString(), created_at: new Date(p.time * 1000),
        }));
        // A pool first seen mid-life (live discovery) may be replayed later from its real creation:
        // keep the earliest block, so backfills cover its whole history.
        await tx`insert into pools ${tx(rows)} on conflict (id) do update set
                   created_block = least(pools.created_block, excluded.created_block),
                   fee = coalesce(pools.fee, excluded.fee), tick_spacing = coalesce(pools.tick_spacing, excluded.tick_spacing),
                   created_at = least(pools.created_at, excluded.created_at),
                   quote = case when pools.dex = 'pons-curve' then excluded.quote else pools.quote end`;
      }
      // Register in memory now so swaps in this range price correctly.
      fresh.forEach((l, i) => this.tokens.set(l.token, { decimals: meta[i]!.decimals, totalSupply: meta[i]!.totalSupply }));
      // A market cap from the launch itself (pool sqrtPrice or the creator's buy), so a new card isn't
      // blank until its first trade. Real trades override it (price_at moves forward).
      for (const [i, l] of fresh.entries()) {
        if (!l.initialPrice) continue;
        const q = this.quoteUsd(l.quote);
        if (!q) continue;
        const perToken = (Number(l.initialPrice.quoteRaw) / Number(l.initialPrice.tokenRaw)) * 10 ** (meta[i]!.decimals - q.decimals) * q.usd;
        if (!(perToken > 0) || !Number.isFinite(perToken)) continue;
        const mcap = perToken * (Number(meta[i]!.totalSupply) / 10 ** meta[i]!.decimals);
        await tx`update tokens set price_usd = ${perToken}, market_cap_usd = ${mcap}, price_at = ${new Date(l.time * 1000)}
                 where address = ${l.token} and price_usd is null`;
      }
      for (const p of r.pools) this.pools.set(p.id, p);

      lap('tx:tokens+pools');
      const priced = r.swaps.map((s) => ({ s, ...this.price(s) }));
      for (const p of priced) pricedBy.set(`${p.s.tx}:${p.s.logIndex}`, { priceUsd: p.priceUsd, usd: p.usd });
      for (const k of await this.insertSwaps(tx, priced)) newSwaps.add(k);
      lap('tx:swaps');
      if (r.transfers.length && !this.opts.skipTransfers) {
        for (const k of await this.insertTransfers(tx, r.transfers)) newTransfers.add(k);
      }
      lap('tx:transfers');
      const touched = [...new Set([...r.swaps.map((s) => s.token), ...r.transfers.map((t) => t.token)])];
      await this.refreshTokenStats(tx, touched, priced);
      lap(`tx:stats(${touched.length})`);
      for (const m of r.migrations) {
        await tx`update tokens set status = 'migrated', bonding_progress = 1,
                 migrated_at = least(coalesce(migrated_at, ${new Date(m.time * 1000)}), ${new Date(m.time * 1000)}),
                 main_pool = coalesce(${m.pool}, main_pool) where address = ${m.token}`;
      }
      if (this.ethUsd && !this.opts.historical) {
        await tx`insert into indexer_state (key, value) values ('eth_usd', ${tx.json({ usd: this.ethUsd })})
                 on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
      if (cursorTo !== null && !this.opts.historical) {
        await tx`insert into indexer_state (key, value) values ('cursor', ${tx.json({ block: cursorTo.toString() })})
                 on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
    });
    lap('commit');
    if (Date.now() - started > 10_000) console.warn(`slow batch: ${logs.length} logs in ${Date.now() - started}ms`, JSON.stringify(T));

    return {
      logs: logs.length,
      launches: fresh.length,
      swaps: newSwaps.size,
      transfers: newTransfers.size,
      newTokens: fresh.map((l) => l.token),
      touched: [...new Set(r.swaps.map((s) => s.token))],
      trades: r.swaps
        .filter((s) => newSwaps.has(`${s.tx}:${s.logIndex}`))
        .map((s) => {
          const p = pricedBy.get(`${s.tx}:${s.logIndex}`) ?? { priceUsd: null, usd: null };
          return {
            token: s.token, tx: s.tx, logIndex: s.logIndex, time: s.time, trader: s.trader, side: s.side, pool: s.pool, quote: s.quote,
            tokenAmount: s.tokenAmount.toString(), quoteAmount: s.quoteAmount.toString(),
            priceUsd: p.priceUsd ? Number(p.priceUsd) : null, usd: p.usd ? Number(p.usd) : null,
          };
        }),
    };
  }

  /** Insert swaps and update candles for the ones not seen before. Returns their keys. */
  private async insertSwaps(
    tx: TransactionSql,
    priced: { s: DecodedSwap; priceUsd: string | null; usd: string | null }[],
  ): Promise<Set<string>> {
    const inserted = new Set<string>();
    const rows = priced.map(({ s, priceUsd, usd }) => ({
      tx: s.tx, log_index: s.logIndex, token: s.token, pool: s.pool, block: s.block.toString(), time: new Date(s.time * 1000),
      trader: s.trader, side: s.side, token_amount: s.tokenAmount.toString(), quote: s.quote,
      quote_amount: s.quoteAmount.toString(), price_usd: priceUsd, usd,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      const res = await tx<{ tx: string; log_index: number }[]>`
        insert into swaps ${tx(rows.slice(i, i + 1000))} on conflict do nothing returning tx, log_index`;
      for (const row of res) inserted.add(`${row.tx}:${row.log_index}`);
    }
    const fresh = priced.filter(({ s }) => inserted.has(`${s.tx}:${s.logIndex}`));
    await this.applyCandles(tx, fresh);
    await this.applyPositions(tx, fresh);
    return inserted;
  }

  /**
   * For a token discovered mid-life, index the first minute after its launch (curve or pool
   * trades) so bundle and sniper signals can be measured. Marks the token either way.
   */
  async backfillLaunchWindow(token: Address, createdBlock: bigint): Promise<void> {
    let ok = false;
    try {
      const logs = await this.rpc.logs(createdBlock, createdBlock + LAUNCH_WINDOW_BLOCKS, subscribedTopics());
      const r = decodeLogs(logs, { getPool: (id) => this.pools.get(id), isTracked: (t) => t === token });
      const pools = r.pools.filter((p) => p.token === token);
      const priced = r.swaps.filter((s) => s.token === token).map((s) => ({ s, ...this.price(s) }));
      await this.sql.begin(async (tx) => {
        if (pools.length) {
          const rows = pools.map((p) => ({
            id: p.id, token: p.token, quote: p.quote, token_is_currency0: p.tokenIsCurrency0, dex: p.dex, venue: p.venue ?? null, fee: p.fee ?? null, tick_spacing: p.tickSpacing ?? null,
            launchpad: p.launchpad, hooks: p.hooks, created_block: p.block.toString(), created_at: new Date(p.time * 1000),
          }));
          await tx`insert into pools ${tx(rows)} on conflict (id) do nothing`;
        }
        await this.insertSwaps(tx, priced);
      });
      for (const p of pools) this.pools.set(p.id, p);
      ok = true;
    } catch (err) {
      console.error('launch window backfill failed', token, err);
    }
    await this.sql`update tokens set launch_indexed = ${ok} where address = ${token}`;
  }

  /** Insert transfers and apply balance deltas for the ones not seen before. Returns their keys. */
  private async insertTransfers(tx: TransactionSql, transfers: DecodedTransfer[]): Promise<Set<string>> {
    const inserted = new Set<string>();
    const rows = transfers.map((t) => ({
      tx: t.tx, log_index: t.logIndex, token: t.token, block: t.block.toString(), time: new Date(t.time * 1000),
      from: t.from, to: t.to, amount: t.amount.toString(),
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      const res = await tx<{ tx: string; log_index: number }[]>`
        insert into transfers ${tx(rows.slice(i, i + 1000))} on conflict do nothing returning tx, log_index`;
      for (const row of res) inserted.add(`${row.tx}:${row.log_index}`);
    }
    await this.applyBalances(tx, transfers.filter((t) => inserted.has(`${t.tx}:${t.logIndex}`)));
    return inserted;
  }

  /**
   * Start treating a token as tracked (written elsewhere, e.g. by a hydrator): load its row and pools,
   * and forget any earlier decision to ignore them (the 7-day rule would otherwise drop an old token).
   */
  async adoptToken(token: string): Promise<boolean> {
    await this.load();
    const [t] = await this.sql<{ decimals: number; total_supply: string }[]>`select decimals, total_supply from tokens where address = ${token}`;
    if (!t) return false;
    this.tokens.set(token, { decimals: t.decimals, totalSupply: BigInt(t.total_supply) });
    this.ignoredTokens.delete(token);
    const pools = await this.sql<
      { id: string; token: string; quote: string; token_is_currency0: boolean; dex: string; venue: string | null; fee: number | null; tick_spacing: number | null; launchpad: string | null; hooks: string | null; created_block: string; created_at: Date }[]
    >`select id, token, quote, token_is_currency0, dex, venue, fee, tick_spacing, launchpad, hooks, created_block, created_at from pools where token = ${token}`;
    for (const p of pools) {
      this.ignoredPools.delete(p.id);
      this.pools.set(p.id, {
        id: p.id, token: p.token as Address, quote: p.quote as Address, tokenIsCurrency0: p.token_is_currency0, dex: p.dex as PoolInfo['dex'],
        venue: p.venue, fee: p.fee, tickSpacing: p.tick_spacing, launchpad: p.launchpad as PoolInfo['launchpad'], hooks: p.hooks as Address | null,
        block: BigInt(p.created_block), time: Math.floor(p.created_at.getTime() / 1000),
      });
    }
    return true;
  }

  /** Pools discovery added since the last call (the poller hands them to the pool-history backfill). */
  takeDiscoveredPools(): string[] {
    const out = this.discoveredPools;
    this.discoveredPools = [];
    return out;
  }

  /** Whether an unknown pool is worth looking at (again). */
  private shouldCheck(id: string): boolean {
    if (!this.ignoredPools.has(id)) return true;
    const token = this.ignoredPools.get(id);
    return token != null && this.tokens.has(token);
  }

  private ignorePool(id: string, token: string | null) {
    if (this.ignoredPools.size > CACHE_LIMIT) this.ignoredPools.clear();
    this.ignoredPools.set(id, token);
  }

  /** Pool keys for v4 ids and v3/v2 pair addresses, from the cache or one batched lookup each. */
  private async poolKeysFor(v4: string[], pairs: string[], pairKind: (a: string) => 'v3' | 'v2') {
    const missV4 = v4.filter((id) => !this.poolKeyCache.has(id));
    const missPairs = pairs.filter((id) => !this.poolKeyCache.has(id));
    if (this.poolKeyCache.size > CACHE_LIMIT) this.poolKeyCache.clear();
    if (missV4.length) {
      for (const { id, key } of await this.rpc.poolKeys(missV4)) {
        this.poolKeyCache.set(id, key ? { ...key, dex: 'uniswap-v4', venue: null } : null);
      }
      // Hook pools (Doppler, ...) never pass through PositionManager: read their Initialize event instead.
      const missing = missV4.filter((id) => !this.poolKeyCache.get(id));
      if (missing.length) {
        for (const [id, k] of await this.rpc.v4Initialized(missing)) this.poolKeyCache.set(id, { ...k, dex: 'uniswap-v4', venue: null });
      }
    }
    if (missPairs.length) {
      for (const { id, key } of await this.rpc.pairKeys(missPairs)) {
        const f = key?.factory ? PAIR_FACTORIES[key.factory] : undefined;
        this.poolKeyCache.set(
          id,
          key
            ? {
                currency0: key.currency0, currency1: key.currency1, hooks: ZERO, dex: f?.kind ?? pairKind(id), venue: f?.venue ?? 'other',
                fee: key.fee, tickSpacing: key.tickSpacing,
              }
            : null,
        );
      }
    }
    return [...v4, ...pairs].map((id) => ({ id, key: this.poolKeyCache.get(id) ?? null }));
  }

  /**
   * Swaps hit pools we never saw created: v4 pools initialized before we started, or v3/v2 pairs
   * (any fork; we don't watch their factories). Look the pools up; track the ones of tokens we
   * track, and start tracking young tokens with their full transfer history (so holders are right).
   * Returns true if anything new is tracked.
   */
  private discoverTimes: Record<string, number> = {};
  private async discover(v4Ids: string[], pairAddrs: string[], pairKind: (a: string) => 'v3' | 'v2', beforeBlock: bigint): Promise<boolean> {
    const T = this.discoverTimes = {} as Record<string, number>;
    let t0 = Date.now();
    const lap = (k: string) => { T[k] = (T[k] ?? 0) + Date.now() - t0; t0 = Date.now(); };
    const keys = await this.poolKeysFor(v4Ids.filter((id) => this.shouldCheck(id)), pairAddrs.filter((id) => this.shouldCheck(id)), pairKind);
    lap('keys');
    if (!keys.length) return false;
    const now = Math.floor(Date.now() / 1000);
    const newPools: PoolInfo[] = [];
    const newTokens: { token: Address; origin: NonNullable<Awaited<ReturnType<Rpc['tokenOrigin']>>>; pad: PoolInfo['launchpad']; migrated: boolean; pool: string }[] = [];
    // Candidate tokens first, so their origins can be fetched in parallel.
    const candidates: { id: string; key: PoolKey; token: Address; quote: Address }[] = [];
    for (const { id, key } of keys) {
      if (!key) { this.ignorePool(id, null); continue; }
      // A coin used as the quote of other pools (e.g. PONS/XYZ) is still the token when paired with ETH/USDG.
      // The hydrated token is the traded side against ETH/WETH/USDG even if it's a stock token.
      const focus = (a: string, other: string) => a === this.opts.onlyToken && (ETH_LIKE.has(other) || other === QUOTES.USDG);
      const isQuote = (a: string, other: string) => !focus(a, other) && (QUOTE_SET.has(a) || (this.quotes.has(a) && !QUOTE_SET.has(other)));
      let q0 = isQuote(key.currency0, key.currency1);
      let q1 = isQuote(key.currency1, key.currency0);
      if (q0 && q1) { this.ignorePool(id, null); continue; }
      if (!q0 && !q1) {
        // Paired with another coin (a stock token, or a memecoin used as quote): work out which side is the quote.
        const quote = await this.resolveQuote(key.currency0, key.currency1);
        lap('resolveQuote');
        if (!quote) { this.ignorePool(id, null); continue; }
        q0 = quote === key.currency0;
        q1 = !q0;
      }
      const token = (q0 ? key.currency1 : key.currency0) as Address;
      if (!this.tokens.has(token) && this.ignoredTokens.has(token)) { this.ignorePool(id, token); continue; }
      if (this.opts.onlyToken && token !== this.opts.onlyToken) continue;
      candidates.push({ id, key, token, quote: (q0 ? key.currency0 : key.currency1) as Address });
    }
    const unknown = [...new Set(candidates.map((c) => c.token).filter((t) => !this.tokens.has(t)))].slice(0, MAX_ORIGIN_LOOKUPS);
    lap('candidates');
    const origins = new Map<string, Awaited<ReturnType<Rpc['tokenOrigin']>>>();
    for (let i = 0; i < unknown.length; i += 4) {
      await Promise.all(unknown.slice(i, i + 4).map(async (t) => origins.set(t, await this.rpc.tokenOrigin(t))));
    }
    lap(`origins(${unknown.length})`);
    for (const { id, key, token, quote } of candidates) {
      let pad = key.dex === 'uniswap-v4' ? launchpadForHook(key.hooks) : null;
      if (!this.tokens.has(token) && !newTokens.some((n) => n.token === token)) {
        // Each new token costs a history fetch and a launch-window replay: take a few per range and
        // leave the rest for the next one (not ignored; the pool-history backfill fills in their swaps).
        if (newTokens.length >= MAX_NEW_TOKENS_PER_RANGE || !origins.has(token)) continue;
        const origin = origins.get(token);
        if (!origin || (!this.opts.anyAge && now - origin.time > DISCOVER_MAX_AGE_S)) {
          if (this.ignoredTokens.size > CACHE_LIMIT) this.ignoredTokens.clear();
          this.ignoredTokens.add(token);
          this.ignorePool(id, token);
          continue;
        }
        const originPad = LAUNCHER_TO_PAD.get(origin.to) ?? null;
        pad = originPad ?? pad ?? 'uniswap-v4';
        // PONS tokens only trade on Uniswap after graduating from their curve: a PONS-hook pool means graduated.
        const graduated = originPad === 'pons' || (key.dex === 'uniswap-v4' && launchpadForHook(key.hooks) === 'pons');
        if (graduated) pad = 'pons';
        newTokens.push({ token, origin, pad, migrated: graduated, pool: id });
      }
      newPools.push({
        id, token, quote, tokenIsCurrency0: key.currency0 === token, dex: key.dex, venue: key.venue, fee: key.fee, tickSpacing: key.tickSpacing,
        launchpad: key.dex === 'uniswap-v4' ? (pad ?? 'uniswap-v4') : pad, hooks: key.hooks === NATIVE_ETH ? null : key.hooks,
        block: beforeBlock, time: now,
      });
      this.ignoredPools.delete(id);
    }
    if (!newPools.length) return false;

    lap('pools');
    const meta = await this.rpc.tokenMetadata(newTokens.map((n) => n.token));
    const creators = await this.rpc.launchers([...new Set(newTokens.map((n) => n.origin.tx))]);
    // Past history is a nice-to-have (holder counts). A token with a huge one (spam airdrops, busy old
    // tokens) is tracked from now on instead, so discovery never stalls the live indexer.
    const history = await Promise.all(
      newTokens.map((n, i) => this.opts.noHistory ? Promise.resolve([] as RawLog[]) :
        this.rpc.transferLogs(n.token, n.origin.block, beforeBlock - 1n, this.opts.historical && !this.opts.boundedHistory ? undefined : HISTORY_BUDGET).catch((err) => {
          if (this.opts.historical && !this.opts.boundedHistory && !(err instanceof HistoryTooLarge)) throw err;
          // Live: a slow or huge history (RPC timeout, too many logs) must not stall indexing. The
          // holder backfill (/admin/holders/backfill) can fill it in later.
          console.warn(`discover: skipped transfer history for ${meta[i]?.symbol ?? n.token} (${err instanceof HistoryTooLarge ? 'too large' : String(err).slice(0, 80)})`);
          return [];
        }),
      ),
    );

    lap(`history(${newTokens.length})`);
    await this.sql.begin(async (tx) => {
      if (newTokens.length) {
        const rows = newTokens.map((n, i) => ({
          address: n.token, name: meta[i]!.name.slice(0, 200), symbol: meta[i]!.symbol.slice(0, 64), decimals: meta[i]!.decimals,
          total_supply: meta[i]!.totalSupply.toString(), deployer: creators.get(n.origin.tx) ?? ZERO, launchpad: n.pad,
          created_block: n.origin.block.toString(), created_at: new Date(n.origin.time * 1000), quote: newPools.find((p) => p.token === n.token)!.quote,
          main_pool: n.pool, status: n.migrated ? 'migrated' : 'new',
        }));
        await tx`insert into tokens ${tx(rows)} on conflict (address) do nothing`;
      }
      const poolRows = newPools.map((p) => ({
        id: p.id, token: p.token, quote: p.quote, token_is_currency0: p.tokenIsCurrency0, dex: p.dex, venue: p.venue ?? null, fee: p.fee ?? null, tick_spacing: p.tickSpacing ?? null, launchpad: p.launchpad,
        hooks: p.hooks, created_block: p.block.toString(), created_at: new Date(p.time * 1000),
      }));
      await tx`insert into pools ${tx(poolRows)} on conflict (id) do nothing`;
      for (const logsOfToken of history) {
        const transfers: DecodedTransfer[] = logsOfToken
          .filter((l) => l.topics.length === 3)
          .map((l) => ({
            tx: l.transactionHash, logIndex: Number(l.logIndex), block: BigInt(l.blockNumber),
            time: l.blockTimestamp ? Number(l.blockTimestamp) : 0, token: l.address.toLowerCase() as Address,
            from: `0x${l.topics[1]!.slice(26)}` as Address, to: `0x${l.topics[2]!.slice(26)}` as Address, amount: BigInt(l.data),
          }));
        await this.insertTransfers(tx, transfers);
      }
    });
    newTokens.forEach((n, i) => this.tokens.set(n.token, { decimals: meta[i]!.decimals, totalSupply: meta[i]!.totalSupply }));
    for (const p of newPools) this.pools.set(p.id, p);
    this.discoveredPools.push(...newPools.map((p) => p.id));
    lap('write');
    for (let i = 0; i < newTokens.length; i += 3) {
      await Promise.all(newTokens.slice(i, i + 3).map((n) => this.backfillLaunchWindow(n.token, n.origin.block)));
    }
    lap('launchWindows');
    if (newTokens.length) console.log(`discovered ${newTokens.map((n, i) => `${meta[i]!.symbol} (${n.pad})`).join(', ')} with history`);
    const known = newPools.filter((p) => !newTokens.some((n) => n.token === p.token));
    if (known.length) console.log(`discovered ${known.length} pools of tracked tokens: ${known.map((p) => `${p.venue ?? p.dex} ${p.id.slice(0, 10)}`).join(', ')}`);
    return true;
  }

  /** Re-price extra quote tokens about once a minute (one batched quoter call). */
  private async refreshQuotePrices(force = false) {
    const now = Date.now();
    const due = [...this.quotes].filter(([, q]) => force || now - q.pricedAt > QUOTE_REFRESH_MS);
    if (!due.length) return;
    // Coins we track ourselves (e.g. a memecoin used as a pair's quote) use their own indexed price.
    const tracked = await this.sql<{ address: string; price_usd: string | null }[]>`
      select address, price_usd from tokens where address = any(${due.map(([a]) => a)}) and price_usd is not null`;
    const own = new Map(tracked.map((t) => [t.address, Number(t.price_usd)]));
    const rest = due.filter(([a]) => !own.has(a)).map(([a, q]) => ({ address: a as Address, decimals: q.decimals }));
    const quoted = rest.length ? await this.rpc.usdPrices(rest, this.ethUsd) : new Map<Address, number | null>();
    for (const [a, q] of due) {
      const usd = own.get(a) ?? quoted.get(a as Address) ?? null;
      this.quotes.set(a, { ...q, usd: usd ?? q.usd, pricedAt: now });
    }
  }

  /**
   * For a pool where neither side is ETH/USDG/a known quote, decide which side is the quote:
   * a coin we already track, or the side that has a USD price on Uniswap while the other doesn't.
   */
  private async resolveQuote(c0: Address, c1: Address): Promise<Address | null> {
    const t0 = this.tokens.has(c0);
    const t1 = this.tokens.has(c1);
    if (t0 !== t1) return t0 ? c0 : c1;
    if (t0 && t1) return null;
    const meta = await this.rpc.tokenMetadata([c0, c1]);
    const prices = await this.rpc.usdPrices(meta.map((m) => ({ address: m.token, decimals: m.decimals })), this.ethUsd);
    const p0 = prices.get(c0) ?? null;
    const p1 = prices.get(c1) ?? null;
    if ((p0 == null) === (p1 == null)) return null;
    const quote = p0 != null ? c0 : c1;
    const m = meta.find((x) => x.token === quote)!;
    this.quotes.set(quote, { decimals: m.decimals, usd: p0 ?? p1, pricedAt: Date.now() });
    return quote;
  }

  private updateEthUsd(r: DecodeResult) {
    const prices = r.ethUsd
      .map((o) => Number(o.usdgAmount) / 1e6 / (Number(o.ethAmount) / 1e18))
      .filter((p) => p > 100 && p < 100_000)
      .sort((a, b) => a - b);
    if (prices.length) this.ethUsd = prices[Math.floor(prices.length / 2)]!;
  }

  /** Decimals and USD value of a quote asset (ETH/WETH/USDG, or a priced extra quote). */
  private quoteUsd(quote: string): { decimals: number; usd: number } | null {
    if (quote === QUOTES.USDG) return { decimals: 6, usd: 1 };
    if (ETH_LIKE.has(quote)) return this.ethUsd ? { decimals: 18, usd: this.ethUsd } : null;
    const extra = this.quotes.get(quote);
    return extra?.usd ? { decimals: extra.decimals, usd: extra.usd } : null;
  }

  private price(s: DecodedSwap): { priceUsd: string | null; usd: string | null } {
    const meta = this.tokens.get(s.token);
    if (!meta || s.tokenAmount === 0n) return { priceUsd: null, usd: null };
    const extra = this.quotes.get(s.quote);
    const quoteDecimals = s.quote === QUOTES.USDG ? 6 : ETH_LIKE.has(s.quote) ? 18 : (extra?.decimals ?? 18);
    const usdPerQuote = s.quote === QUOTES.USDG ? 1 : ETH_LIKE.has(s.quote) ? this.ethUsd : (extra?.usd ?? null);
    if (usdPerQuote == null) return { priceUsd: null, usd: null };
    const quote = Number(s.quoteAmount) / 10 ** quoteDecimals;
    const tokens = Number(s.tokenAmount) / 10 ** meta.decimals;
    const usd = quote * usdPerQuote;
    const price = usd / tokens;
    // Dust and small outliers keep their USD value but never price the token (see acceptsPrice).
    const reference = this.refPrice.get(s.token) ?? null;
    if (!acceptsPrice({ usd, price, quoteRaw: s.quoteAmount, reference })) return { priceUsd: null, usd: String(usd) };
    this.refPrice.set(s.token, price);
    return { priceUsd: String(price), usd: String(usd) };
  }

  private async applyBalances(tx: TransactionSql, transfers: DecodedTransfer[]) {
    const deltas = new Map<string, { token: string; wallet: string; amount: bigint; first: Date }>();
    const add = (token: string, wallet: string, amount: bigint, time: number) => {
      if (wallet === ZERO) return;
      const key = `${token}:${wallet}`;
      const cur = deltas.get(key) ?? { token, wallet, amount: 0n, first: new Date(time * 1000) };
      cur.amount += amount;
      deltas.set(key, cur);
    };
    for (const t of transfers) {
      add(t.token, t.from, -t.amount, t.time);
      add(t.token, t.to, t.amount, t.time);
    }
    // Rows in key order: concurrent writers (poller lanes, pool history, hydrators) then lock the same
    // rows in the same order instead of deadlocking.
    const rows = [...deltas.values()]
      .sort((a, b) => (a.token === b.token ? (a.wallet < b.wallet ? -1 : 1) : a.token < b.token ? -1 : 1))
      .filter((d) => d.amount !== 0n)
      .map((d) => ({ token: d.token, wallet: d.wallet, amount: d.amount.toString(), first_received_at: d.first }));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx`insert into balances ${tx(rows.slice(i, i + 1000))}
               on conflict (token, wallet) do update set amount = balances.amount + excluded.amount, updated_at = now()`;
    }
  }

  /**
   * Wallet positions (average cost) for newly inserted swaps, in chain order. Rows are read under
   * lock in key order, updated in memory and written back; each sell's realized PnL goes on the swap.
   */
  async applyPositions(tx: TransactionSql, priced: { s: DecodedSwap; usd: string | null }[], replay = false) {
    // Swaps up to positions_from are replayed by the rebuild job (exactly once); live applies the rest.
    // Before the rebuild has started (no marker), positions aren't maintained at all.
    const from = replay ? -1n : await this.positionsFrom();
    if (from === null) return;
    const items = priced
      .filter((p) => p.usd != null && p.s.tokenAmount > 0n && p.s.block > from)
      .sort((a, b) => (a.s.block === b.s.block ? a.s.logIndex - b.s.logIndex : a.s.block < b.s.block ? -1 : 1));
    if (!items.length) return;
    const keys = [...new Set(items.map((p) => `${p.s.trader}|${p.s.token}`))].sort();
    const wallets = keys.map((k) => k.split('|')[0]!);
    const tokens = keys.map((k) => k.split('|')[1]!);
    const existing = await tx<
      { wallet: string; token: string; bought_tokens: string; bought_usd: string; sold_tokens: string; sold_usd: string; buys: number; sells: number;
        held_tokens: string; cost_basis_usd: string; realized_usd: string; unbacked_sold_tokens: string; first_trade_at: Date; last_trade_at: Date }[]
    >`select p.* from positions p join unnest(${wallets}::text[], ${tokens}::text[]) k(w, t) on p.wallet = k.w and p.token = k.t
      order by p.wallet, p.token for update of p`;
    type Pos = { bought: bigint; boughtUsd: number; sold: bigint; soldUsd: number; buys: number; sells: number; held: bigint; cost: number;
      realized: number; unbacked: bigint; first: Date; last: Date };
    const pos = new Map<string, Pos>();
    for (const r of existing) {
      pos.set(`${r.wallet}|${r.token}`, {
        bought: BigInt(r.bought_tokens), boughtUsd: Number(r.bought_usd), sold: BigInt(r.sold_tokens), soldUsd: Number(r.sold_usd),
        buys: r.buys, sells: r.sells, held: BigInt(r.held_tokens), cost: Number(r.cost_basis_usd), realized: Number(r.realized_usd),
        unbacked: BigInt(r.unbacked_sold_tokens), first: r.first_trade_at, last: r.last_trade_at,
      });
    }
    const realizedBy: { tx: string; logIndex: number; usd: number }[] = [];
    for (const { s, usd } of items) {
      const k = `${s.trader}|${s.token}`;
      const at = new Date(s.time * 1000);
      const p = pos.get(k) ?? { bought: 0n, boughtUsd: 0, sold: 0n, soldUsd: 0, buys: 0, sells: 0, held: 0n, cost: 0, realized: 0, unbacked: 0n, first: at, last: at };
      const realized = applyTrade(p, s.side, s.tokenAmount, Number(usd));
      if (s.side === 'sell') realizedBy.push({ tx: s.tx, logIndex: s.logIndex, usd: realized });
      if (at < p.first) p.first = at;
      if (at > p.last) p.last = at;
      pos.set(k, p);
    }
    const rows = keys.map((k) => {
      const p = pos.get(k)!;
      const [wallet, token] = k.split('|');
      return {
        wallet: wallet!, token: token!, bought_tokens: p.bought.toString(), bought_usd: String(p.boughtUsd), sold_tokens: p.sold.toString(),
        sold_usd: String(p.soldUsd), buys: p.buys, sells: p.sells, held_tokens: p.held.toString(), cost_basis_usd: String(p.cost),
        realized_usd: String(p.realized), unbacked_sold_tokens: p.unbacked.toString(), first_trade_at: p.first, last_trade_at: p.last,
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      await tx`insert into positions ${tx(rows.slice(i, i + 500))}
        on conflict (wallet, token) do update set bought_tokens = excluded.bought_tokens, bought_usd = excluded.bought_usd,
          sold_tokens = excluded.sold_tokens, sold_usd = excluded.sold_usd, buys = excluded.buys, sells = excluded.sells,
          held_tokens = excluded.held_tokens, cost_basis_usd = excluded.cost_basis_usd, realized_usd = excluded.realized_usd,
          unbacked_sold_tokens = excluded.unbacked_sold_tokens, first_trade_at = excluded.first_trade_at, last_trade_at = excluded.last_trade_at`;
    }
    if (realizedBy.length) {
      await tx`update swaps s set realized_usd = v.usd
        from unnest(${realizedBy.map((r) => r.tx)}::text[], ${realizedBy.map((r) => r.logIndex)}::int[], ${realizedBy.map((r) => String(r.usd))}::numeric[]) v(tx, li, usd)
        where s.tx = v.tx and s.log_index = v.li`;
    }
  }

  /**
   * Recompute positions from scratch, in chain order, for (wallet, token) pairs whose incremental state
   * may be off: swaps inserted after the rebuild passed their block (pool-history backfills), or live
   * swaps applied before older ones during the rebuild. Each pair is locked first, so a concurrent live
   * update waits and then applies on top. Returns how many pairs changed.
   */
  async recomputePositions(pairs: { wallet: string; token: string }[]): Promise<number> {
    let changed = 0;
    for (const { wallet, token } of pairs) {
      await this.sql.begin(async (tx) => {
        await tx`select 1 from positions where wallet = ${wallet} and token = ${token} for update`;
        const swaps = await tx<{ tx: string; log_index: number; side: 'buy' | 'sell'; token_amount: string; usd: string; time: Date }[]>`
          select tx, log_index, side, token_amount::text, usd::text, time from swaps
          where trader = ${wallet} and token = ${token} and usd is not null and token_amount > 0 order by block, log_index`;
        if (!swaps.length) return;
        const p = emptyPosition();
        const realized: { tx: string; li: number; usd: number }[] = [];
        for (const s of swaps) {
          const r = applyTrade(p, s.side, BigInt(s.token_amount), Number(s.usd));
          if (s.side === 'sell') realized.push({ tx: s.tx, li: s.log_index, usd: r });
        }
        const [old] = await tx<{ realized_usd: string; buys: number; sells: number }[]>`
          select realized_usd::text, buys, sells from positions where wallet = ${wallet} and token = ${token}`;
        if (old && old.buys === p.buys && old.sells === p.sells && Math.abs(Number(old.realized_usd) - p.realized) < 1e-6) return;
        await tx`insert into positions ${tx({
          wallet, token, bought_tokens: p.bought.toString(), bought_usd: String(p.boughtUsd), sold_tokens: p.sold.toString(),
          sold_usd: String(p.soldUsd), buys: p.buys, sells: p.sells, held_tokens: p.held.toString(), cost_basis_usd: String(p.cost),
          realized_usd: String(p.realized), unbacked_sold_tokens: p.unbacked.toString(), first_trade_at: swaps[0]!.time, last_trade_at: swaps.at(-1)!.time,
        })}
          on conflict (wallet, token) do update set bought_tokens = excluded.bought_tokens, bought_usd = excluded.bought_usd,
            sold_tokens = excluded.sold_tokens, sold_usd = excluded.sold_usd, buys = excluded.buys, sells = excluded.sells,
            held_tokens = excluded.held_tokens, cost_basis_usd = excluded.cost_basis_usd, realized_usd = excluded.realized_usd,
            unbacked_sold_tokens = excluded.unbacked_sold_tokens, first_trade_at = excluded.first_trade_at, last_trade_at = excluded.last_trade_at`;
        for (let i = 0; i < realized.length; i += 2000) {
          const chunk = realized.slice(i, i + 2000);
          await tx`update swaps s set realized_usd = v.usd
            from unnest(${chunk.map((r) => r.tx)}::text[], ${chunk.map((r) => r.li)}::int[], ${chunk.map((r) => String(r.usd))}::numeric[]) v(tx, li, usd)
            where s.tx = v.tx and s.log_index = v.li`;
        }
        changed++;
      });
    }
    return changed;
  }

  private positionsMarker: { at: number; block: bigint | null } = { at: 0, block: null };
  /** The positions_from marker (checked at most once a minute). */
  private async positionsFrom(): Promise<bigint | null> {
    if (Date.now() - this.positionsMarker.at > 60_000) {
      const [row] = await this.sql<{ value: { block: string } }[]>`select value from indexer_state where key = 'positions_from'`;
      this.positionsMarker = { at: Date.now(), block: row ? BigInt(row.value.block) : null };
    }
    return this.positionsMarker.block;
  }

  private async applyCandles(tx: TransactionSql, priced: { s: DecodedSwap; priceUsd: string | null; usd: string | null }[]) {
    const candles = new Map<string, { token: string; bucket: Date; o: number; h: number; l: number; c: number; v: number; n: number }>();
    const ordered = priced
      .filter((p) => p.priceUsd)
      .sort((a, b) => (a.s.block === b.s.block ? a.s.logIndex - b.s.logIndex : a.s.block < b.s.block ? -1 : 1));
    for (const { s, priceUsd, usd } of ordered) {
      const p = Number(priceUsd);
      const bucket = new Date(Math.floor(s.time / 60) * 60_000);
      const key = `${s.token}:${bucket.getTime()}`;
      const c = candles.get(key);
      if (!c) candles.set(key, { token: s.token, bucket, o: p, h: p, l: p, c: p, v: Number(usd), n: 1 });
      else Object.assign(c, { h: Math.max(c.h, p), l: Math.min(c.l, p), c: p, v: c.v + Number(usd), n: c.n + 1 });
    }
    const rows = [...candles.values()]
      .sort((a, b) => (a.token === b.token ? a.bucket.getTime() - b.bucket.getTime() : a.token < b.token ? -1 : 1))
      .map((c) => ({
      token: c.token, interval: '1m', bucket: c.bucket, open: String(c.o), high: String(c.h), low: String(c.l),
      close: String(c.c), volume_usd: String(c.v), trades: c.n,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx`insert into candles ${tx(rows.slice(i, i + 1000))}
        on conflict (token, interval, bucket) do update set
          high = greatest(candles.high, excluded.high), low = least(candles.low, excluded.low),
          close = excluded.close, volume_usd = candles.volume_usd + excluded.volume_usd, trades = candles.trades + excluded.trades`;
    }
  }

  private async refreshTokenStats(tx: TransactionSql, touched: string[], priced: { s: DecodedSwap; priceUsd: string | null }[]) {
    if (!touched.length) return;
    // Take the token rows' locks up front in address order (the updates below would lock them in scan
    // order, which deadlocks against another writer touching the same tokens).
    await tx`select 1 from tokens where address = any(${[...touched].sort()}) order by address for update`;
    const last = new Map<string, { price: string; time: number }>();
    for (const { s, priceUsd } of priced) if (priceUsd) last.set(s.token, { price: priceUsd, time: s.time });
    for (const [token, { price, time }] of [...last].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const meta = this.tokens.get(token);
      if (!meta) continue;
      const mcap = String(Number(price) * (Number(meta.totalSupply) / 10 ** meta.decimals));
      const at = new Date(time * 1000);
      // ATH always counts; current price only moves forward in time (backfill can't overwrite live).
      await tx`update tokens set
                 price_usd = case when price_at is null or price_at <= ${at} then ${price}::numeric else price_usd end,
                 market_cap_usd = case when price_at is null or price_at <= ${at} then ${mcap}::numeric else market_cap_usd end,
                 price_at = greatest(coalesce(price_at, ${at}), ${at}),
                 ath_market_cap_usd = greatest(coalesce(ath_market_cap_usd, 0), ${mcap}::numeric), updated_at = now()
               where address = ${token}`;
    }
    // PONS curve progress is read from the curves' reserves by the poller every ~15s (curves.ts).
    await tx`update tokens t set
        holders = (select count(*) from balances b where b.token = t.address and b.amount > 0),
        volume_24h_usd = (select coalesce(sum(usd), 0) from swaps s where s.token = t.address and s.time > now() - interval '24 hours')
      where t.address = any(${touched})`;
  }

  /** Backfill: replay one historical block range (launches, pools, trades, migrations; transfers come separately). */
  async backfillRange(from: bigint, to: bigint, topics: Hex[]) {
    const logs = await this.rpc.logsSplit(from, to, topics);
    if (!logs.length) return { logs: 0, launches: 0, swaps: 0, newTokens: [] as string[] };
    const stats = await this.process(logs, null);
    return { logs: logs.length, launches: stats.launches, swaps: stats.swaps, newTokens: stats.newTokens };
  }

  /** Backfill: replay already-fetched logs (merged from several filtered queries) in chain order. */
  async backfillLogs(logs: RawLog[]) {
    if (!logs.length) return { logs: 0, launches: 0, swaps: 0, newTokens: [] as string[] };
    const ordered = [...logs].sort((a, b) => {
      const ba = BigInt(a.blockNumber);
      const bb = BigInt(b.blockNumber);
      return ba === bb ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : ba < bb ? -1 : 1;
    });
    const stats = await this.process(ordered, null);
    return { logs: ordered.length, launches: stats.launches, swaps: stats.swaps, newTokens: stats.newTokens };
  }

  /** Backfill: a token's full Transfer history up to `to`, so balances and holder counts are complete. */
  async backfillTransfers(token: Address, from: bigint, to: bigint): Promise<number> {
    await this.load();
    const logs = await this.rpc.transferLogs(token, from, to);
    const transfers: DecodedTransfer[] = logs
      .filter((l) => l.topics.length === 3)
      .map((l) => ({
        tx: l.transactionHash, logIndex: Number(l.logIndex), block: BigInt(l.blockNumber),
        time: l.blockTimestamp ? Number(l.blockTimestamp) : 0, token: l.address.toLowerCase() as Address,
        from: `0x${l.topics[1]!.slice(26)}` as Address, to: `0x${l.topics[2]!.slice(26)}` as Address, amount: BigInt(l.data),
      }));
    let added = 0;
    await this.sql.begin(async (tx) => {
      added = (await this.insertTransfers(tx, transfers)).size;
      await tx`update tokens t set holders = (select count(*) from balances b where b.token = t.address and b.amount > 0)
               where t.address = ${token}`;
    });
    return added;
  }
}
