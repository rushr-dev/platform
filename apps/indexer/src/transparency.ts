// GET /transparency: where the platform fee goes, for the public Transparency page. Read-only, no per-user
// data (traders appear only as a count), served from the edge cache for 60s.
import type { Sql } from 'postgres';
import { NATIVE_ETH, QUOTES, ROBINHOOD_CHAIN } from '@rushr/core';
import { BETA_FEE_BPS, DEFAULT_TRADE_CONFIG, STANDARD_FEE_BPS } from '@rushr/trade';
import { Rpc } from './rpc';

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
export function feeTotals(rows: FeeRow[], counts: { trades: number; traders: number }): FeeTotals {
  const route = (k: 'curve' | 'uniswap') => {
    const mine = rows.filter((r) => r.route === k);
    return { trades: mine.reduce((s, r) => s + r.trades, 0), usd: round2(mine.reduce((s, r) => s + r.usd, 0)), byToken: byToken(mine) };
  };
  return { ...counts, usd: round2(rows.reduce((s, r) => s + r.usd, 0)), byToken: byToken(rows), byRoute: { curve: route('curve'), uniswap: route('uniswap') } };
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
  const [c] = await sql<{ trades: number; traders: number }[]>`
    select count(*)::int as trades, count(distinct l.trader)::int as traders from trades_ledger l
    where l.status = 'confirmed' and l.chain_id = ${CHAIN_ID} ${within}`;
  return feeTotals(rows, c ?? { trades: 0, traders: 0 });
}

/** Treasury balances, one batched RPC call, memoized per isolate for the cache window. */
let balanceMemo: { at: number; value: Record<'ETH' | 'USDG', { raw: string; amount: string }> | null } | null = null;
async function treasuryBalances(rpcUrl: string | null, treasury: string) {
  if (!rpcUrl) return balanceMemo?.value ?? null; // indexer paused: last known, else null
  if (balanceMemo && Date.now() - balanceMemo.at < TRANSPARENCY_CACHE_S * 1000) return balanceMemo.value;
  try {
    const [eth, usdg] = await new Rpc(rpcUrl).batch<string>([
      { method: 'eth_getBalance', params: [treasury, 'latest'] },
      { method: 'eth_call', params: [{ to: QUOTES.USDG, data: `0x70a08231${treasury.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'] },
    ]);
    if (eth == null || usdg == null) throw new Error('balance call failed');
    const e = BigInt(eth);
    const u = BigInt(usdg === '0x' ? 0 : usdg);
    balanceMemo = { at: Date.now(), value: { ETH: { raw: e.toString(), amount: formatUnits(e, 18) }, USDG: { raw: u.toString(), amount: formatUnits(u, 6) } } };
  } catch (err) {
    console.error('treasury balance failed', err);
    if (!balanceMemo) return null;
  }
  return balanceMemo!.value;
}

/** The whole /transparency body. `rpcUrl` null (indexer paused) skips the live balance read. */
export async function transparency(sql: Sql, rpcUrl: string | null) {
  const treasury = DEFAULT_TRADE_CONFIG.feeRecipient;
  const [[eth], [season], balances] = await Promise.all([
    sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`,
    sql<{ id: string; name: string; starts_at: Date; ends_at: Date }[]>`
      select id, name, starts_at, ends_at from seasons where now() >= starts_at and now() < ends_at order by starts_at desc limit 1`,
    treasuryBalances(rpcUrl, treasury),
  ]);
  const ethNow = eth?.value.usd ?? null;
  const [allTime, seasonTotals] = await Promise.all([
    ledgerTotals(sql, ethNow),
    season ? ledgerTotals(sql, ethNow, { from: season.starts_at, to: season.ends_at }) : null,
  ]);
  return {
    treasury: {
      address: treasury,
      explorer: `${ROBINHOOD_CHAIN.explorer}/address/${treasury}`,
      balances,
      ethUsd: ethNow,
    },
    feeRate: {
      currentBps: DEFAULT_TRADE_CONFIG.feeBps,
      standardBps: STANDARD_FEE_BPS,
      beta: DEFAULT_TRADE_CONFIG.feeBps === BETA_FEE_BPS,
      referralDiscountBps: DEFAULT_TRADE_CONFIG.referralDiscountBps,
    },
    fees: {
      source: 'trades_ledger, confirmed trades only',
      usdMethod: "USDG at face value; ETH at the trade's own swap price when indexed, else the current ETH price",
      allTime,
      season: season && seasonTotals
        ? { id: season.id, name: season.name, startsAt: season.starts_at.toISOString(), endsAt: season.ends_at.toISOString(), ...seasonTotals }
        : null,
    },
    buybacks: [] as Buyback[],
    updatedAt: new Date().toISOString(),
  };
}
