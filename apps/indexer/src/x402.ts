// x402 paid data: deeper reads than the free API (paid-data.ts), paid per call in USDG on Robinhood Chain
// (eip155:4663) with the x402 v2 "exact" scheme. The Priors facilitator verifies and settles (USDG's signed
// transferWithAuthorization, straight from the payer to X402_PAY_TO); we only call it with our merchant key.
//
//   GET /x402                                     402 with the payment details and the list of paid endpoints
//   GET /.well-known/x402                         the same list as a manifest (draft-hawkins-x402-dns-discovery)
//   GET /x402/tokens/:address/report              $0.01  one-call due diligence
//   GET /x402/tokens/:address/holder-graph        $0.03  top 100 holders, every link, clusters
//   GET /x402/tokens/:address/holder-quality      $0.03  top 100 holders' PnL, win rate and entry
//
// An agent is only charged when we answer below 400 (the middleware settles after the handler, and skips errors).
// Everything free today stays free: these are new, heavier reads. Paid responses are never cached at the edge.
import { Hono, type MiddlewareHandler } from 'hono';
import postgres, { type Sql } from 'postgres';
import { paymentMiddleware } from '@x402/hono';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { dbUrl, type Env } from './env';
import { holderGraph, holderQuality, tokenReport } from './paid-data';

const NETWORK = 'eip155:4663' as const; // Robinhood Chain; the SDK prices "$…" in USDG here
const FACILITATOR = 'https://facilitator.priors.trade';
const ORIGIN = 'https://api.rushr.trade';
const DOCS = 'https://docs.rushr.trade/agents/paid-data/';
const SAMPLE = '0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed'; // $RUSHR

export const PAID = [
  {
    path: 'report',
    price: '$0.01',
    name: 'Token report',
    description:
      'One-call due diligence for a Robinhood Chain token: market data, risk verdict and signals, dev record, holder clusters and holder quality.',
  },
  {
    path: 'holder-graph',
    price: '$0.03',
    name: 'Holder graph',
    description:
      'Top 100 holders of a Robinhood Chain token with every shared-funder, funding and transfer link, funders two hops up, and clusters with their share of supply.',
  },
  {
    path: 'holder-quality',
    price: '$0.03',
    name: 'Holder quality',
    description:
      "Who holds a Robinhood Chain token and how they trade: the top 100 holders' realized PnL, win rate and entry, plus supply held by profitable, fresh, sniper and insider wallets.",
  },
] as const;

type Ctx = { Bindings: Env; Variables: { sql: Sql } };
const ADDRESS = /^0x[0-9a-f]{40}$/;
const NO_STORE = { 'cache-control': 'private, no-store' };

/** The endpoint list, for /x402 and the manifest. */
const endpoints = () =>
  PAID.map((p) => ({
    url: `${ORIGIN}/x402/tokens/{address}/${p.path}`,
    example: `${ORIGIN}/x402/tokens/${SAMPLE}/${p.path}`,
    method: 'GET',
    price: p.price,
    asset: 'USDG',
    network: NETWORK,
    name: p.name,
    description: p.description,
    input: { address: 'token contract address on Robinhood Chain (0x…, 40 hex)' },
    mimeType: 'application/json',
  }));

function resourceServer(env: Env) {
  const client = new HTTPFacilitatorClient({
    url: env.X402_FACILITATOR_URL ?? FACILITATOR,
    createAuthHeaders: async () => {
      const h = { Authorization: `Bearer ${env.PRIORS_API_KEY}` };
      return { verify: h, settle: h, supported: h };
    },
  });
  return new x402ResourceServer(client).register(NETWORK, new ExactEvmScheme());
}

/**
 * Built per request: the middleware starts its facilitator sync (GET /supported) when it's created, and a Worker
 * can't await I/O that another request started, so nothing here is shared across requests.
 */
function payments(env: Env) {
  const server = resourceServer(env);
  const routes = Object.fromEntries(
    PAID.map((p) => [
      `GET /x402/tokens/:address/${p.path}`,
      {
        accepts: { scheme: 'exact', price: p.price, network: NETWORK, payTo: env.X402_PAY_TO!, maxTimeoutSeconds: 120 },
        description: p.description,
        mimeType: 'application/json',
      },
    ]),
  );
  return { server, middleware: (): MiddlewareHandler => paymentMiddleware(routes, server) };
}

