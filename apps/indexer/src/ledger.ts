// Trade ledger (Swap stream's request): every trade placed through Rushr is recorded from the chain,
// with the platform fee the treasury actually received and the referrer's accrual. Clients only tell
// us the tx hash; amounts never come from the client.
//
//   POST /v1/trades                  { txHash, chainId: 4663, source: { kind, id? }, feeTxHash? }  → 202 { id, status }
//
// Curve trades (a PONS token still on its bonding curve, traded on the curve directly) pay the fee in a
// second transaction: a plain ETH transfer to the treasury at the trade's nonce + 1. The client posts
// the same trade again with `feeTxHash` once it is sent; until the schema has a column for it, the hash
// is kept in `flags` as `fee_tx:<hash>`. A curve trade whose fee transfer never arrives (or doesn't
// check out) is confirmed with `fee_missed` and fee 0.
//   GET  /v1/me/trades?before=&limit= the member's trades, newest first
//   GET  /v1/me/referrals/accrued     confirmed fees and accruals of trades the member referred, per fee token
//
// Mounted inside Agents' /v1 app, so auth (Privy humans, agent API keys with scope 'trade'), rate limits
// and error format are theirs. Confirmation runs on the enrich queue ('trade-confirm').
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { auditCurveFee, curveFillFromLogs, DEFAULT_TRADE_CONFIG, effectiveFeeBps, type FeeTxInfo } from '@rushr/trade';
import { NATIVE_ETH, QUOTES } from '@rushr/core';
import { fail, limit, requireMember, PRIVATE, type Ctx } from './agents/http';
import { referralFor } from './agents/referrals';
import type { Env } from './env';
import { Rpc } from './rpc';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAIN_ID = 4663;
const TX = /^0x[0-9a-f]{64}$/;
/** Confirmation retries: the receipt, then our own indexing of the swap (a few seconds behind). */
export const CONFIRM_DELAYS_S = [3, 5, 10, 20, 30, 60, 120, 300];

export const trades = new Hono<Ctx>();

