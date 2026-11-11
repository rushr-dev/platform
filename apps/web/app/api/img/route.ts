import { httpCandidates } from '@rushr/core';

/**
 * Token icon proxy. Launchpads store icons on IPFS and assorted CDNs; public IPFS gateways are
 * slow and flaky, so we try several and let the edge cache the first good answer for a week.
 * Only raster images under 4 MB are passed through (no SVG: it can carry script).
 */
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = /^image\/(png|jpe?g|gif|webp|avif)$/i;

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get('u');
  if (!u || u.length > 2048) return new Response('bad request', { status: 400 });
  for (const url of httpCandidates(u)) {
    if (!url.startsWith('https://')) continue;
    // Public hosts only: no IP literals or local names.
    const host = new URL(url).hostname;
    if (/^[\d.]+$|^\[|localhost|\.local$|\.internal$/i.test(host)) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6_000), headers: { accept: 'image/*' } });
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !ALLOWED.test(type)) continue;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) continue;
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BYTES) continue;
      return new Response(body, {
        headers: {
          'content-type': type,
          'cache-control': 'public, max-age=86400, s-maxage=604800, immutable',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      // try the next source
    }
  }
  return new Response('not found', { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
}
