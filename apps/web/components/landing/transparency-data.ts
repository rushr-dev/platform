import { API_URL } from '@/lib/api';

/**
 * The public transparency feed: GET /transparency on the API (apps/indexer/src/transparency.ts), cached
 * ~60s at the edge. Parsed defensively: the page renders whatever is there and shows "—" for the rest,
 * and still renders (address, rates, split) when the feed doesn't answer at all.
 */
export interface Totals {
  eth: number | null;
  usdg: number | null;
  usd: number | null;
  trades: number | null;
  traders: number | null;
}

export interface Buyback {
  date: string;
  source: string;
  spent: { token: string; amount: number | null; usd: number | null };
  bought: number | null;
  burned: number | null;
  toRewards: number | null;
  txHashes: string[];
}

export interface Transparency {
  treasury: { address: string | null; eth: number | null; usdg: number | null; usd: number | null };
  rateBps: number | null;
  beta: boolean;
  allTime: Totals & { uniswap: Totals; curve: Totals };
  season: Totals & { name: string | null; uniswap: Totals; curve: Totals };
  buybacks: Buyback[];
  updatedAt: string | null;
}

/** The platform fee treasury, as published in docs/whitepaper.md. Used until the feed answers. */
export const TREASURY = '0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3';
/** The platform fee, in basis points (1%, with 30% back as cashback), as in docs/whitepaper.md. Used until the feed answers. */
export const FEE_RATE_BPS = 100;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Amount of one fee token in a `byToken` list ([{ token: 'ETH', amount: '0.01', usd }]). */
function tokenAmount(list: unknown, token: string): number | null {
  const t = arr(list).map(obj).find((x) => str(x.token)?.toUpperCase() === token);
  return t ? num(t.amount) : null;
}

function totals(v: unknown): Totals {
  const o = obj(v);
  return {
    eth: tokenAmount(o.byToken, 'ETH'),
    usdg: tokenAmount(o.byToken, 'USDG'),
    usd: num(o.usd),
    trades: num(o.trades),
    traders: num(o.traders),
  };
}

function withRoutes(v: unknown) {
  const routes = obj(obj(v).byRoute);
  return { ...totals(v), uniswap: totals(routes.uniswap), curve: totals(routes.curve) };
}

export function parseTransparency(v: unknown): Transparency {
  const o = obj(v);
  const t = obj(o.treasury);
  const bal = obj(t.balances);
  const eth = num(obj(bal.ETH).amount);
  const usdg = num(obj(bal.USDG).amount);
  const ethUsd = num(t.ethUsd);
  const fees = obj(o.fees);
  const rate = obj(o.feeRate);
  return {
    treasury: {
      address: str(t.address),
      eth,
      usdg,
      usd: eth != null && usdg != null && ethUsd != null ? eth * ethUsd + usdg : null,
    },
    rateBps: num(rate.currentBps),
    beta: rate.beta === true,
    allTime: withRoutes(fees.allTime),
    season: { ...withRoutes(fees.season), name: str(obj(fees.season).name) },
    buybacks: arr(o.buybacks).map((b) => {
      const x = obj(b);
      const spent = obj(x.spent);
      return {
        date: str(x.date) ?? '',
        source: str(x.source) ?? '',
        spent: { token: str(spent.token) ?? '', amount: num(spent.amount), usd: num(spent.usd) },
        bought: num(obj(x.tokenAmount).amount),
        burned: num(obj(x.burned).amount),
        toRewards: num(obj(x.toRewards).amount),
        txHashes: arr(x.txHashes).flatMap((h) => (typeof h === 'string' && h ? [h] : [])),
      };
    }),
    updatedAt: str(o.updatedAt),
  };
}

/** The feed, or null while it doesn't answer. */
export async function getTransparency(): Promise<Transparency | null> {
  try {
    const r = await fetch(`${API_URL}/transparency`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return parseTransparency(await r.json());
  } catch {
    return null; // Unreachable: render without live numbers.
  }
}
