import type { Sql } from 'postgres';

/**
 * QHooks launches (qhooks.com) in the trenches. New QHooks tokens are tagged on-chain from their pool's hook
 * (the core launchpad registry, id 'qhooks'); this sync adds what the chain alone doesn't say: bonding
 * progress (progressBps / targetBps) and whether a launch has bonded. It also tags tokens indexed before
 * QHooks was in the registry. Source: `list_launches` on QHooks' public MCP (no key).
 *
 * QHooks' docs ask agents not to poll `list_launches` on a timer; this runs every few minutes from the cron
 * while we agree a feed with them (QHOOKS_SYNC=0 turns it off).
 */

/** `ref=rushr` credits Rushr as a QHooks partner on every call (MCP and REST). */
export const QHOOKS_REF = 'rushr';
export const QHOOKS_MCP = `https://qhooks.com/mcp?ref=${QHOOKS_REF}`;

export interface QHooksLaunch {
  chainId?: string;
  token?: string;
  poolId?: string;
  key?: { hooks?: string };
  progressBps?: number | null;
  targetBps?: number | null;
  bonded?: boolean;
  bondedAt?: string | number | null;
  /** Token image: an absolute URL, a path on qhooks.com, or an inline data: URI (not used). */
  logo?: string | null;
  logoURI?: string | null;
  links?: { x?: string | null; telegram?: string | null; website?: string | null } | null;
}

export interface QHooksUpdate {
  token: string;
  poolId: string | null;
  hook: string | null;
  /** 0..1 of the way to bonding; 1 once bonded. */
  progress: number;
  bonded: boolean;
  bondedAt: Date | null;
  /** Absolute https image URL, when QHooks has one. */
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}

const ADDR = /^0x[0-9a-f]{40}$/;

/** One launch → one update, or null if it isn't a Robinhood Chain token we can use. */
export function qhooksUpdate(l: QHooksLaunch): QHooksUpdate | null {
  if (String(l.chainId) !== '4663') return null;
  const token = String(l.token ?? '').toLowerCase();
  if (!ADDR.test(token)) return null;
  const target = Number(l.targetBps);
  const at = Number(l.progressBps);
  const bonded = l.bonded === true;
  const progress = bonded ? 1 : target > 0 && Number.isFinite(at) ? Math.max(0, Math.min(1, at / target)) : 0;
  const when = l.bondedAt == null ? null : new Date(typeof l.bondedAt === 'number' && l.bondedAt < 1e12 ? l.bondedAt * 1000 : l.bondedAt);
  const poolId = /^0x[0-9a-f]{64}$/i.test(String(l.poolId ?? '')) ? String(l.poolId).toLowerCase() : null;
  const hook = ADDR.test(String(l.key?.hooks ?? '').toLowerCase()) ? String(l.key!.hooks).toLowerCase() : null;
  const link = (v: unknown) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : null);
  return {
    token, poolId, hook, progress, bonded, bondedAt: when && !Number.isNaN(when.getTime()) ? when : null,
    image: absoluteImage(l.logo ?? l.logoURI ?? null),
    website: link(l.links?.website),
    twitter: link(l.links?.x),
    telegram: link(l.links?.telegram),
  };
}

/** QHooks token images: absolute https URLs as they are, qhooks.com paths made absolute, data: URIs skipped. */
export function absoluteImage(v: string | null): string | null {
  if (!v) return null;
  if (/^https:\/\//.test(v)) return v;
  if (v.startsWith('/') && !v.startsWith('//')) return `https://qhooks.com${v}`;
  return null;
}

export async function fetchQHooksLaunches(fetcher: typeof fetch = fetch): Promise<QHooksLaunch[]> {
  const r = await fetcher(QHOOKS_MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-QHooks-Client-Name': 'rushr' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'list_launches', method: 'tools/call', params: { name: 'list_launches', arguments: { chain: '4663', limit: 100 } } }),
  });
  if (!r.ok) throw new Error(`qhooks list_launches ${r.status}`);
  const b = (await r.json()) as { result?: { structuredContent?: { launches?: QHooksLaunch[] } } };
  return b.result?.structuredContent?.launches ?? [];
}

/**
 * Tags the tokens and launch pools, and sets progress / bonded. Only tokens we already index are touched
 * (the poller finds new ones on-chain). Returns how many tokens changed, and hooks not in the registry yet.
 */