const ready = (env: Env) => Boolean(env.PRIORS_API_KEY && env.X402_PAY_TO && /^0x[0-9a-fA-F]{40}$/.test(env.X402_PAY_TO));

export const x402 = new Hono<Ctx>();

/** Discovery manifest (draft-hawkins-x402-dns-discovery-03): public, cacheable. */
x402.get('/.well-known/x402', (c) =>
  c.json(
    {
      x402Version: 2,
      kind: 'resource-server',
      name: 'Rushr data API',
      description: "Robinhood Chain token data from Rushr's own index, paid per call in USDG. Data, not advice.",
      resources: endpoints().map((e) => ({ url: e.example, method: e.method, description: `${e.name} (${e.price} USDG): ${e.description}` })),
      endpoints: endpoints(),
      docs: DOCS,
      contact: 'team@rushr.trade',
      updated: '2026-11-27T00:00:00Z',
    },
    200,
    { 'cache-control': 'public, max-age=300, s-maxage=300', 'access-control-allow-origin': '*' },
  ),
);

/**
 * The base URL: answers 402 like any paid route (a valid PAYMENT-REQUIRED for the cheapest endpoint, on $RUSHR), with
 * the list of paid endpoints in the body. Nothing is sold here; pay one of the endpoints below.
 */
x402.get('/x402', async (c) => {
  if (!ready(c.env)) return c.json({ error: 'paid data is not open yet', endpoints: endpoints(), docs: DOCS }, 503, NO_STORE);
  const { server } = payments(c.env);
  await server.initialize();
  const cheapest = PAID[0];
  const requirements = await server.buildPaymentRequirements({ scheme: 'exact', price: cheapest.price, network: NETWORK, payTo: c.env.X402_PAY_TO!, maxTimeoutSeconds: 120 });
  const required = await server.createPaymentRequiredResponse(
    requirements,
    { url: `${ORIGIN}/x402/tokens/${SAMPLE}/${cheapest.path}`, description: cheapest.description, mimeType: 'application/json' },
    'Payment required. Rushr sells token data per call; pick an endpoint below.',
  );
  return c.json(
    { ...required, name: 'Rushr data API', endpoints: endpoints(), docs: DOCS, free: 'https://docs.rushr.trade/agents/' },
    402,
    { ...NO_STORE, 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required), 'access-control-expose-headers': 'PAYMENT-REQUIRED' },
  );
});

// Bad addresses fail before payment, so nobody pays for a typo.
x402.use('/x402/tokens/:address/*', async (c, next) => {
  if (!ADDRESS.test(c.req.param('address').toLowerCase())) return c.json({ error: 'bad address: use the token contract (0x + 40 hex)' }, 422, NO_STORE);
  if (!PAID.some((p) => c.req.path.endsWith(`/${p.path}`))) return c.json({ error: 'not found', endpoints: endpoints() }, 404, NO_STORE);
  if (!ready(c.env)) return c.json({ error: 'paid data is not open yet', docs: DOCS }, 503, NO_STORE);
  return payments(c.env).middleware()(c, next);
});

// Paid handlers: a connection per request, like the free API.
x402.use('/x402/tokens/:address/*', async (c, next) => {
  const sql = postgres(dbUrl(c.env), { max: 2, fetch_types: false, prepare: false });
  c.set('sql', sql);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end({ timeout: 5 }));
  }
});

const handlers = { report: tokenReport, 'holder-graph': holderGraph, 'holder-quality': holderQuality } as const;
for (const p of PAID) {
  x402.get(`/x402/tokens/:address/${p.path}`, async (c) => {
    const token = c.req.param('address').toLowerCase();
    const body = await handlers[p.path](c.var.sql, token);
    // 404 is never charged: a token we don't index yet costs nothing.
    if (!body) return c.json({ error: 'token not indexed by Rushr', address: token }, 404, NO_STORE);
    return c.json(body, 200, NO_STORE);
  });
}
