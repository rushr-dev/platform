import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from '@/components/trade/csp';

/**
 * Strict CSP with a per-request nonce on the terminal, account and trade pages (/trenches, /token,
 * /settings, /me, /swap): beta trading v0 signs in the browser, see components/trade/csp.ts. Next.js reads the nonce from the request's CSP header and puts
 * it on its own scripts; these routes are dynamically rendered. The landing page is not matched.
 */
export function middleware(req: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV !== 'production', apiUrl: process.env.NEXT_PUBLIC_API_URL });
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

export const config = {
  matcher: ['/trenches', '/trenches/:path*', '/token/:path*', '/swap', '/swap/:path*', '/settings', '/settings/:path*', '/me', '/me/:path*'],
};
