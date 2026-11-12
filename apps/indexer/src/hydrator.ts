import { DurableObject } from 'cloudflare:workers';
import postgres, { type Sql } from 'postgres';
import type { Address, Hex } from 'viem';
import { NATIVE_ETH, PAIR_SWAP_TOPICS, QUOTES, ROBINHOOD_CHAIN, STOCK_QUOTES, TOPICS, UNISWAP, decodeLogs, type PoolInfo, type RawLog } from '@rushr/core';
import { dbUrl, holderHistory, poller as pollerOf, type Env } from './env';
import { Pipeline } from './pipeline';
import { Rpc } from './rpc';
import { tokenSnapshot } from './data';
import { GATEWAY_COUNT, gateway, type DeltaEvent } from './gateway';

/**
 * Read-through hydration (docs/realtime.md "Hydration"): a token someone opens that we have no data
 * for is fetched from chain, persisted through the normal pipeline, handed to the poller, and streamed
 * to its viewers as it lands: last 30 min first, then 6h, then 24h.
 *
 * One instance per token (`hyd:<address>`), so concurrent viewers share one fetch; at most one run per
 * token per COOLDOWN; all runs together are capped by the RpcBudget instance.
 */

export const hydrator = (env: Env, token: string) =>
  env.HYDRATOR.get(env.HYDRATOR.idFromName(`hyd:${token.toLowerCase()}`), { locationHint: 'apac' });

export type HydrationState = 'hydrating' | 'partial' | 'live' | 'busy' | 'not_token';

const COOLDOWN_MS = 60_000;
const NOT_TOKEN_TTL_MS = 10 * 60_000;
/** Hydrations per minute across all tokens (≈1,200 CU each: hard cap ≈ $15/day). */
const BUDGET_PER_MIN = 20;
/** Windows replayed, newest first, in seconds. */
const WINDOWS_S = [30 * 60, 6 * 3600, 24 * 3600];
const INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438' as Hex;
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as Hex;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
const ADDRESS_CHUNK = 500;
/** ETH/WETH/USDG: what tokens are priced in. */
const CORE = new Set<string>([NATIVE_ETH, QUOTES.WETH, QUOTES.USDG]);
const STOCK = new Set<string>(Object.values(STOCK_QUOTES));
/** Most frequent transfer counterparties checked for v3/v2 Swap events per window. */
const MAX_CANDIDATES = 1_000;
const chainOrder = (a: RawLog, b: RawLog) =>
  a.blockNumber === b.blockNumber ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1;

const topicOf = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
const addrOf = (t: string) => `0x${t.slice(26)}`.toLowerCase();

export class TokenHydrator extends DurableObject<Env> {
  private running?: Promise<void>;
  private state: HydrationState | null = null;
  /** Latest hydration snapshot, replayed to viewers who subscribe mid-hydration. */
  private lastSnapshot: string | null = null;

  /** Start (or join) a hydration. Returns at once with the current state; progress is streamed to gateways. */
  async hydrate(token: string): Promise<{ state: HydrationState; /** JSON of the latest hydration snapshot data */ snapshot?: string }> {
    token = token.toLowerCase();
    if (CORE.has(token)) return { state: 'not_token' }; // ETH/WETH/USDG are the quotes everything is priced in
    if (this.running) return { state: this.state ?? 'hydrating', snapshot: this.lastSnapshot ?? undefined };
    const notToken = await this.ctx.storage.get<number>('notTokenUntil');
    if (notToken && notToken > Date.now()) return { state: 'not_token' };
    const last = await this.ctx.storage.get<{ at: number; state: HydrationState }>('last');
    if (last && Date.now() - last.at < COOLDOWN_MS) return { state: last.state, snapshot: this.lastSnapshot ?? undefined };
    const ok = await this.env.RPC_BUDGET.get(this.env.RPC_BUDGET.idFromName('global')).take(BUDGET_PER_MIN);
    if (!ok) return { state: 'busy' };
    this.state = 'hydrating';
    await this.ctx.storage.put('last', { at: Date.now(), state: 'hydrating' });
    this.running = this.run(token)
      .catch((err) => {
        console.error('hydration failed', token, err);
        this.state = 'partial';
      })
      .finally(async () => {
        this.running = undefined;
        await this.ctx.storage.put('last', { at: Date.now(), state: this.state ?? 'partial' });
      });
    this.ctx.waitUntil(this.running);
    return { state: 'hydrating' };
  }

