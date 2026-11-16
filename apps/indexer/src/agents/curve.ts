// Agent trades on PONS bonding curves, and the follow-up fee they owe.
//
// A token still on its PONS curve trades on the curve directly (curve.buy / curve.sell from the agent's
// wallet), the same path the web app uses (packages/trade quick.ts, prepareCurveTrade). Nothing in that
// call can pay Rushr, so the fee is a second transaction: a plain ETH transfer to the treasury, sent
// after the trade confirms. The build returns both, in order (`tx`, then `followUp.tx`).
//
// Enforcement is off-chain and doesn't rely on the agent reporting anything:
// - every curve build is recorded (member_events 'curve_build': token, curve, side, amounts, fee);
// - the indexer sees the curve's own CurveBuy/CurveSell events (swaps, pool = the curve address); a swap
//   from the agent's wallet that matches a build (same curve and side, the build's amounts) owes that
//   build's quoted fee;
// - fees count as paid once the agent reports the transfer (POST /v1/agents/me/fees { txHash }), checked
//   on-chain: from the agent's wallet, to the treasury, no calldata, succeeded. Each transfer counts once.
// Fees still unpaid FEE_GRACE_MINUTES after their trade block further builds with 402 `fee_unpaid`,
// whose error carries the amount and a ready-to-send transfer. Paying (late is fine) clears it. Quotes
// stay allowed. Curve trades made outside Rushr (another site, a direct call) match no build and owe nothing.
import type { Sql } from 'postgres';
import type { Address, PublicClient } from 'viem';
import { discoverPools } from '@rushr/trade/pools';
import { prepareQuickTrade, type QuickTrade, type WalletCall } from '@rushr/trade/quick';
import { curveFeeCall } from '@rushr/trade/curve-fee';
import { LEGACY_TREASURIES, resolveConfig } from '@rushr/trade/config';
import type { PonsPool, Referral } from '@rushr/trade/types';
import { fail, type MemberRow } from './http';
import { Rpc } from '../rpc';

/** Minutes after a curve trade before an unpaid fee blocks builds. */
export const FEE_GRACE_MINUTES = 10;
/** A built curve tx has no on-chain deadline: a swap this long after the build still matches it. */
const MATCH_WINDOW = '24 hours';
const NO_CAP = (1n << 255n) - 1n;

