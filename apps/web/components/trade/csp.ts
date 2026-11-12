/**
 * Content Security Policy for the terminal and trade pages (beta v0: the embedded wallet signs silently
 * in the browser, so an XSS on these pages must not be able to load or run anything foreign).
 *
 * - Scripts: our own bundles ('self') and inline bootstrap only with the per-request nonce (no
 *   'unsafe-inline'), plus two Cloudflare hosts: Turnstile (Privy's bot protection on sign-in) and the
 *   Web Analytics beacon Cloudflare injects at the edge (it can't carry our nonce, so no 'strict-dynamic',
 *   which would make browsers ignore host allowlists).
 * - Frames: Privy's auth iframe (it hosts the embedded wallet), WalletConnect verify, Turnstile.
 * - Connections: our API (+ live WebSocket v1/v2), the public Robinhood Chain RPC, DexScreener (pool
 *   panel fallback), Privy and WalletConnect (external-wallet sign-in), Cloudflare Web Analytics.
 * - Images: same origin (token icons and X avatars go through /api/img), data/blob, Privy, WalletConnect.
 * Based on Privy's CSP guidance (docs.privy.io/security/implementation-guide/content-security-policy).
 */
export function buildCsp(opts: { nonce: string; dev?: boolean; apiUrl?: string }): string {
  const api = (opts.apiUrl ?? 'https://api.rushr.trade').replace(/\/+$/, '');
  const ws = api.replace(/^http/, 'ws');
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${opts.nonce}'`, 'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com', ...(opts.dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https://auth.privy.io', 'https://explorer-api.walletconnect.com'],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'child-src': ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org'],
    'frame-src': ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org', 'https://challenges.cloudflare.com'],
    'connect-src': [
      "'self'",
      api,
      ws,
      'https://rpc.mainnet.chain.robinhood.com',
      'https://api.dexscreener.com',
      'https://auth.privy.io',
      'https://*.rpc.privy.systems',
      'wss://relay.walletconnect.com',
      'wss://relay.walletconnect.org',
      'wss://www.walletlink.org',
      'https://explorer-api.walletconnect.com',
      'https://cloudflareinsights.com',
      ...(opts.dev ? ['ws://localhost:*', 'http://localhost:*'] : []),
    ],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };
  const policy = Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
  return opts.dev ? policy : `${policy}; upgrade-insecure-requests`;
}

/** Fresh base64 nonce (Workers / Edge: WebCrypto only). */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}
