// $RUSHR creator tax for /transparency: what the creator wallet has earned, claimed and not yet claimed.
//
// How PONS pays it (read from the contracts, 2026-11-16):
// - On the bonding curve, every trade charges a creator tax (creatorTaxBps) and a PONS fee (feeBps) in
//   ETH. The curve sweeps both into PONS's fee escrow (`FeesSwept`): the creator is credited the tax plus
//   (1 - protocolFeeShareBps) of the fee, PONS the rest.
// - After graduation the token trades in a Uniswap v4 pool whose hook takes the same two cuts from each
//   swap, in whichever currency it can (ETH or $RUSHR), and holds them: `pendingCreatorTax(poolId, c)` and
//   `pendingFees(poolId, c)`. The fee-sweep operator periodically sells the $RUSHR part for ETH and
//   credits the escrow the same way (`PoolFeesSwept`).
// - The escrow keeps one ETH balance per account (`balanceOf`), emitting `Credited(account, from,
//   amount)` and `Claimed(account, amount)`. The creator claims whenever they like.
//
// So: earned = escrow credits from the curve and the hook (indexed from Credited logs) + the creator's
// share of what the hook still holds; claimed = Claimed logs; unclaimed = balanceOf + that pending share.
//
// Cost: no per-swap work. Each refresh (at most once a minute, only while the page is being viewed) is one
// eth_blockNumber, one batch of six eth_calls and one eth_getLogs over the blocks since the last refresh
// (escrow logs filtered to the creator), tried on the chain's public RPC first, then Alchemy.
import type { Sql } from 'postgres';
import { ROBINHOOD_CHAIN, type RawLog } from '@rushr/core';
import { Rpc } from './rpc';

/** The $RUSHR launch: token, creator (its deployer), PONS curve, graduated v4 pool and PONS contracts. */
export const RUSHR_LAUNCH = {
  token: '0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed',
  creator: '0xe5ed29849043380aea7cfe62e97a23e82c55578e',
  curve: '0x187c3d36266d3fbe11a77be6bedb01bd68e52958',
  /** PONS v2 hook on the graduated pool (holds the pool's fees and creator tax until swept). */
  hook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  poolId: '0x1013c35e6cef89e84afa58e2409d675afa2c634511d984d1c0161a8ee8ec5f8a',
  /** PONS fee escrow (the hook's feeEscrow()): where the creator's ETH is credited and claimed from. */
  escrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
  /** The launch block: nothing was credited before it. */
  launchBlock: 115051413n,
} as const;

/** `Credited(address indexed account, address indexed from, uint256 amount)` on the escrow. */
export const CREDITED_TOPIC = '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5';
/** `Claimed(address indexed account, uint256 amount)` on the escrow. */
export const CLAIMED_TOPIC = '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a';

const STATE_KEY = 'rushr_creator_tax';
const MEMO_MS = 60_000;
const BPS = 10_000n;
const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const addrOf = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

export interface Claim {
  tx: string;
  block: string;
  /** Block time (ISO 8601) when the provider returns it. */
  at: string | null;
  /** ETH claimed, in wei. */
  raw: string;
}

/** What the escrow logs add up to, through `cursor` (kept in indexer_state). Amounts in wei. */
export interface EscrowTally {
  cursor: string;
  fromCurve: string;
  fromHook: string;
  /** Credits from anything else (another token by the same wallet): in balanceOf, not in $RUSHR's earned. */
  fromOther: string;
  claims: Claim[];
}

/** The hook's and escrow's views at one block. Amounts in the currency's smallest unit. */
export interface CreatorTaxLive {
  block: string;
  at: string;
  /** escrow.balanceOf(creator): ETH the creator can claim now. */
  escrowEth: string;
  pendingCreatorTax: { eth: string; rushr: string };
  pendingFees: { eth: string; rushr: string };
  protocolFeeShareBps: number;
}

export const emptyTally = (): EscrowTally => ({ cursor: (RUSHR_LAUNCH.launchBlock - 1n).toString(), fromCurve: '0', fromHook: '0', fromOther: '0', claims: [] });

/** Fold escrow logs for blocks (tally.cursor, to] into the tally (pure; exported for tests). */
export function tallyEscrowLogs(tally: EscrowTally, logs: Pick<RawLog, 'topics' | 'data' | 'transactionHash' | 'blockNumber' | 'blockTimestamp'>[], to: bigint): EscrowTally {
  const cursor = BigInt(tally.cursor);
  const out = { ...tally, claims: [...tally.claims] };
  let curve = BigInt(tally.fromCurve), hook = BigInt(tally.fromHook), other = BigInt(tally.fromOther);
  for (const l of logs) {
    const block = BigInt(l.blockNumber);
    if (block <= cursor || block > to) continue;
    if (l.topics.length < 2 || addrOf(l.topics[1]!) !== RUSHR_LAUNCH.creator) continue;
    const amount = BigInt(l.data.slice(0, 66));
    if (l.topics[0] === CREDITED_TOPIC && l.topics[2]) {
      const from = addrOf(l.topics[2]);
      if (from === RUSHR_LAUNCH.curve) curve += amount;
      else if (from === RUSHR_LAUNCH.hook) hook += amount;
      else other += amount;
    } else if (l.topics[0] === CLAIMED_TOPIC) {
      const at = l.blockTimestamp ? new Date(Number(BigInt(l.blockTimestamp)) * 1000).toISOString() : null;
      out.claims.push({ tx: l.transactionHash, block: block.toString(), at, raw: amount.toString() });
    }
  }
  return { ...out, cursor: to.toString(), fromCurve: curve.toString(), fromHook: hook.toString(), fromOther: other.toString() };
}