export async function applyQHooks(sql: Sql, launches: QHooksLaunch[], knownHooks: readonly string[]): Promise<{ changed: number; newHooks: string[] }> {
  const ups = launches.map(qhooksUpdate).filter((u): u is QHooksUpdate => u != null);
  let changed = 0;
  for (const u of ups) {
    const res = await sql`
      update tokens set launchpad = 'qhooks', bonding_progress = ${u.progress},
        status = case when ${u.bonded} then 'migrated' else status end,
        migrated_at = case when ${u.bonded} then coalesce(migrated_at, ${u.bondedAt}, now()) else migrated_at end,
        updated_at = now()
      where address = ${u.token}
        and (launchpad is distinct from 'qhooks' or bonding_progress is distinct from ${u.progress}
             or (${u.bonded} and status is distinct from 'migrated'))`;
    changed += res.count;
    // Image and links from QHooks, only where we have none (never overwrite metadata from elsewhere).
    if (u.image || u.website || u.twitter || u.telegram)
      await sql`update tokens set image_url = coalesce(image_url, ${u.image}), website = coalesce(website, ${u.website}),
          twitter = coalesce(twitter, ${u.twitter}), telegram = coalesce(telegram, ${u.telegram})
        where address = ${u.token}
          and ((image_url is null and ${u.image}::text is not null) or (website is null and ${u.website}::text is not null)
               or (twitter is null and ${u.twitter}::text is not null) or (telegram is null and ${u.telegram}::text is not null))`;
    if (u.poolId) await sql`update pools set launchpad = 'qhooks' where id = ${u.poolId} and launchpad is distinct from 'qhooks'`;
  }
  const known = new Set(knownHooks.map((h) => h.toLowerCase()));
  const newHooks = [...new Set(ups.map((u) => u.hook).filter((h): h is string => !!h && !known.has(h)))];
  return { changed, newHooks };
}

/* ------------------------------------------------------------------ markets (every launch type) */

/**
 * QHooks' markets API lists every launch, including the auction-style ones `list_launches` leaves out. Those
 * use their own hooks per token (a launch pool and a graduated pool), so they're tagged by token address and
 * pool hooks from each market's detail, not from the hook registry.
 */
export const QHOOKS_MARKETS = 'https://qhooks.com/api/v1/markets';

export interface QHooksMarket {
  token: string;
  /** Hooks of the market's pools (launch, graduated). */
  hooks: string[];
  image: string | null;
}

interface RawMarket {
  chainId?: string;
  token?: string;
  url?: string;
}
interface RawMarketDetail {
  meta?: { token?: string; pools?: { key?: { hooks?: string } }[]; logo?: string | null; logoURI?: string | null };
}

/** One market detail → what we tag, or null if it isn't a usable Robinhood Chain token. */
export function qhooksMarket(d: RawMarketDetail): QHooksMarket | null {
  const token = String(d.meta?.token ?? '').toLowerCase();
  if (!ADDR.test(token)) return null;
  const hooks = [...new Set((d.meta?.pools ?? []).map((p) => String(p.key?.hooks ?? '').toLowerCase()).filter((h) => ADDR.test(h) && !/^0x0{40}$/.test(h)))];
  return { token, hooks, image: absoluteImage(d.meta?.logo ?? d.meta?.logoURI ?? null) };
}

/** Adds `ref=rushr` to a QHooks REST URL. */
export function withQHooksRef(url: string): string {
  const u = new URL(url);
  u.searchParams.set('ref', QHOOKS_REF);
  return u.toString();
}

export async function fetchQHooksMarkets(fetcher: typeof fetch = fetch, max = 50): Promise<QHooksMarket[]> {
  const headers = { accept: 'application/json', 'X-QHooks-Client-Name': 'rushr' };
  const r = await fetcher(withQHooksRef(QHOOKS_MARKETS), { headers });
  if (!r.ok) throw new Error(`qhooks markets ${r.status}`);
  const list = ((await r.json()) as { markets?: RawMarket[] }).markets ?? [];
  const urls = list
    .filter((m) => String(m.chainId) === '4663' && typeof m.url === 'string' && m.url.startsWith(`${QHOOKS_MARKETS}/4663/`))
    .slice(0, max)
    .map((m) => m.url!);
  const out: QHooksMarket[] = [];
  for (const u of urls) {
    try {
      const d = await fetcher(withQHooksRef(u), { headers });
      if (!d.ok) continue;
      const m = qhooksMarket((await d.json()) as RawMarketDetail);
      if (m) out.push(m);
    } catch {
      // one market failing doesn't stop the rest
    }
  }
  return out;
}

/** Tags market tokens and their pools as QHooks, fills a missing image. Returns tokens we don't index yet. */
export async function applyQHooksMarkets(sql: Sql, markets: QHooksMarket[]): Promise<{ changed: number; missing: string[] }> {
  let changed = 0;
  const missing: string[] = [];
  for (const m of markets) {
    const res = await sql`
      update tokens set launchpad = 'qhooks', image_url = coalesce(image_url, ${m.image}), updated_at = now()
      where address = ${m.token} and (launchpad is distinct from 'qhooks' or (image_url is null and ${m.image}::text is not null))
      returning address`;
    changed += res.count;
    if (!res.count) {
      const [known] = await sql`select 1 from tokens where address = ${m.token}`;
      if (!known) missing.push(m.token);
    }
    if (m.hooks.length) await sql`update pools set launchpad = 'qhooks' where token = ${m.token} and hooks = any(${m.hooks}) and launchpad is distinct from 'qhooks'`;
  }
  return { changed, missing };
}
