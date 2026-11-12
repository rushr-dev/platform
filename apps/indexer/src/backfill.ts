import { DurableObject } from 'cloudflare:workers';
import postgres, { type Sql } from 'postgres';
import { ETH_USD_REFERENCE_POOLS, PAIR_SWAP_TOPICS, ROBINHOOD_CHAIN, TOPICS, UNISWAP, catalogTopics, type RawLog } from '@rushr/core';
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
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as Hex;
/** Pool-history backfill: how far back a newly discovered pool's swaps are replayed (charts + 24h stats). */
const POOL_HISTORY_S = 48 * 3600;
/** Blocks per pool-history step (~1.5h at 0.11s blocks). */
const POOL_STEP = 50_000n;

/** A pool-history job: swaps of `pools` in [cursor, end], replayed with their tokens' transfers (for traders). */
interface HolderJob {
  /** Token creation block and the block before the first transfer live indexing recorded. */
  from: string;
  to: string;
  cursor: string;
  step: string;
  logs: number;
  wallets: number;
  done: boolean;
}

interface PoolJob {
  pools: string[];
  cursor: string;
  end: string;
}

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

  /**
   * Pool-history backfill (instance "pools"): replay the last 48h of swaps of pools that discovery just
   * added (e.g. a tracked token's v3 pools, or v4 pools that were missed), so 24h volume and charts are
   * complete. Pools arriving while a job runs are batched into the next one.
   */
  async enqueuePools(ids: string[]): Promise<void> {
    const pending = new Set([...((await this.ctx.storage.get<string[]>('poolsPending')) ?? []), ...ids]);
    await this.ctx.storage.put('poolsPending', [...pending]);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  /** Fill pool keys (fee, tickSpacing) for pools indexed before they were stored. Runs on the "pools" instance. */
  async fillKeys(): Promise<void> {
    await this.ctx.storage.put('keysFill', true);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 500);
  }

  /** One chunk of the key fill. Returns false when every pool has its key. */
  private async keysStep(): Promise<boolean> {
    const { sql, rpc } = this.init();
    const rows = await sql<{ id: string; dex: string }[]>`
      select id, dex from pools where fee is null and dex in ('uniswap-v4', 'v3') and not (id = any(${(await this.ctx.storage.get<string[]>('keysMissing')) ?? []}))
      order by id limit 100`;
    if (!rows.length) {
      await this.ctx.storage.delete('keysFill');
      console.log('pool keys filled');
      return false;
    }
    const v4 = rows.filter((r) => r.dex === 'uniswap-v4').map((r) => r.id);
    const v3 = rows.filter((r) => r.dex === 'v3').map((r) => r.id);
    const found = new Map<string, { fee: number | null; tickSpacing: number | null }>();
    if (v4.length) {
      for (const [id, k] of await rpc.v4Initialized(v4)) found.set(id, k);
      const rest = v4.filter((id) => !found.has(id));
      if (rest.length) for (const { id, key } of await rpc.poolKeys(rest)) if (key) found.set(id, key);
    }
    if (v3.length) for (const { id, key } of await rpc.pairKeys(v3)) if (key) found.set(id, key);
    for (const [id, k] of found) await sql`update pools set fee = ${k.fee}, tick_spacing = ${k.tickSpacing} where id = ${id}`;
    // Pools with no findable key are remembered so the loop moves past them.
    const missing = rows.map((r) => r.id).filter((id) => !found.has(id) || found.get(id)!.fee == null);
    if (missing.length) await this.ctx.storage.put('keysMissing', [...((await this.ctx.storage.get<string[]>('keysMissing')) ?? []), ...missing]);
    return true;
  }

  async poolStatus() {
    return {
      job: (await this.ctx.storage.get<PoolJob>('poolJob')) ?? null,
      pending: ((await this.ctx.storage.get<string[]>('poolsPending')) ?? []).length,
      lastError: (await this.ctx.storage.get<string>('poolError')) ?? null,
    };
  }

  /** One step of the pool-history queue. Returns false when there is nothing to do. */
  private async poolStep(): Promise<boolean> {
    let job = await this.ctx.storage.get<PoolJob>('poolJob');
    const { rpc } = this.init();
    if (!job) {
      const pending = (await this.ctx.storage.get<string[]>('poolsPending')) ?? [];
      if (!pending.length) return false;
      const head = (await rpc.blockNumber()) - BigInt(ROBINHOOD_CHAIN.confirmations);
      const back = BigInt(Math.ceil(POOL_HISTORY_S / ROBINHOOD_CHAIN.blockTimeSeconds));
      job = { pools: pending, cursor: (head - back).toString(), end: head.toString() };
      await this.ctx.storage.put('poolJob', job);
      await this.ctx.storage.delete('poolsPending');
    }
    const sql = this.sql!;
    const rows = await sql<{ id: string; dex: string; token: string }[]>`select id, dex, token from pools where id = any(${job.pools})`;
    const from = BigInt(job.cursor);
    const end = BigInt(job.end);
    const to = from + POOL_STEP - 1n > end ? end : from + POOL_STEP - 1n;
    if (rows.length && from <= end) {
      const v4 = rows.filter((r) => r.dex === 'uniswap-v4').map((r) => r.id);
      const pairs = rows.filter((r) => r.dex === 'v3' || r.dex === 'v2').map((r) => r.id);
      const curves = rows.filter((r) => r.dex === 'pons-curve').map((r) => r.id);
      const logs: RawLog[] = [];
      for (let i = 0; i < v4.length; i += FILTER_CHUNK) {
        logs.push(...(await rpc.filteredLogs(from, to, { address: UNISWAP.v4.poolManager, topics: [V4_SWAP, v4.slice(i, i + FILTER_CHUNK) as Hex[]] })));
      }
      for (let i = 0; i < pairs.length; i += FILTER_CHUNK) {
        logs.push(...(await rpc.filteredLogs(from, to, { address: pairs.slice(i, i + FILTER_CHUNK), topics: [PAIR_SWAP_TOPICS] })));
      }
      for (let i = 0; i < curves.length; i += FILTER_CHUNK) {
        logs.push(...(await rpc.filteredLogs(from, to, { address: curves.slice(i, i + FILTER_CHUNK), topics: [[TOPICS.ponsBuy, TOPICS.ponsSell] as Hex[]] })));
      }
      if (logs.length) {
        // The tokens' transfers in the same txs tell who the trader was (routers forward the tokens).
        const txs = new Set(logs.map((l) => l.transactionHash));
        const tokens = [...new Set(rows.map((r) => r.token))];
        for (let i = 0; i < tokens.length; i += FILTER_CHUNK) {
          const transfers = await rpc.filteredLogs(from, to, { address: tokens.slice(i, i + FILTER_CHUNK), topics: [TRANSFER_TOPIC] });
          logs.push(...transfers.filter((l) => txs.has(l.transactionHash)));
        }
        // A fresh pipeline each step: it must know the pools that were just discovered.
        const pipeline = new Pipeline(sql, rpc, { historical: true, skipTransfers: true });
        await pipeline.backfillLogs(logs);
      }
    }
    if (!rows.length || to >= end) {
      await this.ctx.storage.delete('poolJob');
      console.log(`pool history done: ${job.pools.length} pools from block ${job.end}`);
    } else {
      job.cursor = (to + 1n).toString();
      await this.ctx.storage.put('poolJob', job);
    }
    return true;
  }

  /**
   * Holder backfill (instance "holders"): for tokens discovered mid-life (whose Transfer history was
   * too big to fetch then), replay every Transfer from the token's creation up to the first one we
   * indexed, so balances and holder counts are complete. Balances are aggregated in `holder_backfill`
   * (the cursor moves in the same transaction, so a retried step never counts twice) and merged into
   * `balances` in one transaction at the end. Transfer rows themselves aren't stored (millions for old tokens).
   */
  async enqueueHolders(tokens: string[]): Promise<void> {
    const pending = [...new Set([...((await this.ctx.storage.get<string[]>('holdersPending')) ?? []), ...tokens.map((t) => t.toLowerCase())])];
    await this.ctx.storage.put('holdersPending', pending);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async holderStatus() {
    const { sql } = this.init();
    const jobs = await sql<{ key: string; value: HolderJob; updated_at: Date }[]>`
      select key, value, updated_at from indexer_state where key like 'holders:%' order by updated_at desc limit 50`;
    return {
      pending: (await this.ctx.storage.get<string[]>('holdersPending')) ?? [],
      lastError: (await this.ctx.storage.get<string>('holdersError')) ?? null,
      jobs: jobs.map((j) => ({ token: j.key.slice(8), ...j.value, updatedAt: j.updated_at })),
    };
  }

  /** One step of the holder queue (the head token). Returns false when there is nothing to do. */
  private async holderStep(): Promise<boolean> {
    const pending = (await this.ctx.storage.get<string[]>('holdersPending')) ?? [];
    const token = pending[0];
    if (!token) return false;
    const { sql, rpc } = this.init();
    const key = `holders:${token}`;
    let [row] = await sql<{ value: HolderJob }[]>`select value from indexer_state where key = ${key}`;
    if (!row) {
      // Live indexing owns every transfer from the first one it recorded: replay what came before.
      const [first] = await sql<{ b: string | null }[]>`select min(block)::text as b from transfers where token = ${token}`;
      const origin = await rpc.tokenOrigin(token as Address);
      if (!first?.b || !origin) {
        console.warn(`holders: skipped ${token} (${!first?.b ? 'no indexed transfers' : 'no origin'})`);
        await this.ctx.storage.put('holdersPending', pending.slice(1));
        return true;
      }
      const job: HolderJob = { from: origin.block.toString(), to: (BigInt(first.b) - 1n).toString(), cursor: origin.block.toString(), step: '50000', logs: 0, wallets: 0, done: false };
      await sql`insert into indexer_state (key, value) values (${key}, ${sql.json(job as never)}) on conflict (key) do nothing`;
      row = { value: job };
    }
    const job = row.value;
    if (job.done) {
      await this.ctx.storage.put('holdersPending', pending.slice(1));
      return true;
    }
    const from = BigInt(job.cursor);
    const end = BigInt(job.to);
    if (from > end) {
      // Merge the staged balances into the live ones, once.
      await sql.begin(async (tx) => {
        const [st] = await tx<{ value: HolderJob }[]>`select value from indexer_state where key = ${key} for update`;
        if (st?.value.done) return;
        await tx`insert into balances (token, wallet, amount, first_received_at)
                 select token, wallet, amount, first_received_at from holder_backfill where token = ${token}
                 on conflict (token, wallet) do update set amount = balances.amount + excluded.amount,
                   first_received_at = least(balances.first_received_at, excluded.first_received_at), updated_at = now()`;
        await tx`delete from holder_backfill where token = ${token}`;
        await tx`update tokens t set holders = (select count(*) from balances b where b.token = t.address and b.amount > 0) where t.address = ${token}`;
        await tx`update indexer_state set value = ${tx.json({ ...job, done: true } as never)}, updated_at = now() where key = ${key}`;
      });
      const [t] = await sql<{ holders: number }[]>`select holders from tokens where address = ${token}`;
      console.log(`holders: ${token} done, ${job.logs} transfers replayed, ${t?.holders} holders`);
      await this.ctx.storage.put('holdersPending', pending.slice(1));
      return true;
    }
    const step = BigInt(job.step);
    const to = from + step - 1n > end ? end : from + step - 1n;
    const logs = await rpc.transferLogs(token as Address, from, to);
    const deltas = new Map<string, { amount: bigint; first: number }>();
    const add = (wallet: string, amount: bigint, time: number) => {
      if (wallet === '0x0000000000000000000000000000000000000000') return;
      const cur = deltas.get(wallet) ?? { amount: 0n, first: time };
      cur.amount += amount;
      cur.first = Math.min(cur.first, time);
      deltas.set(wallet, cur);
    };
    for (const l of logs) {
      if (l.topics.length !== 3) continue;
      const amount = BigInt(l.data === '0x' ? 0 : l.data);
      const time = l.blockTimestamp ? Number(l.blockTimestamp) : 0;
      add(`0x${l.topics[1]!.slice(26)}`.toLowerCase(), -amount, time);
      add(`0x${l.topics[2]!.slice(26)}`.toLowerCase(), amount, time);
    }
    const rows = [...deltas].map(([wallet, d]) => ({ token, wallet, amount: d.amount.toString(), first_received_at: new Date(d.first * 1000) }));
    // Aim for 3-7K logs per call: Alchemy caps a wide-range response at 10K logs (over that the call
    // fails and is split), so stay under it, growing through quiet stretches and shrinking when busy.
    const nextStep = logs.length < 3_000 ? step * 2n : logs.length > 7_000 ? step / 2n || 1n : step;
    const next: HolderJob = {
      ...job, cursor: (to + 1n).toString(), step: (nextStep > 5_000_000n ? 5_000_000n : nextStep).toString(),
      logs: job.logs + logs.length, wallets: job.wallets + rows.length,
    };
    await sql.begin(async (tx) => {
      // The cursor moves in the same transaction as the staged amounts: a retried step can't double-count.
      const [st] = await tx<{ value: HolderJob }[]>`select value from indexer_state where key = ${key} for update`;
      if (st?.value.cursor !== job.cursor) return;
      for (let i = 0; i < rows.length; i += 1000) {
        await tx`insert into holder_backfill ${tx(rows.slice(i, i + 1000))}
                 on conflict (token, wallet) do update set amount = holder_backfill.amount + excluded.amount,
                   first_received_at = least(holder_backfill.first_received_at, excluded.first_received_at)`;
      }
      await tx`update indexer_state set value = ${tx.json(next as never)}, updated_at = now() where key = ${key}`;
    });
    return true;
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
    // Holder queue (only the "holders" instance gets these).
    if (((await this.ctx.storage.get<string[]>('holdersPending')) ?? []).length) {
      const started = Date.now();
      try {
        while (Date.now() - started < BUDGET_MS && (await this.holderStep()));
        await this.ctx.storage.delete('holdersError');
      } catch (err) {
        console.error('holder backfill error', err);
        await this.ctx.storage.put('holdersError', String(err instanceof Error ? err.message : err).slice(0, 500));
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
        return;
      }
      if (((await this.ctx.storage.get<string[]>('holdersPending')) ?? []).length) await this.ctx.storage.setAlarm(Date.now() + 10);
      return;
    }
    // Pool-key fill (the "pools" instance), before the history queue.
    if (await this.ctx.storage.get('keysFill')) {
      const started = Date.now();
      try {
        while (Date.now() - started < BUDGET_MS && (await this.keysStep()));
      } catch (err) {
        console.error('pool keys error', err);
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + 10);
      return;
    }
    // Pool-history queue (only the "pools" instance gets these).
    const hasPools = (await this.ctx.storage.get('poolJob')) || ((await this.ctx.storage.get<string[]>('poolsPending')) ?? []).length;
    if (hasPools) {
      const started = Date.now();
      try {
        while (Date.now() - started < BUDGET_MS && (await this.poolStep()));
        await this.ctx.storage.delete('poolError');
      } catch (err) {
        console.error('pool history error', err);
        await this.ctx.storage.put('poolError', String(err instanceof Error ? err.message : err).slice(0, 500));
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
        return;
      }
      const more = (await this.ctx.storage.get('poolJob')) || ((await this.ctx.storage.get<string[]>('poolsPending')) ?? []).length;
      if (more) await this.ctx.storage.setAlarm(Date.now() + 10);
      return;
    }
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
        await this.env.METADATA_QUEUE.sendBatch(chunk.map((r) => ({ body: { kind: 'token-metadata' as const, token: r.address } })));
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
    const pairs = pools.filter((p) => p.dex === 'v3' || p.dex === 'v2').map((p) => p.id);
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
    for (let i = 0; i < pairs.length; i += FILTER_CHUNK) {
      out.push(...(await rpc.filteredLogs(from, to, { address: pairs.slice(i, i + FILTER_CHUNK), topics: [PAIR_SWAP_TOPICS] })));
    }
    return out;
  }
}
