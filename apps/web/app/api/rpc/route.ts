import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * JSON-RPC proxy to our Alchemy endpoint for the browser: wallet balances, quotes, simulations and sending signed
 * transactions. The Alchemy URL (with its key) stays a Worker secret, RPC_URL. Clients fall back to Robinhood Chain's
 * public RPC when this answers an error (see lib/rpc.ts).
 *
 * Guard rails, since every call spends our Alchemy quota:
 * - only the methods the app uses (no eth_getLogs or tracing: those go to the public RPC);
 * - only from our own pages (Origin check; not a security boundary, it stops other sites embedding it);
 * - batches of at most 20 calls and bodies under 64 KB;
 * - a per-IP rate limit (RPC_LIMIT binding) when configured.
 */
const METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_simulateV1',
  'eth_sendRawTransaction',
  'eth_sendRawTransactionSync',
]);
const ORIGINS = new Set(['https://app.rushr.trade', 'https://rushr.trade', 'https://www.rushr.trade', 'http://localhost:3000', 'http://localhost:8790']);
const MAX_BATCH = 20;
const MAX_BYTES = 64 * 1024;

type RpcCall = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type Env = { RPC_URL?: string; RPC_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> } };

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && !ORIGINS.has(origin)) return json(rpcError(null, -32000, 'origin not allowed'), 403);

  const { env } = getCloudflareContext() as unknown as { env: Env };
  if (!env.RPC_URL) return json(rpcError(null, -32000, 'rpc not configured'), 503);

  if (env.RPC_LIMIT) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RPC_LIMIT.limit({ key: ip });
    if (!success) return json(rpcError(null, -32005, 'rate limited'), 429);
  }

  const text = await req.text();
  if (text.length > MAX_BYTES) return json(rpcError(null, -32600, 'request too large'), 413);
  let body: RpcCall | RpcCall[];
  try {
    body = JSON.parse(text) as RpcCall | RpcCall[];
  } catch {
    return json(rpcError(null, -32700, 'parse error'), 400);
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return json(rpcError(null, -32600, 'batch too large'), 400);
  const bad = calls.find((c) => typeof c?.method !== 'string' || !METHODS.has(c.method));
  // One disallowed method fails the whole request, so the client's fallback retries it on the public RPC.
  if (bad) return json(rpcError(bad?.id, -32601, `method not allowed: ${String(bad?.method)}`), 400);

  const upstream = await fetch(env.RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!upstream) return json(rpcError(null, -32000, 'upstream unavailable'), 502);
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
