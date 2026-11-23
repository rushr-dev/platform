import { decodeFunctionData, encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { LAUNCHPADS } from '@rushr/core/chain/robinhood';
import { TRADE_ADDRESSES } from './addresses';
import { erc20Abi } from './abis';
import type { TradeConfig } from './config';
import { TradeError } from './errors';
import type { FeeBreakdown } from './fees';
import type { Pool, Quote, V4Pool } from './types';

/**
 * QHooks (qhooks.com): a launchpad on Uniswap v4 hooks. Its launch pools are priced in WETH. Trades on them
 * go through QHooks' fee router (1% fee) with Rushr as the referrer, which credits Rushr 20% of that fee
 * (claimable on the router). QHooks prepares the unsigned calls (`prepare_trade` on its public MCP); we
 * check every one of them against what we asked for before the wallet sees it.
 *
 * A trade is: buys, wrap ETH -> WETH (only the shortfall), approve WETH, swap; sells, approve token, swap,
 * then unwrap the WETH the swap paid out (built after the swap confirms, from the balance change).
 */

export const QHOOKS_MCP = 'https://qhooks.com/mcp';
/** QHooks fee router on Robinhood Chain (their skill.md chain table): the swap target and approval spender. */
export const QHOOKS_FEE_ROUTER: Address = '0x79d211f5137d22b0fe3bfda81fbb8b7f53248bff';
/** QHooks launch hooks (each is also its factory), from the core launchpad registry (`launchpadForHook`). */
export const QHOOKS_HOOKS: readonly Address[] = LAUNCHPADS.find((l) => l.id === 'qhooks')?.hooks ?? [];
const HOOKS = new Set(QHOOKS_HOOKS.map((h) => h.toLowerCase()));

/** The token's QHooks launch pool among discovered pools (a v4 pool with a QHooks hook, priced in WETH). */
export function qhooksPool(pools: Pool[]): V4Pool | null {
  return (
    (pools.find(
      (p): p is V4Pool => p.venue === 'uniswap-v4' && HOOKS.has(p.key.hooks.toLowerCase()) && p.quote.toLowerCase() === TRADE_ADDRESSES.weth.toLowerCase(),
    ) as V4Pool | undefined) ?? null
  );
}

const wethAbi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
] as const;

export const wrapEthData = (): Hex => encodeFunctionData({ abi: wethAbi, functionName: 'deposit' });
export const unwrapWethData = (amount: bigint): Hex => encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [amount] });

export interface QHooksPrepared {
  /** Approval (when QHooks returns one) and the router swap, checked. */
  approval: { to: Address; data: Hex } | null;
  swap: { to: Address; data: Hex };
  /** Pool-side amount after the router fee (buys), the router fee in bps, outputs and minimum. */
  poolAmountIn: bigint;
  routerFeeBps: number;
  grossOut: bigint;
  netOut: bigint;
  minOut: bigint;
  gasEstimate: bigint | null;
  poolId: Hex;
  appliedReferrer: Address | null;
}

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface RawPrepared {
  chain?: string;
  chainId?: number;
  token?: string;
  side?: string;
  trader?: string;
  inputCurrency?: string;
  amountIn?: string;
  minOut?: string;
  transactions?: { to?: string; data?: string; value?: string; chainId?: number }[];
  quote?: { poolId?: string; amountIn?: string; grossAmountOut?: string; netAmountOut?: string; routerFeeBps?: number; gasEstimate?: string };
  referral?: { appliedReferrer?: string | null };
  error?: string;
}

const lc = (a: unknown) => String(a ?? '').toLowerCase();
const big = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new TradeError('QUOTE_FAILED', `QHooks returned a bad ${what}.`);
  return BigInt(v);
};

/**
 * Asks QHooks to prepare the trade and checks the answer: chain, token, side, trader and amount echo the
 * request; at most an approval of exactly `amountIn` of the input currency to the fee router, then a swap
 * to the fee router with no ETH value (WETH or token input). Anything else is refused.
 */
