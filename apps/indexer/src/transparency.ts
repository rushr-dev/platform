// GET /transparency: where the platform fee goes, for the public Transparency page. Read-only, no per-user
// data (traders appear only as a count), served from the edge cache for 60s.
import type { Sql } from 'postgres';
import { NATIVE_ETH, QUOTES, ROBINHOOD_CHAIN } from '@rushr/core';
import { BETA_FEE_BPS, BUYBACK_SHARE_BPS, DEFAULT_TRADE_CONFIG, LEGACY_TREASURIES, STANDARD_FEE_BPS } from '@rushr/trade';
import { Rpc } from './rpc';
import { creatorTax } from './creator-tax';

export const TRANSPARENCY_CACHE_S = 60;
const CHAIN_ID = 4663;

/** Fee tokens we can be paid in: native ETH (Universal Router and PONS curve trades) and USDG. */
const FEE_TOKENS = [
  { symbol: 'ETH', address: NATIVE_ETH.toLowerCase(), decimals: 18 },
  { symbol: 'USDG', address: QUOTES.USDG, decimals: 6 },
] as const;

/**
 * One $RUSHR buyback (filled from the $RUSHR launch on; empty until then). Amounts are decimal strings in
 * the token's smallest unit, so nothing loses precision in JSON.
 */
export interface Buyback {
  /** When the buyback executed (ISO 8601). */
  date: string;
  /** What paid for it: the platform fee, or the creator tax on $RUSHR's own trades. */
  source: 'platform_fees' | 'creator_tax';
  /** What was spent: fee token (ETH or USDG) and amount. */
  spent: { token: 'ETH' | 'USDG'; raw: string; amount: string; usd: number | null };
  /** $RUSHR bought (raw, 18 decimals) and its human amount. */
  tokenAmount: { raw: string; amount: string };
  /** Of tokenAmount: sent to the burn address. */
  burned: { raw: string; amount: string };
  /** Of tokenAmount: sent to the rewards pool. */
  toRewards: { raw: string; amount: string };
  /** Every transaction involved (swap, burn, rewards transfer). */
  txHashes: string[];
}

/**
 * Platform-fee buybacks, newest first, each from its on-chain transactions (the treasury Safe's
 * execTransaction). Added by hand when one executes.
 */
export const PLATFORM_BUYBACKS: Buyback[] = [
  {
    // 25% of all platform fees to date (0.0543 ETH): bought on the $RUSHR v4 pool, output taken straight to 0x…dEaD.
    date: '2026-11-19T13:53:43.000Z',
    source: 'platform_fees',
    spent: { token: 'ETH', raw: '13570000000000000', amount: '0.01357', usd: 24.5 },
    tokenAmount: { raw: '1173460660358976450780371', amount: '1173460.660358976450780371' },
    burned: { raw: '1173460660358976450780371', amount: '1173460.660358976450780371' },
    toRewards: { raw: '0', amount: '0' },
    txHashes: ['0xe296269a004477357262964e3e4c920c5bedf17bccce437b0e2acd108ec3bcc6'],
  },
];

export interface TokenTotal {
  token: 'ETH' | 'USDG';
  address: string;
  /** Sum of fee_amount in the token's smallest unit. */
  raw: string;
  /** The same, in whole tokens. */
  amount: string;
  /** USD at trade time where we know it (see usdMethod). */
  usd: number;
}

export interface FeeTotals {
  trades: number;
  traders: number;
  /** USD traded through Rushr: each confirmed trade's indexed swap value (trades not indexed yet count 0). */
  volumeUsd: number;
  usd: number;
  byToken: TokenTotal[];
  /** Curve = PONS bonding curves (fee paid as a follow-up transfer); uniswap = Universal Router routes. */
  byRoute: Record<'curve' | 'uniswap', { trades: number; usd: number; byToken: TokenTotal[] }>;
}

export interface FeeRow {
  fee_token: string | null;
  route: 'curve' | 'uniswap';
  trades: number;
  raw: string;
  usd: number;
}

/** Format a raw integer amount (pure; exported for tests). */
export function formatUnits(raw: string | bigint, decimals: number): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function byToken(rows: FeeRow[]): TokenTotal[] {
  return FEE_TOKENS.map((t) => {
    const mine = rows.filter((r) => (r.fee_token ?? '').toLowerCase() === t.address);
    const raw = mine.reduce((s, r) => s + BigInt(r.raw), 0n);
    return { token: t.symbol, address: t.address, raw: raw.toString(), amount: formatUnits(raw, t.decimals), usd: round2(mine.reduce((s, r) => s + r.usd, 0)) };
  });
}

/** Group ledger sums into the response shape (pure; exported for tests). */
export function feeTotals(rows: FeeRow[], counts: { trades: number; traders: number; volumeUsd?: number }): FeeTotals {
  const route = (k: 'curve' | 'uniswap') => {
    const mine = rows.filter((r) => r.route === k);
    return { trades: mine.reduce((s, r) => s + r.trades, 0), usd: round2(mine.reduce((s, r) => s + r.usd, 0)), byToken: byToken(mine) };
  };
  return { ...counts, volumeUsd: round2(counts.volumeUsd ?? 0), usd: round2(rows.reduce((s, r) => s + r.usd, 0)), byToken: byToken(rows), byRoute: { curve: route('curve'), uniswap: route('uniswap') } };
}

