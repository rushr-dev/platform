import type { Sql } from 'postgres';
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { ambiguousUrls, classifyLinks, harvestPackedUrls, harvestStrings, httpCandidates, metadataUris } from '@rushr/core';
import type { Rpc } from './rpc';

const GETTERS = parseAbi([
  'function tokenURI() view returns (string)',
  'function description() view returns (string)',
  // Clanker tokens: the icon and a JSON blob with socials.
  'function imageUrl() view returns (string)',
  'function metadata() view returns (string)',
]);
const FETCH_TIMEOUT_MS = 4_000;
/** Some CDNs (anoncoin's S3/CloudFront) answer 403 to requests without a User-Agent, and Workers send none. */
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; RushrBot/1.0; +https://rushr.trade)' };

/** Outcome of a resolve: whether an icon was found, and whether trying again later may find one. */
export interface MetadataResult {
  image: boolean;
  /** The launch points at metadata or an image we couldn't load yet (e.g. an IPFS upload still propagating). */
  retry: boolean;
}

interface RawTx {
  input: Hex;
}
interface RawReceipt {
  logs: { data: Hex }[];
}

/**
 * Resolve a token's icon, socials and description from its launchpad data and store them.
 * Safe to re-run: existing values are only replaced by non-empty ones.
 */
export async function resolveMetadata(sql: Sql, rpc: Rpc, token: string, opts: { dexOnly?: boolean } = {}): Promise<MetadataResult> {
  if (opts.dexOnly) {
    const dex = await dexProfile(token);
    // Rate limited: let the queue retry later rather than recording "no icon".
    if (dex === RATE_LIMITED) throw new Error('DexScreener rate limited');
    await sql`
      update tokens set
        image_url = coalesce(image_url, ${dex?.image ?? null}),
        website = coalesce(website, ${dex?.website ?? null}),
        twitter = coalesce(twitter, ${dex?.twitter ?? null}),
        telegram = coalesce(telegram, ${dex?.telegram ?? null}),
        image_at = case when image_url is null and ${dex?.image ?? null}::text is not null then now() else image_at end,
        metadata_at = now()
      where address = ${token}`;
    return { image: Boolean(dex?.image), retry: false };
  }
  const [row] = await sql<{ name: string; symbol: string; created_block: string }[]>`
    select name, symbol, created_block from tokens where address = ${token}`;
  if (!row) return { image: false, retry: false };
  const block = BigInt(row.created_block);

  // The creation tx is the one where the token contract first emitted a log (its mint).
  const logs = await rpc.call<{ transactionHash: Hex }[]>('eth_getLogs', [
    { fromBlock: `0x${(block - 1n).toString(16)}`, toBlock: `0x${(block + 1n).toString(16)}`, address: token },
  ]);
  const hash = logs[0]?.transactionHash;

  const strings: string[] = [];
  if (hash) {
    const [tx, receipt] = await rpc.batch<RawTx | RawReceipt>([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] },
    ]);
    if (tx && 'input' in tx) strings.push(...harvestStrings(tx.input), ...harvestPackedUrls(tx.input));
    if (receipt && 'logs' in receipt) for (const l of receipt.logs) strings.push(...harvestStrings(l.data));
  }
  // Getters some launchpads expose on the token itself: tokenURI (Doppler) points at JSON (or is inline
  // JSON, or a bare CID); Clanker has imageUrl() and a metadata() JSON string.
  const fns = ['tokenURI', 'description', 'imageUrl', 'metadata'] as const;
  const raw = await rpc.batch<Hex>(
    fns.map((fn) => ({ method: 'eth_call', params: [{ to: token, data: encodeFunctionData({ abi: GETTERS, functionName: fn }) }, 'latest'] })),
  );
  const got = (i: number): string | null => {
    const r = raw[i];
    if (!r || r === '0x') return null;
    try {
      return decodeFunctionResult({ abi: GETTERS, functionName: fns[i]!, data: r }) || null;
    } catch {
      return null; // not a string getter
    }
  };
  const docs: Record<string, unknown>[] = [];
  const uris = new Set<string>();
  const tokenUri = got(0);
  if (tokenUri) uris.add(tokenUri.trim());
  const desc = got(1);
  if (desc) strings.push(desc);
  const imageUrl = got(2);
  const clankerMeta = got(3);
  if (clankerMeta) {
    try {
      const j = JSON.parse(clankerMeta) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) docs.push(j as Record<string, unknown>);
    } catch {
      strings.push(clankerMeta);
    }
  }
  if (imageUrl) docs.push({ image: imageUrl });
  for (const u of metadataUris(strings)) uris.add(u);

  // Metadata URIs and ambiguous links (IPFS content, /api/ routes, extension-less image services):
  // fetch each and go by what comes back, JSON document or image.
  const images: string[] = [];
  const documents: string[] = [];
  const toProbe = [...new Set([...uris, ...ambiguousUrls(strings)])].slice(0, 4);
  const probes = await Promise.all(toProbe.map((u) => probe(u)));
  probes.forEach((p, i) => {
    if (p?.kind === 'json') {
      docs.push(p.doc);
      documents.push(toProbe[i]!);
    } else if (p?.kind === 'image') images.push(toProbe[i]!);
  });

  const links = classifyLinks(strings, docs, { name: row.name, symbol: row.symbol }, { images, documents });
  // Plain Uniswap tokens carry no launchpad metadata; established ones often have a DexScreener profile.
  if (!links.image || !(links.website || links.twitter || links.telegram)) {
    const dex = await dexProfile(token);
    if (dex && dex !== RATE_LIMITED) {
      links.image ??= dex.image;
      links.website ??= dex.website;
      links.twitter ??= dex.twitter;
      links.telegram ??= dex.telegram;
    }
  }
  await sql`
    update tokens set
      image_at = case when image_url is null and ${links.image}::text is not null then now() else image_at end,
      image_url = coalesce(${links.image}, image_url),
      website = coalesce(${links.website}, website),
      twitter = coalesce(${links.twitter}, twitter),
      telegram = coalesce(${links.telegram}, telegram),
      description = coalesce(${links.description}, description),
      metadata_at = now()
    where address = ${token}`;
  // Something pointed at metadata or an image we couldn't load: it may just not be uploaded yet.
  const unresolved = probes.some((p) => p === null) || (uris.size > 0 && !docs.length);
  return { image: Boolean(links.image), retry: !links.image && unresolved };
}