trades.post('/trades', async (c) => {
  const m = requireMember(c, { scope: 'trade' });
  await limit(c, 'write');
  const b = (c.var.body ?? {}) as { txHash?: unknown; chainId?: unknown; source?: { kind?: unknown; id?: unknown }; feeTxHash?: unknown };
  const txHash = typeof b.txHash === 'string' ? b.txHash.toLowerCase() : '';
  if (!TX.test(txHash)) throw fail(400, 'bad_tx_hash', 'txHash must be a 32-byte hex hash.');
  const feeTxHash = b.feeTxHash == null ? null : typeof b.feeTxHash === 'string' ? b.feeTxHash.toLowerCase() : '';
  if (feeTxHash !== null && (!TX.test(feeTxHash) || feeTxHash === txHash)) throw fail(400, 'bad_fee_tx_hash', 'feeTxHash must be a 32-byte hex hash of another transaction.');
  if (b.chainId !== CHAIN_ID) throw fail(400, 'bad_chain', 'Only Robinhood Chain (4663) is supported.');
  const kind = b.source?.kind ?? (m.kind === 'agent' ? 'agent' : 'web');
  if (kind !== 'web' && kind !== 'agent' && kind !== 'api') throw fail(400, 'bad_source', 'source.kind must be web, agent or api.');
  const sourceId = typeof b.source?.id === 'string' ? b.source.id.slice(0, 100) : null;
  // A tx hash has the same shape as a private key. Store it only once the chain confirms it is a
  // transaction (sent or pending): a key pasted here by mistake never matches one and is never written.
  const rpc = new Rpc(c.env.RPC_URL);
  const lookup = (h: string) => rpc.call<{ from: string } | null>('eth_getTransactionByHash', [h]).catch(() => null);
  const [onChain, feeOnChain] = await Promise.all([lookup(txHash), feeTxHash ? lookup(feeTxHash) : null]);
  if (!onChain) throw fail(404, 'tx_not_found', 'No transaction with this hash on Robinhood Chain (yet). Send it after the wallet broadcasts it.');
  if (onChain.from.toLowerCase() !== m.wallet) throw fail(403, 'not_your_tx', "This transaction wasn't sent from your wallet.");
  if (feeTxHash && !feeOnChain) throw fail(404, 'tx_not_found', 'No transaction with the fee hash on Robinhood Chain (yet).');
  if (feeTxHash && feeOnChain!.from.toLowerCase() !== m.wallet) throw fail(403, 'not_your_tx', "The fee transaction wasn't sent from your wallet.");
  const sql = c.var.sql;
  const id = crypto.randomUUID();
  const [row] = await sql<{ id: string; status: string; trader: string }[]>`
    insert into trades_ledger (id, chain_id, status, tx_hash, ts, trader, source_kind, source_id)
    values (${id}, ${CHAIN_ID}, 'submitted', ${txHash}, now(), ${m.wallet}, ${kind}, ${sourceId})
    on conflict (tx_hash) do update set tx_hash = excluded.tx_hash
    returning id, status, trader`;
  if (row!.trader !== m.wallet) throw fail(409, 'tx_claimed', 'This transaction is already recorded for another member.');
  let status = row!.status;
  if (feeTxHash) {
    // First fee hash wins (the confirmation checks it is the transfer at the next nonce). A trade
    // already confirmed without it is confirmed again.
    const [u] = await sql<{ status: string; reconfirm: boolean }[]>`
      update trades_ledger set flags = array_append(array_remove(flags, 'fee_missed'), ${`fee_tx:${feeTxHash}`}),
        status = case when status = 'confirmed' then 'submitted' else status end, updated_at = now()
      where id = ${row!.id} and not exists (select 1 from unnest(flags) f where f like 'fee_tx:%')
      returning status, (${row!.status} = 'confirmed') as reconfirm`;
    if (u) status = u.status;
    // The fee transfer is what a curve trade's confirmation waits for: confirm now, whatever happened
    // to the job queued with the trade (confirming twice is harmless). The cron sweep is the backstop.
    if (u && row!.id !== id) await c.env.ENRICH_QUEUE.send({ kind: 'trade-confirm', tx: txHash }, { delaySeconds: CONFIRM_DELAYS_S[0] });
  }
  if (row!.id === id) await c.env.ENRICH_QUEUE.send({ kind: 'trade-confirm', tx: txHash }, { delaySeconds: CONFIRM_DELAYS_S[0] });
  return c.json({ id: row!.id, status }, 202, PRIVATE);
});

trades.get('/me/trades', async (c) => {
  const m = requireMember(c);
  await limit(c, 'read');
  const before = c.req.query('before') ? new Date(Number(c.req.query('before')) * 1000) : new Date(Date.now() + 60_000);
  const n = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const rows = await c.var.sql`
    select id, status, chain_id, tx_hash, block_number::text, extract(epoch from ts)::int as ts, trader, source_kind, source_id, side, token,
      quote_asset, venue, pool_id, router, amount_in::text, amount_out::text, fee_token, base_fee_bps, fee_bps::float8, fee_amount::text,
      referrer, referral_code, referral_discount::text, referrer_share_bps, referrer_accrual::text, flags
    from trades_ledger where trader = ${m.wallet} and ts < ${before} order by ts desc limit ${n}`;
  return c.json({ trades: rows }, 200, PRIVATE);
});

trades.get('/me/referrals/accrued', async (c) => {
  const m = requireMember(c);
  await limit(c, 'read');
  const rows = await c.var.sql`
    select fee_token, count(*)::int as trades, coalesce(sum(fee_amount), 0)::text as confirmed_fee_amount,
      coalesce(sum(referrer_accrual), 0)::text as referrer_accrual
    from trades_ledger where referrer = ${m.wallet} and status = 'confirmed' group by fee_token`;
  return c.json({ accrued: rows }, 200, PRIVATE);
});

interface CallFrame {
  type: string;
  from: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: CallFrame[];
}

/** Native ETH moved to `to` by successful calls anywhere in the trace (internal transfers included). */
export function ethReceived(frame: CallFrame, to: string): bigint {
  let sum = 0n;
  const walk = (f: CallFrame) => {
    if (f.error) return; // reverted frames moved nothing
    if (f.to?.toLowerCase() === to && f.value && f.type !== 'DELEGATECALL' && f.type !== 'STATICCALL') sum += BigInt(f.value);
    for (const ch of f.calls ?? []) walk(ch);
  };
  walk(frame);
  return sum;
}