/** The token's PONS curve when it's still on it (read from the chain), else null. */
export async function liveCurve(client: PublicClient, token: Address, trader: Address): Promise<PonsPool | null> {
  const pools = await discoverPools(client, token, { quoteAsset: 'ETH', trader, venues: ['pons-curve'] });
  return pools.find((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated) ?? null;
}

export interface CurveRequest {
  side: 'buy' | 'sell';
  token: Address;
  amountIn: bigint;
  trader: Address;
  slippageBps?: number;
}

/** What a curve quote or build needs from the web path's builder, mapped to API errors. */
export async function prepareCurve(
  client: PublicClient,
  req: CurveRequest,
  curve: PonsPool,
  opts: { mode: 'quote' | 'build'; simulate: boolean; acceptImpact: boolean; referral: Referral | null; fundEthWei: bigint },
): Promise<QuickTrade> {
  // Quotes (and dry runs) pretend the balances so they work before the wallet is funded; a plain build
  // reads the real balances and allowance.
  const dry = opts.mode === 'quote' || opts.simulate;
  const t = await prepareQuickTrade(client, { side: req.side, token: req.token, amountIn: req.amountIn, trader: req.trader, referral: opts.referral }, {
    discover: { pools: [curve] },
    // No per-trade cap for agents (the API's rate limits and impact guard apply instead); explicit or automatic slippage.
    settings: { maxTradeWei: NO_CAP, slippageBps: req.slippageBps ?? null },
    simulate: opts.mode === 'build' && opts.simulate,
    assume: dry ? { ethWei: opts.fundEthWei, tokenWei: opts.mode === 'quote' ? req.amountIn : undefined } : undefined,
  });
  for (const b of t.blockers) {
    if (b.code === 'HIGH_IMPACT' || b.code === 'SIMULATION_REVERTED') continue; // the API's own impact guard; simulation reported below
    if (b.code === 'INSUFFICIENT_TOKEN' && opts.mode === 'build' && opts.simulate) continue; // a dry run reports it as a failed simulation
    if (b.code === 'INSUFFICIENT_ETH' || b.code === 'INSUFFICIENT_TOKEN') throw fail(422, 'insufficient_funds', b.message);
    if (b.code === 'SNIPE_TAX_ACTIVE') throw fail(422, 'snipe_tax_active', b.message, { retryAfter: 10 });
    if (b.code === 'CURVE_GRADUATED') throw fail(409, 'curve_graduated', 'This token just graduated to Uniswap. Quote again in a few seconds to trade it there.', { retryAfter: 10 });
    if (b.code === 'NO_ROUTE') throw fail(422, 'trade_NO_ROUTE', b.message);
    throw fail(422, `trade_${b.code}`, b.message);
  }
  if (!t.quote) throw fail(422, 'trade_NO_ROUTE', 'No quote for this curve trade.');
  return t;
}

/** Simulation summary for a curve build: the web builder blocks on a revert, so that's what we report. */
export function curveSimulation(t: QuickTrade, simulated: boolean) {
  if (!simulated) return null;
  const bad = t.blockers.find((b) => b.code === 'SIMULATION_REVERTED' || b.code === 'INSUFFICIENT_TOKEN');
  if (bad) return { ok: false, error: bad.message };
  if (t.blockers.some((b) => b.code === 'HIGH_IMPACT')) return null; // not simulated
  if (t.warnings.some((w) => w.startsWith('Pre-send simulation unavailable'))) return null;
  return { ok: true, error: null };
}

export const unsigned = (c: WalletCall) => ({ chainId: c.chainId, to: c.to, data: c.data, value: c.value.toString(), gas: c.gas.toString() });

// ---- fee obligations ----

export async function recordCurveBuild(sql: Sql, m: MemberRow, t: QuickTrade, curve: Address) {
  const q = t.quote!;
  await sql`insert into member_events (member_id, type, data) values (${m.id}, 'curve_build', ${sql.json({
    token: q.request.token.toLowerCase(),
    curve: curve.toLowerCase(),
    side: q.request.side,
    amountIn: q.amountIn.toString(),
    minOut: (q.request.side === 'buy' ? q.minAmountOut : q.minGrossOut ?? q.minAmountOut).toString(),
    fee: q.fee.feeAmount.toString(),
  })})`;
}

export interface FeeTrade {
  tx: string;
  time: Date;
  token: string;
  side: 'buy' | 'sell';
  fee: string;
}

export interface FeeStatus {
  /** Every matched curve trade's fee, ever. */
  owed: bigint;
  /** Fee transfers reported and verified. */
  paid: bigint;
  /** Owed on trades older than the grace period, minus paid: > 0 blocks builds. */
  overdue: bigint;
  /** owed − paid: what one transfer should carry to settle everything. */
  outstanding: bigint;
  trades: FeeTrade[];
}

export async function feeStatus(sql: Sql, m: Pick<MemberRow, 'id' | 'wallet'>): Promise<FeeStatus> {
  const trades = await sql<(FeeTrade & { due: boolean })[]>`
    select distinct on (s.tx, s.log_index) s.tx, s.time, s.token, s.side, b.data->>'fee' as fee,
      s.time < now() - make_interval(mins => ${FEE_GRACE_MINUTES}) as due
    from member_events b
    join swaps s on s.trader = ${m.wallet} and s.pool = b.data->>'curve' and s.token = b.data->>'token' and s.side = b.data->>'side'
      and s.time >= b.created_at - interval '1 minute' and s.time < b.created_at + ${MATCH_WINDOW}::interval
      and case when s.side = 'sell'
        then s.token_amount = (b.data->>'amountIn')::numeric
        else s.quote_amount <= (b.data->>'amountIn')::numeric and s.token_amount >= (b.data->>'minOut')::numeric end
    where b.member_id = ${m.id} and b.type = 'curve_build'
    order by s.tx, s.log_index, b.created_at desc`;
  const [p] = await sql<{ paid: string }[]>`
    select coalesce(sum((data->>'value')::numeric), 0)::text as paid from member_events where member_id = ${m.id} and type = 'curve_fee_paid'`;
  const owed = trades.reduce((s, t) => s + BigInt(t.fee), 0n);
  const due = trades.filter((t) => t.due).reduce((s, t) => s + BigInt(t.fee), 0n);
  const paid = BigInt(p?.paid ?? '0');
  const pos = (x: bigint) => (x > 0n ? x : 0n);
  return {
    owed,
    paid,
    overdue: pos(due - paid),
    outstanding: pos(owed - paid),
    trades: trades.sort((a, b) => b.time.getTime() - a.time.getTime()).map(({ due: _due, ...t }) => t),
  };
}

export function feeView(s: FeeStatus) {
  const cfg = resolveConfig();
  return {
    owed: s.owed.toString(),
    paid: s.paid.toString(),
    overdue: s.overdue.toString(),
    outstanding: s.outstanding.toString(),
    graceMinutes: FEE_GRACE_MINUTES,
    feeTx: s.outstanding > 0n ? unsigned(curveFeeCall(cfg, s.outstanding)) : null,
    trades: s.trades.slice(0, 20),
  };
}

/** Builds are refused while a curve fee is overdue. */
export async function assertFeesPaid(sql: Sql, m: MemberRow) {
  const s = await feeStatus(sql, m);
  if (s.overdue <= 0n) return;
  const v = feeView(s);
  throw fail(
    402,
    'fee_unpaid',
    `You owe ${v.outstanding} wei of Rushr fees on bonding-curve trades. Send error.feeTx from your registered wallet, then POST /v1/agents/me/fees { "txHash" } to report it; builds resume once it checks out.`,
    { owed: v.outstanding, overdue: v.overdue, feeTx: v.feeTx, trades: v.trades, report: 'POST /v1/agents/me/fees' },
  );
}

const TX = /^0x[0-9a-f]{64}$/;

/** Records a reported fee transfer after checking it on-chain. Each transfer counts once, for one member. */
export async function reportFeePayment(sql: Sql, rpcUrl: string, m: MemberRow, txHash: string): Promise<bigint> {
  if (!TX.test(txHash)) throw fail(422, 'invalid_field', 'txHash must be a 32-byte hex hash.', { field: 'txHash' });
  const rpc = new Rpc(rpcUrl);
  const [tx, receipt] = await rpc.batch<Record<string, unknown> | null>([
    { method: 'eth_getTransactionByHash', params: [txHash] },
    { method: 'eth_getTransactionReceipt', params: [txHash] },
  ]);
  if (!tx || !receipt) throw fail(404, 'tx_not_found', 'No confirmed transaction with this hash on Robinhood Chain yet. Report it after its receipt.', { retryAfter: 5 });
  const treasuries = [resolveConfig().feeRecipient, ...LEGACY_TREASURIES].map((a) => a.toLowerCase());
  const value = BigInt((tx.value as string) ?? '0x0');
  const problems: string[] = [];
  if (String(tx.from).toLowerCase() !== m.wallet) problems.push('not sent from your registered wallet');
  if (!treasuries.includes(String(tx.to ?? '').toLowerCase())) problems.push(`not sent to the treasury ${resolveConfig().feeRecipient}`);
  if (String(tx.input ?? '0x') !== '0x') problems.push('has calldata (send plain ETH)');
  if (receipt.status !== '0x1') problems.push('reverted');
  if (value <= 0n) problems.push('sends no ETH');
  if (problems.length) throw fail(422, 'not_a_fee_payment', `This transaction isn't a fee payment: ${problems.join(', ')}.`);
  await sql.begin(async (q) => {
    await q`select pg_advisory_xact_lock(hashtext(${`fee:${txHash}`}))`;
    const [seen] = await q`select 1 from member_events where type = 'curve_fee_paid' and data->>'tx' = ${txHash}`;
    if (seen) throw fail(409, 'already_reported', 'This fee transfer was already reported.');
    await q`insert into member_events (member_id, type, data) values (${m.id}, 'curve_fee_paid', ${q.json({ tx: txHash, value: value.toString() })})`;
  });
  return value;
}
