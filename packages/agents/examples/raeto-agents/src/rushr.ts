import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config';

/** Rushr's public API and the on-chain side of a trade (sign and send from the agent's own wallet). */

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});
export const account = privateKeyToAccount(config.privateKey);
const wallet = createWalletClient({ account, chain: robinhood, transport: http(config.rpcUrl) });
export const chain = createPublicClient({ chain: robinhood, transport: http(config.rpcUrl) });

/** Where a trade may go: the Uniswap Universal Router, or (curve trades) the curve the quote named. */
const UNIVERSAL_ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498';
const TREASURY = '0x2ae062c61a757b66d3039154a6e965aa48cd75f3';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: unknown) {
    super(`${status} ${code}: ${message}`);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const r = await fetch(`${config.rushrApi}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!r.ok) throw new ApiError(r.status, json.error?.code ?? 'http_error', json.error?.message ?? r.statusText, json);
  return json as T;
}

export interface TokenCard {
  address: string;
  symbol: string;
  name: string;
  status: 'new' | 'bonding' | 'migrated';
  created_at: string;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  holders: number;
  bonding_progress: number | null;
  risk: 'low' | 'medium' | 'high' | 'unknown' | null;
  verdict: string | null;
  top10_pct: number | null;
  dev_pct: number | null;
  snipers_pct: number | null;
  bundled_pct: number | null;
  liquidity_usd?: number | null;
  buys_24h?: number | null;
  sells_24h?: number | null;
}

export interface Holding {
  token: string;
  symbol: string;
  amount: string;
  value_usd: number | null;
  cost_basis_usd: number | null;
  unrealized_usd: number | null;
}

export const trenches = (column: 'new' | 'almost' | 'migrated', limit = 25) =>
  api<{ tokens: TokenCard[] }>('GET', `/tokens?column=${column}&limit=${limit}&hideHighRisk=1`, undefined, false).then((r) => r.tokens);

export const safety = (token: string) =>
  api<{ safety: { riskLevel: string; verdict: string; flags: string[]; blocked: boolean } }>('GET', `/v1/tokens/${token}/safety`).then((r) => r.safety);

export const holdings = () =>
  api<{ holdings: Holding[] }>('GET', `/wallets/${account.address.toLowerCase()}/holdings`, undefined, false).then((r) => r.holdings);

export const postCall = (token: string, stance: 'bullish' | 'bearish', body: string) =>
  api<{ callout: { id: string } }>('POST', '/v1/callouts', { token, stance, body });

interface Tx { to: string; data: Hex; value: string; chainId?: number; gas?: string }
interface Build {
  tx: Tx;
  approvals: { tx: Tx; kind: string; spender: string }[];
  followUp: { kind: 'rushr_fee'; tx: Tx } | null;
  quote: { amountOut: string; minAmountOut: string; priceImpactBps: number; pool: { venue: string; curve?: string } };
  simulation: { ok: boolean; error: string | null } | null;
}

async function send(tx: Tx): Promise<Hex> {
  const hash = await wallet.sendTransaction({ to: tx.to as `0x${string}`, data: tx.data, value: BigInt(tx.value), gas: tx.gas ? BigInt(tx.gas) : undefined });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

/**
 * Quote, build with a dry run, check everything the docs say to check, then sign and send. In DRY_RUN mode it
 * stops after the checks. `amountIn` is wei for buys, token base units for sells.
 */
export async function trade(token: string, side: 'buy' | 'sell', amountIn: bigint): Promise<string> {
  const body = { token, side, amountIn: amountIn.toString(), quoteAsset: 'ETH', from: account.address.toLowerCase(), simulate: true };
  const b = await api<Build>('POST', '/v1/trade/build', body);
  const curve = b.quote.pool.venue === 'pons-curve' ? b.quote.pool.curve?.toLowerCase() : null;
  const to = b.tx.to.toLowerCase();
  // The checks from docs.rushr.trade/agents/quickstart ("Before you sign").
  if (b.tx.chainId !== undefined && b.tx.chainId !== 4663) throw new Error('wrong chain');
  if (to !== UNIVERSAL_ROUTER && to !== curve) throw new Error(`unexpected tx.to ${to}`);
  if (side === 'buy' && BigInt(b.tx.value) !== amountIn) throw new Error('tx.value does not match the buy amount');
  if (side === 'sell' && BigInt(b.tx.value) !== 0n) throw new Error('a sell must not send ETH');
  for (const a of b.approvals) {
    const spender = a.spender.toLowerCase();
    if (spender !== PERMIT2 && spender !== UNIVERSAL_ROUTER && spender !== curve) throw new Error(`unexpected approval spender ${spender}`);
  }
  if (b.followUp && b.followUp.tx.to.toLowerCase() !== TREASURY) throw new Error('fee follow-up must go to the Rushr treasury');
  if (!b.simulation?.ok) throw new Error(`simulation failed: ${b.simulation?.error ?? 'none'}`);

  const what = `${side} ${token} (${b.quote.pool.venue}, impact ${b.quote.priceImpactBps / 100}%)`;
  if (config.dryRun) return `[dry run] would ${what}`;
  for (const a of b.approvals) await send(a.tx);
  const hash = await send(b.tx);
  if (b.followUp) {
    // Bonding-curve trades pay the Rushr fee as a second transfer after the trade confirms.
    const feeHash = await send(b.followUp.tx);
    await api('POST', '/v1/agents/me/fees', { txHash: feeHash }).catch(() => undefined); // optional fast path
  }
  return `${what}: ${hash}`;
}