const fmt = (raw: bigint) => {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / 10n ** 18n}${frac ? `.${frac}` : ''}`;
};
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface Amount {
  /** Smallest unit (wei; $RUSHR has 18 decimals too). */
  raw: string;
  /** Whole tokens. */
  amount: string;
  usd: number | null;
}

/** The response block (pure; exported for tests). */
export function creatorTaxBody(tally: EscrowTally, live: CreatorTaxLive | null, px: { ethUsd: number | null; rushrUsd: number | null }) {
  const eth = (raw: bigint): Amount => ({ raw: raw.toString(), amount: fmt(raw), usd: px.ethUsd == null ? null : round2((Number(raw) / 1e18) * px.ethUsd) });
  const rushr = (raw: bigint): Amount => ({ raw: raw.toString(), amount: fmt(raw), usd: px.rushrUsd == null ? null : round2((Number(raw) / 1e18) * px.rushrUsd) });
  const sum = (...xs: (number | null)[]) => (xs.some((x) => x == null) ? null : round2(xs.reduce<number>((s, x) => s + x!, 0)));

  const curve = eth(BigInt(tally.fromCurve));
  const pool = eth(BigInt(tally.fromHook));
  const claimedRaw = tally.claims.reduce((s, c) => s + BigInt(c.raw), 0n);
  const claimed = eth(claimedRaw);

  // The creator's share of what the hook still holds: all of the creator tax, plus (1 - PONS share) of the fee.
  let pending: { eth: Amount; rushr: Amount; usd: number | null } | null = null;
  if (live) {
    const keep = BPS - BigInt(live.protocolFeeShareBps);
    const pe = BigInt(live.pendingCreatorTax.eth) + (BigInt(live.pendingFees.eth) * keep) / BPS;
    const pr = BigInt(live.pendingCreatorTax.rushr) + (BigInt(live.pendingFees.rushr) * keep) / BPS;
    const e = eth(pe), r = rushr(pr);
    pending = { eth: e, rushr: r, usd: sum(e.usd, r.usd) };
  }
  // Claimable now: the escrow's own balance (account-wide), else what the logs imply.
  const escrow = eth(live ? BigInt(live.escrowEth) : BigInt(tally.fromCurve) + BigInt(tally.fromHook) + BigInt(tally.fromOther) - claimedRaw);

  return {
    token: { address: RUSHR_LAUNCH.token, symbol: 'RUSHR', explorer: `${ROBINHOOD_CHAIN.explorer}/token/${RUSHR_LAUNCH.token}` },
    creator: { address: RUSHR_LAUNCH.creator, explorer: `${ROBINHOOD_CHAIN.explorer}/address/${RUSHR_LAUNCH.creator}` },
    escrow: { address: RUSHR_LAUNCH.escrow, explorer: `${ROBINHOOD_CHAIN.explorer}/address/${RUSHR_LAUNCH.escrow}` },
    /** Of the PONS fee, PONS keeps this share; the creator is credited the rest on top of the creator tax. */
    protocolFeeShareBps: live?.protocolFeeShareBps ?? null,
    earned: {
      /** Credited to the creator in the escrow from the bonding curve (before graduation; final). */
      curve,
      /** Credited to the creator in the escrow from the graduated pool's hook sweeps. */
      pool,
      /** Collected by the hook and not yet swept into the escrow (the creator's share). Null while unread. */
      pending,
      usd: sum(curve.usd, pool.usd, pending ? pending.usd : 0),
    },
    claimed: {
      eth: claimed,
      claims: tally.claims.map((c) => ({ ...c, amount: fmt(BigInt(c.raw)), explorer: `${ROBINHOOD_CHAIN.explorer}/tx/${c.tx}` })),
    },
    unclaimed: {
      /** In the escrow, claimable now (escrow.balanceOf(creator)). */
      escrow,
      /** Still in the hook; claimable once swept. */
      pending,
      usd: sum(escrow.usd, pending ? pending.usd : 0),
    },
    /** Escrow credits from other sources (another token by the same wallet). Counted in unclaimed.escrow, not in earned. */
    otherCredits: eth(BigInt(tally.fromOther)),
    /** The block and time of the hook and escrow reads (null when they have never succeeded). */
    asOf: live ? { block: live.block, at: live.at } : null,
    indexedThroughBlock: tally.cursor,
  };
}

const call = (to: string, data: string, tag: string) => ({ method: 'eth_call', params: [{ to, data }, tag] });
const toBig = (v: string | null) => {
  if (v == null) throw new Error('view call failed');
  return BigInt(v === '0x' ? 0 : v);
};

/** Read the views at the head and the escrow logs since `tally.cursor`, from one RPC. */
async function readFrom(url: string, tally: EscrowTally): Promise<{ tally: EscrowTally; live: CreatorTaxLive }> {
  const rpc = new Rpc(url);
  const head = await rpc.blockNumber();
  const tag = `0x${head.toString(16)}`;
  const pool = RUSHR_LAUNCH.poolId.slice(2);
  const eth = word('0x0').slice(2);
  const tok = word(RUSHR_LAUNCH.token).slice(2);
  const [views, logs] = await Promise.all([
    rpc.batch<string>([
      call(RUSHR_LAUNCH.escrow, `0x70a08231${word(RUSHR_LAUNCH.creator).slice(2)}`, tag), // balanceOf(creator)
      call(RUSHR_LAUNCH.hook, `0xc8eaa792${pool}${eth}`, tag), // pendingCreatorTax(poolId, ETH)
      call(RUSHR_LAUNCH.hook, `0xc8eaa792${pool}${tok}`, tag), // pendingCreatorTax(poolId, RUSHR)
      call(RUSHR_LAUNCH.hook, `0x359b4f30${pool}${eth}`, tag), // pendingFees(poolId, ETH)
      call(RUSHR_LAUNCH.hook, `0x359b4f30${pool}${tok}`, tag), // pendingFees(poolId, RUSHR)
      call(RUSHR_LAUNCH.hook, '0x9040f866', tag), // protocolFeeShareBps()
    ]),
    BigInt(tally.cursor) >= head
      ? Promise.resolve([] as RawLog[])
      : rpc.filteredLogs(BigInt(tally.cursor) + 1n, head, { address: RUSHR_LAUNCH.escrow, topics: [[CREDITED_TOPIC, CLAIMED_TOPIC], word(RUSHR_LAUNCH.creator) as never] }),
  ]);
  const [bal, ctE, ctR, feeE, feeR, share] = views.map(toBig);
  return {
    tally: tallyEscrowLogs(tally, logs, head),
    live: {
      block: head.toString(), at: new Date().toISOString(), escrowEth: bal!.toString(),
      pendingCreatorTax: { eth: ctE!.toString(), rushr: ctR!.toString() },
      pendingFees: { eth: feeE!.toString(), rushr: feeR!.toString() },
      protocolFeeShareBps: Number(share),
    },
  };
}

type Stored = EscrowTally & { live: CreatorTaxLive | null };
let memo: { at: number; value: Stored } | null = null;

/**
 * The tally and live views, refreshed at most once a minute per isolate. The tally is saved with a
 * compare-and-set on its cursor, so two isolates refreshing at once can't count a block range twice.
 * When every RPC fails, the last saved reading is served (asOf says how old).
 */
export async function creatorTaxState(sql: Sql, sources: string[]): Promise<Stored> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  const [row] = await sql<{ value: Stored }[]>`select value from indexer_state where key = ${STATE_KEY}`.catch(() => []);
  const saved: Stored = row?.value ?? { ...emptyTally(), live: null };
  for (const url of sources) {
    try {
      const { tally, live } = await readFrom(url, saved);
      const value: Stored = { ...tally, live };
      if (row) {
        await sql`update indexer_state set value = ${sql.json(value as never)}, updated_at = now()
          where key = ${STATE_KEY} and value->>'cursor' = ${saved.cursor}`.catch(() => undefined);
      } else {
        await sql`insert into indexer_state (key, value) values (${STATE_KEY}, ${sql.json(value as never)})
          on conflict (key) do nothing`.catch(() => undefined);
      }
      memo = { at: Date.now(), value };
      return value;
    } catch (err) {
      console.error('creator tax read failed', new URL(url).host, String(err).slice(0, 200));
    }
  }
  return saved;
}

/** The `creatorTax` block of GET /transparency. */
export async function creatorTax(sql: Sql, sources: string[], ethUsd: number | null) {
  const [state, [px]] = await Promise.all([
    creatorTaxState(sql, sources),
    sql<{ price_usd: string | null }[]>`select price_usd::text from tokens where address = ${RUSHR_LAUNCH.token}`.catch(() => []),
  ]);
  const rushrUsd = px?.price_usd == null ? null : Number(px.price_usd);
  return creatorTaxBody(state, state.live, { ethUsd, rushrUsd });
}

/** Tests only. */
export function resetCreatorTaxMemo() {
  memo = null;
}