  private async run(token: string) {
    const rpc = new Rpc(this.env.RPC_URL);
    const sql: Sql = postgres(dbUrl(this.env), { max: 3, fetch_types: false, prepare: false, connect_timeout: 10 });
    const t0 = Date.now();
    try {
      // Round 1, in parallel: is it a token (garbage addresses are remembered for 10 min), do we know
      // it, the ETH price, the head.
      // The creation lookup can be slow for busy tokens: it only feeds created_at, so it doesn't hold round 1.
      const originP = rpc.tokenOrigin(token as Address).catch(() => null);
      const [[meta], [known], [eth], headRaw] = await Promise.all([
        rpc.tokenMetadata([token as Address]),
        sql<{ n: number }[]>`select count(*)::int as n from tokens where address = ${token}`,
        sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`,
        rpc.blockNumber(),
      ]);
      if (!meta || (meta.totalSupply === 0n && !meta.symbol)) {
        await this.ctx.storage.put('notTokenUntil', Date.now() + NOT_TOKEN_TTL_MS);
        this.state = 'not_token';
        await this.publish(token, { type: 'state', data: { state: 'not_token' } });
        return;
      }
      const wasTracked = (known?.n ?? 0) > 0;
      const r1 = Date.now() - t0;
      const head = headRaw - BigInt(ROBINHOOD_CHAIN.confirmations);
      const blocks = (s: number) => BigInt(Math.ceil(s / ROBINHOOD_CHAIN.blockTimeSeconds));

      // Pools that can't be found from recent transfers: every v4 pool of the token (Initialize, either
      // side) and its PONS curve. Few logs, so the whole chain fits one request each.
      const tok = topicOf(token);
      // Round 2, in parallel: the catalog and the first window's transfers.
      const firstFrom = head - blocks(WINDOWS_S[0]!) + 1n;
      // v4 pools where this token is the traded side: one exact Initialize filter per (token, quote) pair
      // (currencies are sorted, so the pair fixes both topic positions). Asking for "any pool with the
      // token" returns every pool that uses it as a quote: thousands for a stock token.
      const isStock = STOCK.has(token);
      const quotes = [...CORE, ...(isStock ? [] : [...STOCK])];
      const [initLists, launches, firstTransfers] = await Promise.all([
        Promise.all(
          quotes.map((q) =>
            rpc.filteredLogs(0n, head, { address: UNISWAP.v4.poolManager, topics: q < token ? [INIT, null, topicOf(q), tok] : [INIT, null, tok, topicOf(q)] }),
          ),
        ),
        rpc.filteredLogs(0n, head, { topics: [TOPICS.ponsLaunch, tok] }),
        rpc.filteredLogs(firstFrom, head, { address: token, topics: [TRANSFER] }),
      ]);
      const inits = initLists.flat();
      const r2 = Date.now() - t0;
      const v4Ids = [...new Set(inits.map((l) => l.topics[1]!.toLowerCase()))];
      const curves = [...new Set(launches.map((l) => addrOf(l.topics[2]!)))];
      const catalog = [...inits, ...launches];
      const origin = await Promise.race([originP, new Promise<null>((r) => setTimeout(() => r(null), 1_000))]);
      const createdAt = origin?.time ? new Date(origin.time * 1000).toISOString() : null;
      const pairCandidates = new Set<string>();

      // One pipeline for all windows (its load() reads every pool and token once).
      const pipeline = new Pipeline(sql, rpc, { historical: true, anyAge: true, skipTransfers: true, noHistory: true, onlyToken: token });
      let to = head;
      let first = true;
      for (const span of WINDOWS_S) {
        const from = head - blocks(span) + 1n;
        if (from > to) continue;
        const tf = Date.now();
        const transfers = first ? firstTransfers : await rpc.filteredLogs(from, to, { address: token, topics: [TRANSFER] });
        // v3/v2 pools (any factory) show up as counterparties of the token's transfers. Pools trade often,
        // so keep the most frequent counterparties (a busy token has thousands of wallets).
        const freq = new Map<string, number>();
        for (const l of transfers) for (const t of [l.topics[1], l.topics[2]]) if (t) freq.set(addrOf(t), (freq.get(addrOf(t)) ?? 0) + 1);
        for (const [a] of [...freq].sort((x, y) => y[1] - x[1]).slice(0, MAX_CANDIDATES)) pairCandidates.add(a);
        const fetches: Promise<RawLog[]>[] = [];
        for (let i = 0; i < v4Ids.length; i += 100) {
          fetches.push(rpc.filteredLogs(from, to, { address: UNISWAP.v4.poolManager, topics: [V4_SWAP, v4Ids.slice(i, i + 100) as Hex[]] }));
        }
        const cands = [...pairCandidates];
        for (let i = 0; i < cands.length; i += ADDRESS_CHUNK) {
          fetches.push(rpc.filteredLogs(from, to, { address: cands.slice(i, i + ADDRESS_CHUNK), topics: [PAIR_SWAP_TOPICS] }));
        }
        if (curves.length) fetches.push(rpc.filteredLogs(from, to, { address: curves, topics: [[TOPICS.ponsBuy, TOPICS.ponsSell, TOPICS.ponsGraduate] as Hex[]] }));
        const swaps = (await Promise.all(fetches)).flat();
        const tw0 = Date.now();
        const txs = new Set(swaps.map((l) => l.transactionHash));
        const logs = [...(first ? catalog : []), ...swaps, ...transfers.filter((l) => txs.has(l.transactionHash))];
        if (first) {
          // First paint before anything is written: decode in memory and stream it (target ~1-2s).
          await this.fastSnapshot(token, meta, logs, eth?.value.usd ?? null, rpc, createdAt).catch((err) => console.error('fast snapshot failed', err));
          console.log(`hydrate ${token.slice(0, 10)} first paint in ${Date.now() - t0}ms (round1 ${r1}ms, catalog+transfers ${r2}ms, swaps ${tw0 - t0}ms; ${v4Ids.length} v4 pools, ${pairCandidates.size} candidates)`);
        }

        // Same write path as the indexer. Transfers only resolve traders here (the holder backfill
        // writes balances exactly); any-age tokens are tracked; no history fetch on discovery.
        const tw = Date.now();
        if (logs.length) await pipeline.backfillLogs(logs);
        console.log(`hydrate ${token.slice(0, 10)} window ${span}s: fetch ${tw - tf}ms, write ${Date.now() - tw}ms, ${swaps.length} swaps`);

        if (first) {
          first = false;
          const [row] = await sql<{ n: number }[]>`select count(*)::int as n from tokens where address = ${token}`;
          if (!row?.n) {
            // Nothing tradeable (no quote pool): not indexable. Tell viewers and stop.
            this.state = 'live';
            await this.publish(token, { type: 'state', data: { state: 'live', empty: true } });
            return;
          }
          // Hand the token to the poller now, so trades from here on stream live.
          const { cursor } = await pollerOf(this.env).adopt(token);
          if (!wasTracked && cursor) await this.queueHolders(sql, token, BigInt(cursor), await originP);
          await this.env.METADATA_QUEUE.send({ kind: 'token-metadata', token });
          console.log(`hydrated ${meta.symbol} first window in ${Date.now() - t0}ms (${swaps.length} swaps)`);
        }
        this.state = span === WINDOWS_S.at(-1) ? 'live' : 'partial';
        const snap = await tokenSnapshot(sql, this.env.RPC_URL, token);
        // Covered range so far, in unix seconds (the client shows "last 6h loaded").
        const now = Math.floor(Date.now() / 1000);
        if (snap) await this.publish(token, { type: 'snapshot', data: { state: 'partial', progress: { from: now - span, to: now }, ...snap } });
        to = from - 1n;
      }
      // Indexing owns the topic now: gateways send viewers a numbered snapshot.
      await this.publish(token, { type: 'state', data: { state: 'live' } });
      await sql`update tokens t set
          holders = (select count(*) from balances b where b.token = t.address and b.amount > 0),
          volume_24h_usd = (select coalesce(sum(usd), 0) from swaps s where s.token = t.address and s.time > now() - interval '24 hours')
        where t.address = ${token}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Trades and candles straight from the fetched logs (no database): v4 and curve pools come from the
   * catalog logs, v3/v2 pairs get one token0/token1 batch. Priced in ETH/WETH/USDG only.
   */
  private async fastSnapshot(
    token: string, meta: { symbol: string; name: string; decimals: number; totalSupply: bigint }, logs: RawLog[], ethUsd: number | null, rpc: Rpc,
    createdAt: string | null,
  ) {
    const pairAddrs = [...new Set(logs.filter((l) => PAIR_SWAP_TOPICS.includes(l.topics[0] as Hex)).map((l) => l.address.toLowerCase()))];
    // PONS curves are priced in ETH or USDG (pairToken()); launch events don't say which.
    const curves = [...new Set(logs.filter((l) => l.topics[0] === TOPICS.ponsLaunch && l.topics[2]).map((l) => addrOf(l.topics[2]!)))];
    const [keys, curveQuotes] = await Promise.all([
      pairAddrs.length ? rpc.pairKeys(pairAddrs) : Promise.resolve([]),
      curves.length ? rpc.curveQuotes(curves) : Promise.resolve(new Map<string, Address>()),
    ]);
    const pools = new Map<string, PoolInfo>();
    for (const { id, key } of keys) {
      if (!key || (key.currency0 !== token && key.currency1 !== token)) continue;
      const quote = key.currency0 === token ? key.currency1 : key.currency0;
      if (!CORE.has(quote) && (STOCK.has(token) || !STOCK.has(quote))) continue;
      const dex = logs.some((l) => l.address.toLowerCase() === id && l.topics[0] === TOPICS.v2Swap) ? 'v2' : 'v3';
      pools.set(id, { id, token: token as Address, quote: quote as Address, tokenIsCurrency0: key.currency0 === token, dex, launchpad: null, hooks: null, block: 0n, time: 0 });
    }
    const r = decodeLogs([...logs].sort(chainOrder), {
      getPool: (id) => pools.get(id), isTracked: (t) => t === token, curveQuote: (c) => curveQuotes.get(c), focusToken: token as Address,
    });
    const usdPer = (q: string) => (q === QUOTES.USDG ? 1 : q === QUOTES.WETH || q === NATIVE_ETH ? ethUsd : null);
    const trades = r.swaps
      .filter((x) => x.token === token)
      .map((x) => {
        const per = usdPer(x.quote);
        const qd = x.quote === QUOTES.USDG ? 6 : 18;
        const usd = per == null ? null : (Number(x.quoteAmount) / 10 ** qd) * per;
        const tokens = Number(x.tokenAmount) / 10 ** meta.decimals;
        return {
          tx: x.tx, logIndex: x.logIndex, time: x.time, trader: x.trader, side: x.side, tokenAmount: x.tokenAmount.toString(),
          quoteAmount: x.quoteAmount.toString(), quote: x.quote, pool: x.pool, priceUsd: usd != null && tokens > 0 ? usd / tokens : null, usd, tags: [] as string[],
        };
      });
    const candles = (size: number) => {
      const m = new Map<number, { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number }>();
      for (const t of trades) {
        if (t.priceUsd == null) continue;
        const time = Math.floor(t.time / size) * size;
        const c = m.get(time);
        if (!c) m.set(time, { time, open: t.priceUsd, high: t.priceUsd, low: t.priceUsd, close: t.priceUsd, volume: t.usd ?? 0, trades: 1 });
        else Object.assign(c, { high: Math.max(c.high, t.priceUsd), low: Math.min(c.low, t.priceUsd), close: t.priceUsd, volume: c.volume + (t.usd ?? 0), trades: c.trades + 1 });
      }
      return [...m.values()].sort((a, b) => a.time - b.time);
    };
    const price = [...trades].reverse().find((t) => t.priceUsd != null)?.priceUsd ?? null;
    const card = {
      address: token, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, total_supply: meta.totalSupply.toString(), created_at: createdAt,
      image_url: null, price_usd: price,
      market_cap_usd: price == null ? null : price * (Number(meta.totalSupply) / 10 ** meta.decimals),
      volume_24h_usd: null, holders: null, liquidity_usd: null, launchpad: null, status: null,
    };
    await this.publish(token, {
      type: 'snapshot',
      data: {
        state: 'hydrating', progress: { from: Math.floor(Date.now() / 1000) - WINDOWS_S[0]!, to: Math.floor(Date.now() / 1000) },
        card, stats: null, pools: [], trades: [...trades].reverse().slice(0, 200), candles: { '1s': candles(1), '1m': candles(60) },
      },
    });
  }

  /** Exact holders: replay Transfers from creation up to the poller's cursor at adoption (it records the rest). */
  private async queueHolders(sql: Sql, token: string, cursor: bigint, origin: { block: bigint } | null) {
    if (!origin) return;
    const job = { from: origin.block.toString(), to: cursor.toString(), cursor: origin.block.toString(), step: '50000', logs: 0, wallets: 0, done: false };
    await sql`insert into indexer_state (key, value) values (${`holders:${token}`}, ${sql.json(job as never)}) on conflict (key) do nothing`;
    await holderHistory(this.env).enqueueHolders([token]);
  }

  /** To every gateway (only those with subscribers deliver). Hydration messages sit outside the sequence. */
  private async publish(token: string, e: { type: string; data: unknown }) {
    const event: DeltaEvent = { topic: `token:${token}`, type: e.type, seq: null, source: 'chain', data: e.data };
    if (e.type === 'snapshot') this.lastSnapshot = JSON.stringify(e.data);
    await Promise.all([...Array(GATEWAY_COUNT).keys()].map((k) => gateway(this.env, k).publish('', [event]).catch(() => 0)));
  }
}

/** Global rate limit for hydrations (a rolling minute). One instance: "global". */
export class RpcBudget extends DurableObject<Env> {
  private hits: number[] = [];

  async take(perMinute: number): Promise<boolean> {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 60_000);
    if (this.hits.length >= perMinute) return false;
    this.hits.push(now);
    return true;
  }

  async usage() {
    const now = Date.now();
    return { lastMinute: this.hits.filter((t) => now - t < 60_000).length, perMinute: BUDGET_PER_MIN };
  }
}
