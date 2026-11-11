import { DurableObject } from 'cloudflare:workers';
import postgres, { type Sql } from 'postgres';
import { ETH_USD_REFERENCE_POOLS, TOPICS, UNISWAP, catalogTopics, type RawLog } from '@rushr/core';
import type { Address, Hex } from 'viem';
import { dbUrl, type Env } from './env';
import { Pipeline } from './pipeline';
import { Rpc } from './rpc';

/**
 * Full-history backfill, resumable. One instance ("main"). Progress lives in DO storage, and every
 * write is idempotent, so a crash, redeploy or `stop` resumes where it left off.
 *
 *   catalog    launches, pool creations, migrations from block 0 (sparse, big ranges)
 *   swaps      Swap/Buy/Sell only for pools we track, in time windows, replayed in chain order
 *              (the ETH/USD reference pools ride along so historical prices are right)
 *   transfers  each token's full Transfer history, for balances and holder counts
 *   finalize   holders and 24h volume for every token, then queue signals and metadata
 *
 * Transfers are skipped in the first two phases on purpose: they are ~80% of all logs on the chain
 * and we only need them for the tokens we track.
 */

type Phase = 'catalog' | 'swaps' | 'transfers' | 'finalize' | 'done';

interface State {
  phase: Phase;
  /** Next block for catalog/swaps; next token offset for transfers. */
  cursor: string;
  /** First and last block covered (end fixed at start, so live indexing owns everything after it). */
  start: string;
  end: string;
  startedAt: number;
  updatedAt: number;
  counts: { logs: number; launches: number; swaps: number; transfers: number; tokens: number };
  error: string | null;
}

const BUDGET_MS = 25_000;
const CATALOG_RANGE = 200_000n;
const SWAP_WINDOW = 200_000n;
/** Pool ids / curve addresses per getLogs filter. */
const FILTER_CHUNK = 100;
const TRANSFER_CONCURRENCY = 6;

export class Backfiller extends DurableObject<Env> {
  private sql?: Sql;
  private pipeline?: Pipeline;
  private rpc?: Rpc;

  private init() {
    if (!this.pipeline) {
      this.sql = postgres(dbUrl(this.env), { max: 4, fetch_types: false, prepare: false });
      this.rpc = new Rpc(this.env.RPC_URL);
      this.pipeline = new Pipeline(this.sql, this.rpc, { historical: true, anyAge: true });
    }
    return { sql: this.sql!, rpc: this.rpc!, pipeline: this.pipeline };
  }

  async start(fromBlock = 0): Promise<State> {
    const { rpc } = this.init();
    const existing = await this.ctx.storage.get<State>('state');
    if (existing && existing.phase !== 'done') {
      existing.error = null;
      // Older state without a start block: adopt the one given, and never replay swaps before it.
      existing.start ??= String(fromBlock);
      if (existing.phase === 'swaps' && BigInt(existing.cursor) < BigInt(existing.start)) existing.cursor = existing.start;
      await this.ctx.storage.put('state', existing);
    } else {
      const head = await rpc.blockNumber();
      await this.ctx.storage.put<State>('state', {
        phase: 'catalog',
        cursor: String(fromBlock),
        start: String(fromBlock),
        end: head.toString(),
        startedAt: Date.now(),
        updatedAt: Date.now(),
        counts: { logs: 0, launches: 0, swaps: 0, transfers: 0, tokens: 0 },
        error: null,
      });
    }
    await this.ctx.storage.put('running', true);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return (await this.status())!;
  }