export async function prepareQHooks(
  p: { side: 'buy' | 'sell'; token: Address; amountIn: bigint; trader: Address; slippageBps: number; referrer: Address | null },
  fetcher: Fetch = fetch as unknown as Fetch,
): Promise<QHooksPrepared> {
  const args: Record<string, unknown> = {
    chain: '4663',
    token: p.token,
    side: p.side,
    amountIn: p.amountIn.toString(),
    trader: p.trader,
    slippageBps: p.slippageBps,
    ...(p.referrer ? { referrer: p.referrer } : {}),
  };
  let body: { result?: { structuredContent?: RawPrepared; isError?: boolean }; error?: { message?: string } };
  try {
    const r = await fetcher(QHOOKS_MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-QHooks-Client-Name': 'rushr' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'prepare_trade', method: 'tools/call', params: { name: 'prepare_trade', arguments: args } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    body = (await r.json()) as typeof body;
  } catch (e) {
    throw new TradeError('QUOTE_FAILED', `QHooks is unavailable right now (${(e as Error).message}).`);
  }
  const d = body.result?.structuredContent;
  if (!d || body.error || body.result?.isError || d.error) throw new TradeError('QUOTE_FAILED', `QHooks couldn't prepare this trade: ${d?.error ?? body.error?.message ?? 'no answer'}.`);
  return checkPrepared(d, p);
}

/** The checks, apart from the network call (unit-tested). */
export function checkPrepared(d: RawPrepared, p: { side: 'buy' | 'sell'; token: Address; amountIn: bigint; trader: Address }): QHooksPrepared {
  const fail = (why: string): never => {
    throw new TradeError('QUOTE_FAILED', `QHooks prepared an unexpected trade (${why}); not sending it.`);
  };
  const router = QHOOKS_FEE_ROUTER.toLowerCase();
  const input = p.side === 'buy' ? TRADE_ADDRESSES.weth.toLowerCase() : p.token.toLowerCase();
  if (String(d.chain ?? d.chainId) !== '4663') fail('chain');
  if (lc(d.token) !== p.token.toLowerCase()) fail('token');
  if (d.side !== p.side) fail('side');
  if (lc(d.trader) !== p.trader.toLowerCase()) fail('trader');
  if (lc(d.inputCurrency) !== input) fail('input currency');
  if (big(d.amountIn, 'amount') !== p.amountIn) fail('amount');
  const txs = d.transactions ?? [];
  if (txs.length < 1 || txs.length > 2) fail('transaction count');
  for (const t of txs) {
    if (t.chainId != null && t.chainId !== 4663) fail('transaction chain');
    if (big(t.value ?? '0', 'value') !== 0n) fail('ETH value');
    if (!/^0x[0-9a-f]*$/i.test(t.data ?? '')) fail('calldata');
  }
  let approval: QHooksPrepared['approval'] = null;
  if (txs.length === 2) {
    const a = txs[0]!;
    if (lc(a.to) !== input) fail('approval target');
    let spender: string;
    let amount: bigint;
    try {
      const dec = decodeFunctionData({ abi: erc20Abi, data: a.data as Hex });
      if (dec.functionName !== 'approve') fail('approval call');
      [spender, amount] = dec.args as unknown as [string, bigint];
    } catch {
      return fail('approval calldata');
    }
    if (spender.toLowerCase() !== router) fail('approval spender');
    if (amount !== p.amountIn) fail('approval amount');
    approval = { to: input as Address, data: a.data as Hex };
  }
  const s = txs[txs.length - 1]!;
  if (lc(s.to) !== router) fail('swap target');
  // The swap names the token and the trader somewhere in its arguments.
  const data = lc(s.data);
  if (!data.includes(p.token.toLowerCase().slice(2))) fail('swap token');
  const q = d.quote ?? {};
  const routerFeeBps = Number(q.routerFeeBps);
  if (!Number.isFinite(routerFeeBps) || routerFeeBps < 0 || routerFeeBps > 300) fail('router fee');
  const minOut = big(d.minOut, 'minimum');
  const netOut = big(q.netAmountOut, 'output');
  if (minOut <= 0n || minOut > netOut) fail('minimum output');
  return {
    approval,
    swap: { to: QHOOKS_FEE_ROUTER, data: s.data as Hex },
    poolAmountIn: big(q.amountIn ?? d.amountIn, 'pool amount'),
    routerFeeBps,
    grossOut: big(q.grossAmountOut ?? q.netAmountOut, 'gross output'),
    netOut,
    minOut,
    gasEstimate: q.gasEstimate && /^\d+$/.test(q.gasEstimate) ? BigInt(q.gasEstimate) : null,
    poolId: (q.poolId ?? '0x') as Hex,
    appliedReferrer: (d.referral?.appliedReferrer?.toLowerCase() as Address | undefined) ?? null,
  };
}

/** A Quote for the trade box, from a checked QHooks preparation. The fee shown is QHooks', not Rushr's. */
export function qhooksQuote(prep: QHooksPrepared, pool: V4Pool, req: { side: 'buy' | 'sell'; token: Address; amountIn: bigint; trader: Address }, slippageBps: number): Quote {
  // Buys: the router takes its fee from the WETH going in. Sells: from the WETH coming out.
  const feeAmount = req.side === 'buy' ? (req.amountIn > prep.poolAmountIn ? req.amountIn - prep.poolAmountIn : (req.amountIn * BigInt(prep.routerFeeBps)) / 10_000n) : prep.grossOut > prep.netOut ? prep.grossOut - prep.netOut : (prep.grossOut * BigInt(prep.routerFeeBps)) / 10_000n;
  const fee: FeeBreakdown = {
    side: req.side,
    feeToken: TRADE_ADDRESSES.weth,
    feeBps: prep.routerFeeBps,
    baseFeeBps: prep.routerFeeBps,
    feeAmount,
    holderDiscountBps: 0,
    holderDiscountAmount: 0n,
    referralDiscountAmount: 0n,
    referrerAccrual: 0n,
    venueFeeBps: pool.venueFeeBps,
    venueFeeLabel: pool.venueFeeLabel,
  };
  return {
    request: { side: req.side, token: req.token, quoteAsset: 'ETH', amountIn: req.amountIn, trader: req.trader, slippageBps, source: { kind: 'web' } },
    pool,
    amountIn: req.amountIn,
    swapAmountIn: req.side === 'buy' ? prep.poolAmountIn : req.amountIn,
    grossOut: req.side === 'buy' ? prep.netOut : prep.grossOut,
    amountOut: prep.netOut,
    minAmountOut: prep.minOut,
    minGrossOut: prep.minOut,
    slippageBps,
    fee,
    priceImpactBps: null,
    gasEstimate: prep.gasEstimate,
    expectedRefund: 0n,
    warnings: [],
    via: 'qhooks',
  };
}

/** WETH balance read for buys (wrap only the shortfall) and sells (unwrap only what the swap paid). */
export async function wethBalance(client: PublicClient, wallet: Address): Promise<bigint> {
  return client.readContract({ address: TRADE_ADDRESSES.weth, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
}

/** The referrer Rushr passes to QHooks: the treasury, where Rushr's fees go. */
export const qhooksReferrer = (cfg: TradeConfig): Address => cfg.feeRecipient;
