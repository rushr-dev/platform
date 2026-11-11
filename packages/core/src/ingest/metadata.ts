/**
 * Token metadata (icon, website, X, Telegram, description) from launchpad data.
 *
 * Launchpads publish it in different places:
 *   - PONS: strings inside the creation call (image ipfs://…, description, socials list)
 *   - lift.fun: a metadata URI in the launch event → JSON {image, website, x, telegram}
 *   - Doppler (and its frontends): tokenURI() → JSON in several shapes
 * So we harvest every ABI string from the creation tx and launch logs, follow anything that looks
 * like a metadata URI, and classify what we find. Unknown launchpads get the same treatment.
 */

export interface TokenLinks {
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  description: string | null;
}

const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\n\r\t]+$/u;

/**
 * Every ABI-encoded dynamic string in a hex blob, wherever it sits. Works on log data and return
 * values (word-aligned) and on calldata (offset by the 4-byte selector): both alignments are scanned.
 */
export function harvestStrings(hex: string): string[] {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  const seen = new Set<string>();
  const out: string[] = [];
  scan(raw, seen, out);
  if (raw.length > 8) scan(raw.slice(8), seen, out);
  return out;
}

function scan(data: string, seen: Set<string>, out: string[]) {
  const words = Math.floor(data.length / 64);
  for (let i = 0; i < words - 1; i++) {
    const len = parseInt(data.slice(i * 64, i * 64 + 64), 16);
    if (!Number.isFinite(len) || len < 2 || len > 4096) continue;
    const span = Math.ceil(len / 32);
    if (i + 1 + span > words) continue;
    const body = data.slice((i + 1) * 64, (i + 1) * 64 + len * 2);
    const pad = data.slice((i + 1) * 64 + len * 2, (i + 1 + span) * 64);
    if (/[^0]/.test(pad)) continue;
    let s: string;
    try {
      s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(hexToBytes(body));
    } catch {
      continue;
    }
    if (!PRINTABLE.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

const isUrl = (s: string) => /^(https?:\/\/|ipfs:\/\/|ar:\/\/)\S+$/i.test(s.trim());
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i;
const TWITTER = /^https?:\/\/(www\.)?(x|twitter)\.com\//i;
const TELEGRAM = /^https?:\/\/(www\.)?(t\.me|telegram\.(me|org))\//i;

/** Strings that likely point at a metadata JSON document. */
export function metadataUris(strings: string[]): string[] {
  return strings.filter(
    (s) => isUrl(s) && !IMAGE_EXT.test(s) && !TWITTER.test(s) && !TELEGRAM.test(s) && /(metadata|\.json|tokenuri|\/api\/)/i.test(s),
  );
}

/** Public IPFS gateways that still serve content directly, fastest first (checked Nov 2026). */
export const IPFS_GATEWAYS = ['https://4everland.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];

/** HTTP URLs to try for a link: ipfs:// and ar:// expand to gateways, http(s) passes through. */
export function httpCandidates(url: string): string[] {
  const u = url.trim();
  const cid = u.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i)?.[1] ?? u.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/i)?.[1];
  if (cid) return IPFS_GATEWAYS.map((g) => g + cid);
  if (/^ar:\/\//i.test(u)) return [`https://arweave.net/${u.slice(5)}`];
  return /^https?:\/\//i.test(u) ? [u] : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Pull links out of the many metadata JSON shapes launchpad frontends use. */
function fromJson(j: Record<string, unknown>): Partial<TokenLinks> & { links: string[] } {
  const ext = (j.extensions ?? j.properties ?? {}) as Record<string, unknown>;
  const links: string[] = [];
  for (const key of ['social_links', 'socials', 'links']) {
    const v = j[key];
    if (Array.isArray(v)) for (const x of v) links.push(str((x as { url?: unknown })?.url) ?? str(x) ?? '');
    else if (v && typeof v === 'object') for (const x of Object.values(v)) links.push(str(x) ?? '');
  }
  return {
    image: str(j.image) ?? str(j.image_uri) ?? str(j.imageUrl) ?? str(j.logo) ?? str(j.icon) ?? str(ext.image),
    website: str(j.website) ?? str(ext.website) ?? str(j.external_url) ?? str(j.url),
    twitter: str(j.twitter) ?? str(j.x) ?? str(ext.twitter) ?? str(ext.x),
    telegram: str(j.telegram) ?? str(ext.telegram),
    description: str(j.description),
    links: links.filter(Boolean),
  };
}

/** Normalise a bare handle ("@foo", "foo") into a full URL for the given network. */
function normaliseSocial(v: string | null, kind: 'twitter' | 'telegram'): string | null {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{2,40}$/.test(handle)) return null;
  return kind === 'twitter' ? `https://x.com/${handle}` : `https://t.me/${handle}`;
}

/**
 * Combine harvested strings and any fetched metadata JSON into one set of links.
 * JSON fields win; harvested strings fill the gaps.
 */
export function classifyLinks(strings: string[], docs: Record<string, unknown>[], meta: { name: string; symbol: string }): TokenLinks {
  const out: TokenLinks = { image: null, website: null, twitter: null, telegram: null, description: null };
  const loose: string[] = [];
  for (const d of docs) {
    const j = fromJson(d);
    out.image ??= j.image ?? null;
    out.website ??= j.website ?? null;
    out.twitter ??= normaliseSocial(j.twitter ?? null, 'twitter');
    out.telegram ??= normaliseSocial(j.telegram ?? null, 'telegram');
    out.description ??= j.description ?? null;
    loose.push(...j.links);
  }
  const metaUris = new Set(metadataUris(strings));
  for (const s of [...loose, ...strings].map((x) => x.trim())) {
    if (!isUrl(s) || metaUris.has(s)) continue;
    if (TWITTER.test(s)) out.twitter ??= s;
    else if (TELEGRAM.test(s)) out.telegram ??= s;
    else if (/^ipfs:\/\//i.test(s) || IMAGE_EXT.test(s) || /\/images?\//i.test(s)) out.image ??= s;
    else if (/^https?:\/\//i.test(s)) out.website ??= s;
  }
  // A free-text string that isn't the name or symbol is most likely the description.
  if (!out.description) {
    out.description =
      strings.find(
        (s) => !isUrl(s) && s.length >= 12 && s !== meta.name && s !== meta.symbol && /\s/.test(s),
      ) ?? null;
  }
  // Images keep their original form (ipfs:// included); the app serves them through its image proxy.
  if (out.image && !/^(https?|ipfs|ar):\/\//i.test(out.image)) out.image = null;
  for (const k of ['website', 'twitter', 'telegram'] as const) {
    const v = out[k];
    if (v && !/^https?:\/\//i.test(v)) out[k] = null;
  }
  if (out.description && out.description.length > 600) out.description = `${out.description.slice(0, 597)}…`;
  return out;
}