/**
 * Confirmed ledger rows, optionally within [from, to). USD: USDG fees at face value; ETH fees at the ETH
 * price of the trade's own indexed swap (usd / ETH amount), else the current ETH price.
 */
async function ledgerTotals(sql: Sql, ethNow: number | null, range?: { from: Date; to: Date }): Promise<FeeTotals> {
  const within = range ? sql`and l.ts >= ${range.from} and l.ts < ${range.to}` : sql``;
  const rows = await sql<FeeRow[]>`
    select lower(l.fee_token) as fee_token,
      case when l.venue like 'pons%' then 'curve' else 'uniswap' end as route,
      count(*)::int as trades,
      coalesce(sum(l.fee_amount), 0)::text as raw,
      coalesce(sum(case
        when lower(l.fee_token) = ${QUOTES.USDG} then l.fee_amount / 1e6
        else l.fee_amount / 1e18 * coalesce(px.eth_usd, ${ethNow ?? 0}) end), 0)::float8 as usd
    from trades_ledger l
    left join lateral (
      select s.usd / (s.quote_amount / 1e18) as eth_usd from swaps s
      where s.tx = l.tx_hash and s.quote in (${NATIVE_ETH.toLowerCase()}, ${QUOTES.WETH}) and s.usd > 0 and s.quote_amount > 0
      limit 1
    ) px on true
    where l.status = 'confirmed' and l.chain_id = ${CHAIN_ID} and l.fee_amount is not null ${within}
    group by 1, 2`;
  // Volume: the trade's own indexed swap (the largest leg, for routes with several swaps in one tx).
  const [c] = await sql<{ trades: number; traders: number; volume_usd: number }[]>`
    select count(*)::int as trades, count(distinct l.trader)::int as traders, coalesce(sum(v.usd), 0)::float8 as volume_usd
    from trades_ledger l
    left join lateral (select s.usd from swaps s where s.tx = l.tx_hash and s.usd > 0 order by s.usd desc limit 1) v on true
    where l.status = 'confirmed' and l.chain_id = ${CHAIN_ID} ${within}`;
  return feeTotals(rows, c ? { trades: c.trades, traders: c.traders, volumeUsd: c.volume_usd } : { trades: 0, traders: 0 });
}

/**
 * Treasury balances, one batched call per source: the chain's public RPC first (free), then our Alchemy
 * URL (skipped while paused). The public RPC rate-limits Cloudflare's shared egress, so it often fails
 * from a Worker. The last good reading is kept in indexer_state ('treasury_balances') and served with its
 * time when every source fails; memoized per isolate for the cache window.
 */
type Amt = { raw: string; amount: string };
/**
 * Totals across the current treasury (a Safe) and the legacy ones, plus each account. Legacy accounts stay in
 * the total until they're emptied (the first one, an EOA, held dust after the switch to the Safe).
 */
type Balances = {
  ETH: Amt;
  USDG: Amt;
  at: string;
  accounts?: { address: string; role: 'current' | 'legacy'; ETH: Amt; USDG: Amt }[];
};
let balanceMemo: { at: number; value: Balances } | null = null;

const amt = (v: bigint, d: number): Amt => ({ raw: v.toString(), amount: formatUnits(v, d) });