  async stop(): Promise<State | null> {
    await this.ctx.storage.put('running', false);
    await this.ctx.storage.deleteAlarm();
    return this.status();
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async status(): Promise<(State & { running: boolean; progress: string }) | null> {
    const s = await this.ctx.storage.get<State>('state');
    if (!s) return null;
    const running = (await this.ctx.storage.get<boolean>('running')) ?? false;
    const end = Number(s.end);
    const start = Number(s.start ?? 0);
    const progress =
      s.phase === 'catalog' || s.phase === 'swaps'
        ? `${s.phase} ${(((Number(s.cursor) - start) / Math.max(1, end - start)) * 100).toFixed(1)}%`
        : s.phase === 'transfers'
          ? `${s.cursor} / ${s.counts.tokens} tokens`
          : s.phase;
    return { ...s, running, progress };
  }

  override async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get<boolean>('running'))) return;
    const s = await this.ctx.storage.get<State>('state');
    if (!s || s.phase === 'done') return;
    const started = Date.now();
    try {
      while (Date.now() - started < BUDGET_MS && (s.phase as Phase) !== 'done') {
        await this.step(s);
        s.updatedAt = Date.now();
        await this.ctx.storage.put('state', s);
      }
      s.error = null;
    } catch (err) {
      s.error = String(err instanceof Error ? err.message : err).slice(0, 500);
      await this.ctx.storage.put('state', s);
      console.error('backfill error', s.phase, s.cursor, s.error);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
      return;
    }
    if ((s.phase as Phase) !== 'done') await this.ctx.storage.setAlarm(Date.now() + 10);
    else console.log('backfill done', JSON.stringify(s.counts));
  }

  private async step(s: State) {
    const { sql, rpc, pipeline } = this.init();
    const end = BigInt(s.end);

    if (s.phase === 'catalog') {
      const from = BigInt(s.cursor);
      const to = from + CATALOG_RANGE - 1n > end ? end : from + CATALOG_RANGE - 1n;
      const r = await pipeline.backfillRange(from, to, catalogTopics());
      s.counts.logs += r.logs;
      s.counts.launches += r.launches;
      s.cursor = (to + 1n).toString();
      if (to >= end) {
        // Swaps only from the job's start: pools created earlier are covered from there on.
        const first = BigInt(await this.firstPoolBlock(sql));
        const begin = BigInt(s.start);
        Object.assign(s, { phase: 'swaps', cursor: (first > begin ? first : begin).toString() });
      }
      return;
    }

    if (s.phase === 'swaps') {
      const from = BigInt(s.cursor);
      const to = from + SWAP_WINDOW - 1n > end ? end : from + SWAP_WINDOW - 1n;
      const logs = await this.windowLogs(sql, rpc, from, to);
      const r = await pipeline.backfillLogs(logs);
      s.counts.logs += r.logs;
      s.counts.swaps += r.swaps;
      s.counts.launches += r.launches;
      s.cursor = (to + 1n).toString();
      if (to >= end) {
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from tokens`;
        Object.assign(s, { phase: 'transfers', cursor: '0' });
        s.counts.tokens = row?.n ?? 0;
      }
      return;
    }

    if (s.phase === 'transfers') {
      const offset = Number(s.cursor);
      const batch = await sql<{ address: string; created_block: string }[]>`
        select address, created_block from tokens order by created_block, address
        offset ${offset} limit ${TRANSFER_CONCURRENCY}`;
      if (!batch.length) {
        s.phase = 'finalize';
        return;
      }
      const added = await Promise.all(
        batch.map((t) => pipeline.backfillTransfers(t.address as Address, BigInt(t.created_block) - 1n, end)),
      );
      s.counts.transfers += added.reduce((a, b) => a + b, 0);
      s.cursor = String(offset + batch.length);
      return;
    }

    if (s.phase === 'finalize') {
      await sql`update tokens t set
          holders = (select count(*) from balances b where b.token = t.address and b.amount > 0),
          volume_24h_usd = (select coalesce(sum(usd), 0) from swaps w where w.token = t.address and w.time > now() - interval '24 hours')`;
      const rows = await sql<{ address: string }[]>`select address from tokens`;
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await this.env.ENRICH_QUEUE.sendBatch(chunk.map((r) => ({ body: { kind: 'token-signals' as const, token: r.address } })));
      }
      const noMeta = await sql<{ address: string }[]>`select address from tokens where metadata_at is null`;
      for (let i = 0; i < noMeta.length; i += 100) {
        const chunk = noMeta.slice(i, i + 100);
        await this.env.ENRICH_QUEUE.sendBatch(chunk.map((r) => ({ body: { kind: 'token-metadata' as const, token: r.address } })));
      }
      s.phase = 'done';
    }
  }

  private async firstPoolBlock(sql: Sql): Promise<string> {
    const [r] = await sql<{ b: string | null }[]>`select min(created_block)::text as b from pools`;
    return r?.b ?? '0';
  }

  /**
   * All trade logs in [from, to] for pools that existed by `to`: v4 Swap filtered by pool id
   * (plus the ETH/USD reference pools) and PONS curve Buy/Sell filtered by curve address.
   */
  private async windowLogs(sql: Sql, rpc: Rpc, from: bigint, to: bigint): Promise<RawLog[]> {
    const pools = await sql<{ id: string; dex: string }[]>`
      select id, dex from pools where created_block <= ${to.toString()}`;
    const v4 = [...new Set([...pools.filter((p) => p.dex === 'uniswap-v4').map((p) => p.id), ...ETH_USD_REFERENCE_POOLS])];
    const curves = pools.filter((p) => p.dex === 'pons-curve').map((p) => p.id);
    const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as Hex;
    const out: RawLog[] = [];
    for (let i = 0; i < v4.length; i += FILTER_CHUNK) {
      out.push(
        ...(await rpc.filteredLogs(from, to, {
          address: UNISWAP.v4.poolManager,
          topics: [V4_SWAP, v4.slice(i, i + FILTER_CHUNK) as Hex[]],
        })),
      );
    }
    for (let i = 0; i < curves.length; i += FILTER_CHUNK) {
      out.push(
        ...(await rpc.filteredLogs(from, to, {
          address: curves.slice(i, i + FILTER_CHUNK),
          topics: [[TOPICS.ponsBuy, TOPICS.ponsSell, TOPICS.ponsGraduate] as Hex[]],
        })),
      );
    }
    return out;
  }
}
