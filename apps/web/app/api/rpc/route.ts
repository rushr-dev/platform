import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * JSON-RPC proxy to our Alchemy endpoint for the browser: wallet balances, quotes, simulations and sending signed
 * transactions. The Alchemy URL (with its key) stays a Worker secret, RPC_URL. It is the app's only RPC: there is no
 * fallback to Robinhood Chain's public RPC (lib/rpc.ts), and Privy's wallet uses it too (components/terminal/auth).
 *
 * Guard rails, since every call spends our Alchemy quota:
 * - only the methods the app uses (no tracing); eth_getLogs only for one contract over at most 10,000 blocks;
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
  'eth_getBlockByHash',
  'eth_getLogs',
  'net_version',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_simulateV1',
  'eth_sendRawTransaction',
  'eth_sendRawTransactionSync',
]);
// Privy's embedded wallet runs in an auth.privy.io frame and may make its RPC calls from there.
const ORIGINS = new Set(['https://app.rushr.trade', 'https://rushr.trade', 'https://www.rushr.trade', 'https://auth.privy.io', 'http://localhost:3000', 'http://localhost:8790']);
/** eth_getLogs: one address, a bounded block range (finding a pool's Initialize event needs 10,000). */
const MAX_LOG_BLOCKS = 10_000n;
const MAX_BATCH = 20;
const MAX_BYTES = 64 * 1024;

type RpcCall = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type Env = { RPC_URL?: string; RPC_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> } };

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
/** CORS for the allowed origins other than our own pages (Privy's frame). Same-origin calls don't need it. */
const cors = (origin: string | null): Record<string, string> =>
  origin && ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin' } : {};
const json = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) } });

/** A getLogs filter we serve: a single contract address, and either a block hash or a range of at most MAX_LOG_BLOCKS. */
function logsOk(params: unknown): boolean {
  const f = Array.isArray(params) ? (params[0] as { address?: unknown; fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown } | undefined) : undefined;
  if (!f || typeof f.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(f.address)) return false;
  if (typeof f.blockHash === 'string') return true;
  const n = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
  const from = n(f.fromBlock);
  const to = n(f.toBlock);
  return from != null && to != null && to >= from && to - from <= MAX_LOG_BLOCKS;
}

export function OPTIONS(req: Request) {
  const origin = req.headers.get('origin');
  return new Response(null, { status: origin && ORIGINS.has(origin) ? 204 : 403, headers: cors(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && !ORIGINS.has(origin)) return json(origin, rpcError(null, -32000, 'origin not allowed'), 403);

  const { env } = getCloudflareContext() as unknown as { env: Env };
  if (!env.RPC_URL) return json(origin, rpcError(null, -32000, 'rpc not configured'), 503);

  if (env.RPC_LIMIT) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RPC_LIMIT.limit({ key: ip });
    if (!success) return json(origin, rpcError(null, -32005, 'rate limited'), 429);
  }

  const text = await req.text();
  if (text.length > MAX_BYTES) return json(origin, rpcError(null, -32600, 'request too large'), 413);
  let body: RpcCall | RpcCall[];
  try {
    body = JSON.parse(text) as RpcCall | RpcCall[];
  } catch {
    return json(origin, rpcError(null, -32700, 'parse error'), 400);
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return json(origin, rpcError(null, -32600, 'batch too large'), 400);
  const bad = calls.find((c) => typeof c?.method !== 'string' || !METHODS.has(c.method) || (c.method === 'eth_getLogs' && !logsOk(c.params)));
  if (bad) return json(origin, rpcError(bad?.id, -32601, `method not allowed: ${String(bad?.method)}`), 400);

  const upstream = await fetch(env.RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!upstream) return json(origin, rpcError(null, -32000, 'upstream unavailable'), 502);
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) } });
}
