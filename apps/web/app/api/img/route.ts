import { httpCandidates } from '@rushr/core';

/**
 * Token icon proxy. Launchpads store icons on IPFS and assorted CDNs; public IPFS gateways are
 * slow and flaky, so we try several and let the edge cache the first good answer for a week.
 * Only raster images under 4 MB are passed through (no SVG: it can carry script).
 */
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = /^image\/(png|jpe?g|gif|webp|avif)$/i;
/** Some CDNs (e.g. cdn.anoncoin.it, behind most Doppler icons) answer 403 to requests without one. */
const USER_AGENT = 'Mozilla/5.0 (compatible; RushrBot/1.0; +https://rushr.trade)';

/**
 * Workers allow 6 open connections per request: every response we don't use must have its body
 * cancelled, or the next candidates queue behind it.
 */
const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get('u');
  if (!u || u.length > 2048) return new Response('bad request', { status: 400 });
  for (const url of httpCandidates(u)) {
    if (!url.startsWith('https://')) continue;
    // Public hosts only: no IP literals or local names.
    const host = new URL(url).hostname;
    if (/^[\d.]+$|^\[|localhost|\.local$|\.internal$/i.test(host)) continue;
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(6_000),
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8', 'user-agent': USER_AGENT },
      });
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      const len = Number(res.headers.get('content-length') ?? 0);
      // Not OK, not a raster image (missing type included) or too big: drop it and try the next.
      if (!res.ok || !ALLOWED.test(type) || len > MAX_BYTES) {
        await discard(res);
        continue;
      }
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BYTES || body.byteLength === 0) continue;
      return new Response(body, {
        headers: {
          'content-type': type,
          'cache-control': 'public, max-age=86400, s-maxage=604800, immutable',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      // Timeout or network error; release the body if headers had arrived, then try the next source.
      if (res && !res.bodyUsed) await discard(res);
    }
  }
  return new Response('not found', { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
}