const RATE_LIMITED = 'rate-limited' as const;

/** Icon and links from the token's DexScreener profile, if it has one. */
async function dexProfile(token: string) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${token}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: HEADERS,
    });
    // Always consume or cancel a body: an unread one keeps its connection open, and Workers allow 6.
    if (!res.ok) {
      await res.body?.cancel();
      return res.status === 429 ? RATE_LIMITED : null;
    }
    const pairs = (await res.json()) as {
      info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { url: string; type: string }[] };
    }[];
    const info = pairs.find((p) => p.info?.imageUrl || p.info?.socials?.length)?.info;
    if (!info) return null;
    const social = (type: string) => info.socials?.find((s) => s.type === type)?.url ?? null;
    return {
      image: info.imageUrl ?? null,
      website: info.websites?.[0]?.url ?? null,
      twitter: social('twitter'),
      telegram: social('telegram'),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a link and say what it is: a JSON metadata document, an image, or neither (null when nothing
 * answered, e.g. an IPFS upload that hasn't propagated). Tries each gateway for IPFS links; data:
 * URIs are decoded inline. Image bodies are never downloaded.
 */
async function probe(uri: string): Promise<{ kind: 'json'; doc: Record<string, unknown> } | { kind: 'image' } | { kind: 'other' } | null> {
  const inline = uri.match(/^data:application\/json(;base64)?,(.*)$/is);
  if (inline) {
    try {
      const doc = asObject(JSON.parse(inline[1] ? atob(inline[2]!) : decodeURIComponent(inline[2]!)));
      return doc ? { kind: 'json', doc } : { kind: 'other' };
    } catch {
      return { kind: 'other' };
    }
  }
  if (/^data:image\//i.test(uri)) return { kind: 'image' };
  for (const url of httpCandidates(uri)) {
    if (!/^https:\/\//i.test(url)) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { ...HEADERS, accept: 'application/json, image/*;q=0.9, */*;q=0.5' } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      if (/^image\//i.test(type)) {
        await res.body?.cancel();
        return { kind: 'image' };
      }
      if (Number(res.headers.get('content-length') ?? 0) > 200_000) {
        await res.body?.cancel();
        return { kind: 'other' };
      }
      const text = await res.text();
      if (text.length > 200_000) return { kind: 'other' };
      try {
        const doc = asObject(JSON.parse(text));
        return doc ? { kind: 'json', doc } : { kind: 'other' };
      } catch {
        return { kind: 'other' };
      }
    } catch {
      // timeout or network error: try the next gateway
    }
  }
  return null;
}

function asObject(j: unknown): Record<string, unknown> | null {
  return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
}