/** Net ERC-20 flow of `token` into (positive) or out of (negative) `who` from receipt logs. */
export function tokenFlow(logs: { address: string; topics: string[]; data: string }[], token: string, who: string): bigint {
  let net = 0n;
  const w = who.toLowerCase();
  for (const l of logs) {
    if (l.address.toLowerCase() !== token || l.topics[0] !== TRANSFER || l.topics.length !== 3) continue;
    const from = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
    const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
    const v = BigInt(l.data);
    if (to === w) net += v;
    if (from === w) net -= v;
  }
  return net;
}

/** A trade still `submitted` this long after its last attempt has lost its confirmation job. */
export const STUCK_AFTER_S = 180;
/** Past this age, the sweep's attempt is the final one (the same window as CONFIRM_DELAYS_S, ~10 min). */
export const FINAL_AFTER_S = CONFIRM_DELAYS_S.reduce((a, b) => a + b, 0) + 60;

/**
 * Backstop for confirmation jobs that never ran (a queue send that failed after the row was written,
 * a message dropped after its retries): confirms trades left `submitted`. Run from the cron.
 */
export async function sweepStuckTrades(sql: Sql, env: Env, limit = 20): Promise<{ tx: string; result: 'done' | 'retry' }[]> {
  const rows = await sql<{ tx_hash: string; final: boolean }[]>`
    select tx_hash, ts < now() - make_interval(secs => ${FINAL_AFTER_S}) as final from trades_ledger
    where status = 'submitted' and chain_id = ${CHAIN_ID} and updated_at < now() - make_interval(secs => ${STUCK_AFTER_S})
    order by ts limit ${limit}`;
  const out: { tx: string; result: 'done' | 'retry' }[] = [];
  for (const r of rows) out.push({ tx: r.tx_hash, result: await confirmTrade(sql, env, r.tx_hash, r.final) });
  return out;
}

/**
 * Fill a ledger row from the chain. Returns 'retry' while the receipt or our indexing of the swap isn't
 * there yet; 'done' otherwise (confirmed, failed, or confirmed with flags when something didn't match).
 */
