/**
 * Market data for established tokens from DexScreener's public API. Our indexer only covers the
 * pools it has seen since it started, so for big, older tokens (many pools, several DEXes) we take
 * price, market cap, volume, liquidity, icon and links from here instead.
 */

export interface DexToken {
  address: string;
  symbol: string;
  name: string;
  price_usd: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number;
  liquidity_usd: number;
  change_24h: number | null;
  image_url: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}

interface Pair {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { url: string; type: string }[] };
}

/**
 * DexScreener serves token icons at 800px by default; ask its CDN for a small square instead,
 * since we only ever draw them as avatars.
 */
function iconUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== 'cdn.dexscreener.com') return url;
    u.searchParams.set('width', '128');
    u.searchParams.set('height', '128');
    u.searchParams.set('quality', '90');
    u.searchParams.set('format', 'auto');
    return u.toString();
  } catch {
    return url;
  }
}

/** All pairs for up to 30 tokens, folded into one row per token (volume and liquidity summed over pairs). */
export async function getDexTokens(addresses: string[], revalidate = 60): Promise<Record<string, DexToken>> {
  const out: Record<string, DexToken> = {};
  if (!addresses.length) return out;
  let pairs: Pair[] = [];
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses.slice(0, 30).join(',')}`, {
      next: { revalidate },
    });
    if (!res.ok) return out;
    pairs = ((await res.json()) as { pairs?: Pair[] | null }).pairs ?? [];
  } catch {
    return out;
  }
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  // Deepest pool first, so its price, change and metadata win.
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  for (const p of pairs) {
    if (p.chainId !== 'robinhood') continue;
    const address = p.baseToken.address.toLowerCase();
    if (!wanted.has(address)) continue;
    const row = (out[address] ??= {
      address,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      price_usd: p.priceUsd ? Number(p.priceUsd) : null,
      market_cap_usd: p.marketCap ?? p.fdv ?? null,
      volume_24h_usd: 0,
      liquidity_usd: 0,
      change_24h: p.priceChange?.h24 ?? null,
      image_url: null,
      website: null,
      twitter: null,
      telegram: null,
    });
    row.volume_24h_usd += p.volume?.h24 ?? 0;
    row.liquidity_usd += p.liquidity?.usd ?? 0;
    row.image_url ??= iconUrl(p.info?.imageUrl);
    row.website ??= p.info?.websites?.[0]?.url ?? null;
    row.twitter ??= p.info?.socials?.find((s) => s.type === 'twitter')?.url ?? null;
    row.telegram ??= p.info?.socials?.find((s) => s.type === 'telegram')?.url ?? null;
  }
  return out;
}
