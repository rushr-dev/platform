import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from '@/components/trade/csp';

/** Routes with the strict per-request-nonce CSP (beta trading v0 signs in the browser, see components/trade/csp.ts). */
const CSP_ROUTES = /^\/(trenches|token|swap|settings|me|u)(\/|$)/;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** Browsers remember to use https for a year (no includeSubDomains/preload until every subdomain is https-only). */
const HSTS = 'max-age=31536000';

function isHttp(req: NextRequest): boolean {
  if (req.nextUrl.protocol === 'http:') return true;
  if (req.headers.get('x-forwarded-proto') === 'http') return true;
  return (req.headers.get('cf-visitor') ?? '').includes('"http"');
}

/**
 * 1. Plain http → https (301). Privy's embedded wallet refuses to run over http and the page crashed
 *    ("Embedded wallet is only available over HTTPS") when a phone opened http://rushr.trade.
 * 2. Strict CSP with a per-request nonce on the terminal, account and trade pages. Next.js reads the
 *    nonce from the request's CSP header and puts it on its own scripts; these routes render dynamically.
 *    The landing page gets no CSP here.
 */
export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? req.nextUrl.host;
  const local = LOCAL.test(host);
  if (!local && isHttp(req)) {
    const url = req.nextUrl.clone();
    url.protocol = 'https:';
    url.host = host;
    url.port = '';
    return NextResponse.redirect(url, 301);
  }

  let res: NextResponse;
  if (CSP_ROUTES.test(req.nextUrl.pathname)) {
    const nonce = newNonce();
    const csp = buildCsp({ nonce, dev: process.env.NODE_ENV !== 'production', apiUrl: process.env.NEXT_PUBLIC_API_URL });
    const headers = new Headers(req.headers);
    headers.set('x-nonce', nonce);
    headers.set('content-security-policy', csp);
    res = NextResponse.next({ request: { headers } });
    res.headers.set('content-security-policy', csp);
  } else {
    res = NextResponse.next();
  }
  if (!local) res.headers.set('strict-transport-security', HSTS);
  return res;
}

export const config = {
  // Every page; static files and Next's own assets are served without running this.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|webp|gif|svg|ico|mp4|webm|woff2?|txt|xml|json)$).*)'],
};