export async function confirmTrade(sql: Sql, env: Env, txHash: string, finalAttempt: boolean): Promise<'done' | 'retry'> {
  const [row] = await sql<{ id: string; status: string; trader: string; flags: string[] | null }[]>`select id, status, trader, flags from trades_ledger where tx_hash = ${txHash}`;
  if (!row || row.status === 'confirmed' || row.status === 'failed') return 'done';
  await sql`update trades_ledger set confirm_attempts = confirm_attempts + 1, updated_at = now() where id = ${row.id}`;
  const rpc = new Rpc(env.RPC_URL);
  const [receipt, tx] = await rpc.batch<Record<string, unknown>>([
    { method: 'eth_getTransactionReceipt', params: [txHash] },
    { method: 'eth_getTransactionByHash', params: [txHash] },
  ]);
  if (!receipt || !tx) {
    if (finalAttempt) await sql`update trades_ledger set status = 'failed', flags = array_append(flags, 'not_found'), updated_at = now() where id = ${row.id}`;
    return finalAttempt ? 'done' : 'retry';
  }
  const from = String(tx.from).toLowerCase();
  // Kept across confirmations: the fee transfer reported by the client (curve trades).
  const feeTxFlag = (row.flags ?? []).find((f) => f.startsWith('fee_tx:')) ?? null;
  const flags: string[] = feeTxFlag ? [feeTxFlag] : [];
  if (from !== row.trader) flags.push('trader_mismatch');
  const block = BigInt(receipt.blockNumber as string);
  const blk = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]);
  const ts = new Date(Number(BigInt(blk.timestamp)) * 1000);
  if (receipt.status !== '0x1') {
    await sql`update trades_ledger set status = 'failed', block_number = ${block.toString()}, ts = ${ts}, router = ${String(tx.to ?? '').toLowerCase()},
      flags = ${[...flags, 'reverted']}, updated_at = now() where id = ${row.id}`;
    return 'done';
  }

  // Which token, side and pool: our own decoded swap rows for this tx (any venue we index).
  const swaps = await sql<{ token: string; side: 'buy' | 'sell'; pool: string; quote: string; venue: string | null; dex: string | null }[]>`
    select s.token, s.side, s.pool, s.quote, p.venue, p.dex from swaps s left join pools p on p.id = s.pool
    where s.tx = ${txHash} and s.trader = ${from} order by s.usd desc nulls last`;
  if (!swaps.length && !finalAttempt) return 'retry';
  if (!swaps.length) {
    // Even on the last attempt: if the poller hasn't indexed this block yet (catching up after a pause or
    // an outage), wait for it rather than settle as swap_not_indexed. The 2-minute sweep comes back.
    const [cur] = await sql<{ value: { block: string } }[]>`select value from indexer_state where key = 'cursor'`;
    if (!cur || BigInt(cur.value.block) < block) return 'retry';
  }
  const logs = receipt.logs as { address: string; topics: string[]; data: string }[];
  const treasury = DEFAULT_TRADE_CONFIG.feeRecipient.toLowerCase();
  let s = swaps[0];
  if (!s) {
    // Not indexed (a token we don't track): the token is what moved to or from the trader.
    flags.push('swap_not_indexed');
    const moved = [...new Set(logs.filter((l) => l.topics[0] === TRANSFER).map((l) => l.address.toLowerCase()))]
      .filter((a) => a !== QUOTES.WETH && a !== QUOTES.USDG)
      .map((a) => ({ token: a, net: tokenFlow(logs, a, from) }))
      .filter((x) => x.net !== 0n);
    const t = moved[0];
    if (!t) {
      await sql`update trades_ledger set status = 'confirmed', block_number = ${block.toString()}, ts = ${ts}, flags = ${[...flags, 'no_token_moved']},
        router = ${String(tx.to ?? '').toLowerCase()}, updated_at = now() where id = ${row.id}`;
      return 'done';
    }
    const usdgMoved = tokenFlow(logs, QUOTES.USDG, from) !== 0n;
    s = { token: t.token, side: t.net > 0n ? 'buy' : 'sell', pool: '', quote: usdgMoved ? QUOTES.USDG : NATIVE_ETH, venue: null, dex: null };
  }
  const quoteAsset: 'ETH' | 'USDG' = s.quote === QUOTES.USDG ? 'USDG' : 'ETH';

  // The fee: what the treasury actually received in this tx. ETH from the call trace (internal
  // transfers aren't logs); USDG from Transfer logs.
  let feeToken = quoteAsset === 'USDG' ? QUOTES.USDG : NATIVE_ETH;
  let fee = 0n;
  let trace: CallFrame | null = null;
  if (quoteAsset === 'ETH') {
    trace = await rpc.call<CallFrame>('debug_traceTransaction', [txHash, { tracer: 'callTracer' }]);
    fee = ethReceived(trace, treasury);
    if (fee === 0n) {
      const weth = tokenFlow(logs, QUOTES.WETH, treasury); // fee paid in WETH instead
      if (weth > 0n) { fee = weth; feeToken = QUOTES.WETH; }
    }
  } else {
    fee = tokenFlow(logs, QUOTES.USDG, treasury);
  }

  // Amounts from the trader's side of the chain.
  const tokenNet = tokenFlow(logs, s.token, from);
  let amountIn: bigint;
  let amountOut: bigint;
  if (s.side === 'buy') {
    amountOut = tokenNet > 0n ? tokenNet : 0n;
    amountIn = quoteAsset === 'ETH' ? BigInt((tx.value as string) ?? '0x0') - (trace ? ethReceived(trace, from) : 0n) : -tokenFlow(logs, QUOTES.USDG, from);
  } else {
    amountIn = tokenNet < 0n ? -tokenNet : 0n;
    amountOut = quoteAsset === 'ETH' ? (trace ? ethReceived(trace, from) : 0n) : tokenFlow(logs, QUOTES.USDG, from);
  }
  const cfg = DEFAULT_TRADE_CONFIG;
  const ref = await referralFor(sql, from);
  const expectedBps = effectiveFeeBps(cfg, ref ? { referrer: ref.referrer as `0x${string}` } : null);

  // Direct curve trade: the fee is the follow-up transfer, checked against the curve's own fill.
  const fill = String(tx.to ?? '').toLowerCase() !== cfg.universalRouter.toLowerCase() ? curveFillFromLogs(logs, from) : null;
  let notional: bigint;
  if (fill) {
    const feeTxHash = feeTxFlag?.slice('fee_tx:'.length) ?? null;
    if (!feeTxHash && !finalAttempt) return 'retry';
    let feeTx: FeeTxInfo | null = null;
    if (feeTxHash) {
      const [fr, ft] = await rpc.batch<Record<string, unknown> | null>([
        { method: 'eth_getTransactionReceipt', params: [feeTxHash] },
        { method: 'eth_getTransactionByHash', params: [feeTxHash] },
      ]);
      if (!fr || !ft) {
        if (!finalAttempt) return 'retry';
      } else {
        feeTx = { hash: feeTxHash as `0x${string}`, from: String(ft.from) as `0x${string}`, to: (ft.to ?? null) as `0x${string}` | null, value: BigInt((ft.value as string) ?? '0x0'), input: String(ft.input ?? '0x') as `0x${string}`, nonce: Number(BigInt(ft.nonce as string)), status: fr.status === '0x1' ? 'success' : 'reverted' };
      }
    }
    const audit = auditCurveFee({
      hash: txHash as `0x${string}`, from: from as `0x${string}`, nonce: Number(BigInt(tx.nonce as string)), value: BigInt((tx.value as string) ?? '0x0'),
      status: 'success', logs, trace, feeTx, treasury: cfg.feeRecipient, feeBps: cfg.feeBps, referredFeeBps: expectedBps, referred: !!ref,
    });
    flags.push(...audit.flags);
    // A fee transfer that doesn't check out (wrong nonce, recipient, sender, reverted) counts as missed.
    if (audit.flags.some((f) => f.startsWith('fee_tx_'))) flags.push('fee_missed');
    fee = audit.fee;
    feeToken = NATIVE_ETH;
    notional = fill.quoteAmount;
    // Sells: the fee came out of what the curve paid, so the seller ended with that minus the fee.
    if (s.side === 'sell') amountOut = amountOut > fee ? amountOut - fee : 0n;
  } else {
    // Fee rate on the quote notional: buys pay it out of the input, sells out of the gross output.
    notional = s.side === 'buy' ? amountIn : amountOut + fee;
  }
  const feeBps = notional > 0n ? (Number(fee) * 10_000) / Number(notional) : null;
  if (!fill) {
    if (fee === 0n) flags.push('no_fee');
    else if (feeBps != null && Math.abs(feeBps - expectedBps) > 1) flags.push(`fee_bps_${feeBps.toFixed(1)}_expected_${expectedBps}`);
  }
  const baseFee = (notional * BigInt(cfg.feeBps)) / 10_000n;
  const discount = ref && baseFee > fee ? baseFee - fee : 0n;
  const accrual = ref ? (fee * BigInt(cfg.referrerShareBps)) / 10_000n : 0n;

  await sql`update trades_ledger set status = 'confirmed', block_number = ${block.toString()}, ts = ${ts}, side = ${s.side}, token = ${s.token},
    quote_asset = ${quoteAsset}, venue = ${s.venue ?? (s.dex === 'uniswap-v4' ? 'uniswap' : s.dex)}, pool_id = ${s.pool || null},
    router = ${String(tx.to ?? '').toLowerCase()}, amount_in = ${amountIn.toString()}, amount_out = ${amountOut.toString()},
    fee_token = ${feeToken}, base_fee_bps = ${cfg.feeBps}, fee_bps = ${feeBps}, fee_amount = ${fee.toString()},
    referrer = ${ref?.referrer ?? null}, referral_code = ${ref?.code ?? null}, referral_discount = ${discount.toString()},
    referrer_share_bps = ${ref ? cfg.referrerShareBps : 0}, referrer_accrual = ${accrual.toString()}, flags = ${flags}, updated_at = now()
    where id = ${row.id}`;
  return 'done';
}