export async function readBalances(rpcUrl: string, treasury: string): Promise<Balances> {
  const addrs = [treasury, ...LEGACY_TREASURIES.filter((a) => a.toLowerCase() !== treasury.toLowerCase())];
  const res = await new Rpc(rpcUrl).batch<string>(addrs.flatMap((a) => [
    { method: 'eth_getBalance', params: [a, 'latest'] },
    { method: 'eth_call', params: [{ to: QUOTES.USDG, data: `0x70a08231${a.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'] },
  ]));
  if (res.some((r) => r == null)) throw new Error('balance call failed');
  const accounts = addrs.map((address, i) => {
    const e = BigInt(res[2 * i]!);
    const u = BigInt(res[2 * i + 1] === '0x' ? 0 : res[2 * i + 1]!);
    return { address, role: (i === 0 ? 'current' : 'legacy') as 'current' | 'legacy', ETH: amt(e, 18), USDG: amt(u, 6), e, u };
  });
  return {
    ETH: amt(accounts.reduce((s, a) => s + a.e, 0n), 18),
    USDG: amt(accounts.reduce((s, a) => s + a.u, 0n), 6),
    at: new Date().toISOString(),
    accounts: accounts.map(({ e: _e, u: _u, ...a }) => a),
  };
}

async function treasuryBalances(sql: Sql, sources: string[], treasury: string): Promise<Balances | null> {
  if (balanceMemo && Date.now() - balanceMemo.at < TRANSPARENCY_CACHE_S * 1000) return balanceMemo.value;
  for (const url of sources) {
    try {
      const value = await readBalances(url, treasury);
      balanceMemo = { at: Date.now(), value };
      await sql`insert into indexer_state (key, value) values ('treasury_balances', ${sql.json(value as never)})
        on conflict (key) do update set value = excluded.value, updated_at = now()`.catch(() => undefined);
      return value;
    } catch (err) {
      console.error('treasury balance failed', new URL(url).host, String(err).slice(0, 200));
    }
  }
  const [last] = await sql<{ value: Balances }[]>`select value from indexer_state where key = 'treasury_balances'`.catch(() => []);
  return last?.value ?? balanceMemo?.value ?? null;
}

/**
 * Cashback totals per fee token (raw units): accrued on confirmed trades, paid from the Safe, and in a batch
 * waiting for its signers. No wallets in the output.
 */
async function cashbackTotals(sql: Sql) {
  const rows = await sql<{ fee_token: string; accrued: string; paid: string; pending: string; traders: number }[]>`
    with a as (select lower(fee_token) as fee_token, sum(cashback_accrual) as accrued, count(distinct trader)::int as traders
      from trades_ledger where status = 'confirmed' and cashback_accrual > 0 group by 1),
    p as (select lower(fee_token) as fee_token, coalesce(sum(amount) filter (where status = 'paid'), 0) as paid,
      coalesce(sum(amount) filter (where status = 'pending'), 0) as pending from cashback_payouts group by 1)
    select a.fee_token, a.accrued::text, coalesce(p.paid, 0)::text as paid, coalesce(p.pending, 0)::text as pending, a.traders
    from a left join p using (fee_token)`.catch(() => []);
  return rows.map((r) => ({ feeToken: r.fee_token, accrued: r.accrued, paid: r.paid, pending: r.pending, traders: r.traders }));
}

/** The whole /transparency body. `rpcUrls`: where to read chain state, in order (see treasuryBalances). */
export async function transparency(sql: Sql, rpcUrls: string[] = [ROBINHOOD_CHAIN.publicRpc]) {
  const treasury = DEFAULT_TRADE_CONFIG.feeRecipient;
  const [[eth], [season], balances] = await Promise.all([
    sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`,
    sql<{ id: string; name: string; starts_at: Date; ends_at: Date }[]>`
      select id, name, starts_at, ends_at from seasons where now() >= starts_at and now() < ends_at order by starts_at desc limit 1`,
    treasuryBalances(sql, rpcUrls, treasury),
  ]);
  const ethNow = eth?.value.usd ?? null;
  const [allTime, seasonTotals, tax, cashback] = await Promise.all([
    ledgerTotals(sql, ethNow),
    season ? ledgerTotals(sql, ethNow, { from: season.starts_at, to: season.ends_at }) : null,
    creatorTax(sql, rpcUrls, ethNow),
    cashbackTotals(sql),
  ]);
  return {
    treasury: {
      address: treasury,
      explorer: `${ROBINHOOD_CHAIN.explorer}/address/${treasury}`,
      /** Earlier treasuries: fees paid to them still count, and their balances are in balances' totals. */
      legacy: LEGACY_TREASURIES.map((a) => ({ address: a, explorer: `${ROBINHOOD_CHAIN.explorer}/address/${a}` })),
      balances,
      ethUsd: ethNow,
    },
    feeRate: {
      currentBps: DEFAULT_TRADE_CONFIG.feeBps,
      standardBps: STANDARD_FEE_BPS,
      beta: DEFAULT_TRADE_CONFIG.feeBps === BETA_FEE_BPS,
      referralDiscountBps: DEFAULT_TRADE_CONFIG.referralDiscountBps,
      /** Where each collected fee goes, in bps of the fee. A referrer's share comes out of the treasury's part. */
      split: {
        cashbackBps: DEFAULT_TRADE_CONFIG.cashbackShareBps,
        buybackBps: BUYBACK_SHARE_BPS,
        treasuryBps: 10_000 - DEFAULT_TRADE_CONFIG.cashbackShareBps - BUYBACK_SHARE_BPS,
        referrerBps: DEFAULT_TRADE_CONFIG.referrerShareBps,
      },
    },
    /** Cashback to traders (raw units per fee token): accrued per trade, paid weekly from the treasury Safe. */
    cashback: { schedule: 'weekly', byToken: cashback },
    fees: {
      source: 'trades_ledger, confirmed trades only',
      usdMethod: "USDG at face value; ETH at the trade's own swap price when indexed, else the current ETH price",
      allTime,
      season: season && seasonTotals
        ? { id: season.id, name: season.name, startsAt: season.starts_at.toISOString(), endsAt: season.ends_at.toISOString(), ...seasonTotals }
        : null,
    },
    /** $RUSHR creator tax: earned, claimed and unclaimed by the creator wallet (creator-tax.ts). */
    creatorTax: tax,
    buybacks: PLATFORM_BUYBACKS,
    updatedAt: new Date().toISOString(),
  };
}
