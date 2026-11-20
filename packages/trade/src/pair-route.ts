import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { TRADE_ADDRESSES, UR_ADDRESS_THIS, UR_MSG_SENDER } from './addresses';
import { erc20Abi } from './abis';
import { discoverPools } from './pools';
import { quoteVenue } from './quote';
import { CONTRACT_BALANCE, cmd, encodeV3Path, OPEN_DELTA, v4, type EncodedCommand } from './universal-router';
import type { ApiPoolRow } from './api-pools';
import type { Pool, V2Pool, V3Pool, V4Pool } from './types';
import { STOCK_QUOTES } from '@rushr/core/chain/robinhood';

/**
 * ETH routes to and from a "pair token": an ERC-20 that a token is priced in instead of ETH (a PONS curve
 * paired with ANT, a pool that only trades against USDG). No Rushr contract: one Universal Router call
 * swaps ETH -> pair token (or back) across one or two Uniswap pools, with the Rushr fee inside that call in
 * ETH, exactly like a single-pool route (TRANSFER on buys, PAY_PORTION on sells).
 *
 * Paths, in buy order (ETH first):
 *   direct: ETH|WETH -> pair            (a pool pairing the pair token with ETH or WETH)
 *   via USDG: ETH|WETH -> USDG -> pair  (the usual case for Robinhood stock tokens)
 * The second hop spends whatever the first one left in the router (CONTRACT_BALANCE), so only the final
 * output carries a minimum. Each hop picks the best-quoting pool for its pair.
 */

export type HopPool = V2Pool | V3Pool | V4Pool;

export interface PairHop {
  pool: HopPool;
  /** Side of the hop against its own pool (pool.token / pool.quote). */
  side: 'buy' | 'sell';
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  spotOut: bigint | null;
}

/** Pools that can serve each hop of a pair-token route. */
export interface PairPools {
  pair: Address;
  /** pair vs ETH/WETH (pool.token = pair). For a USDG pair token these are the USDG/ETH pools. */
  direct: HopPool[];
  /** pair vs USDG (pool.token = pair). Empty when the pair token is USDG. */
  pairUsdg: HopPool[];
  /** USDG vs ETH/WETH (pool.token = USDG). */
  usdgEth: HopPool[];
}

/** Hooked v4 pools and stray high-fee pools are never part of a pair route. */
const MAX_HOP_FEE_BPS = 1_000;
const routable = (p: Pool): p is HopPool =>
  p.venue !== 'pons-curve' && p.venueFeeBps <= MAX_HOP_FEE_BPS && !(p.venue === 'uniswap-v4' && p.key.hooks !== zeroAddress);

const lc = (a: string) => a.toLowerCase() as Address;
const UNISWAP = ['uniswap-v4', 'uniswap-v3', 'uniswap-v2'] as const;

export interface PairDiscoverOptions {
  /** Rushr API pool rows for a token (`fetchApiPools`, or the indexer's own `tokenPools`): adds v4 keys. */
  apiPools?: (token: Address) => Promise<ApiPoolRow[] | null>;
}

const POOLS_TTL_MS = 30_000;
const pairPoolCache = new Map<string, { at: number; pools: Promise<PairPools | null> }>();

/**
 * Pools for an ETH route to `pair` (cached 30 s per pair token: they barely change, and quick trades
 * refresh every few seconds). Null when the pair token is ETH/WETH itself (not a pair route) or has no route.
 */
export function discoverPairPools(client: PublicClient, pairIn: Address, opts: PairDiscoverOptions = {}, now = Date.now()): Promise<PairPools | null> {
  const pair = lc(pairIn);
  const hit = pairPoolCache.get(pair);
  if (hit && now - hit.at < POOLS_TTL_MS) return hit.pools;
  const pools = loadPairPools(client, pair, opts);
  pools.catch(() => pairPoolCache.delete(pair));
  pairPoolCache.set(pair, { at: now, pools });
  return pools;
}

/** Forget cached pair pools (tests). */
export function clearPairPoolCache(): void {
  pairPoolCache.clear();
}

async function loadPairPools(client: PublicClient, pair: Address, opts: PairDiscoverOptions): Promise<PairPools | null> {
  if (pair === TRADE_ADDRESSES.weth || pair === zeroAddress) return null;
  const usdg = TRADE_ADDRESSES.usdg;
  const rows = async (t: Address) => (opts.apiPools ? await opts.apiPools(t).catch(() => null) : null);
  const find = async (token: Address, quoteAsset: 'ETH' | 'USDG') =>
    (await discoverPools(client, token, { quoteAsset, venues: [...UNISWAP], apiPools: await rows(token) })).filter(routable);
  if (pair === usdg) {
    const usdgEth = await find(usdg, 'ETH');
    return usdgEth.length ? { pair, direct: usdgEth, pairUsdg: [], usdgEth } : null;
  }
  const [direct, pairUsdg, usdgEth] = await Promise.all([find(pair, 'ETH'), find(pair, 'USDG'), find(usdg, 'ETH')]);
  if (!direct.length && !(pairUsdg.length && usdgEth.length)) return null;
  return { pair, direct, pairUsdg, usdgEth };
}

/** Best pool for one hop (highest output), or null when none quotes. */
async function bestHop(client: PublicClient, pools: HopPool[], side: 'buy' | 'sell', amountIn: bigint): Promise<PairHop | null> {
  if (amountIn <= 0n || !pools.length) return null;
  const settled = await Promise.allSettled(pools.map((p) => quoteVenue(client, p, side, amountIn)));
  let best: PairHop | null = null;
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled' || s.value.out <= 0n) return;
    if (best && s.value.out <= best.amountOut) return;
    const pool = pools[i]!;
    best = {
      pool,
      side,
      tokenIn: side === 'buy' ? pool.quote : pool.token,
      tokenOut: side === 'buy' ? pool.token : pool.quote,
      amountIn,
      amountOut: s.value.out,
      spotOut: s.value.spotOut,
    };
  });
  return best;
}

const finalOut = (h: PairHop[] | null) => (h?.length ? h[h.length - 1]!.amountOut : 0n);

/** The best path ETH -> pair for `ethIn` (already net of the Rushr fee), as quoted hops. */
export async function quoteEthToPair(client: PublicClient, pp: PairPools, ethIn: bigint): Promise<PairHop[] | null> {
  const direct = bestHop(client, pp.direct, 'buy', ethIn).then((h) => (h ? [h] : null));
  const via = pp.pairUsdg.length
    ? bestHop(client, pp.usdgEth, 'buy', ethIn).then(async (h1) => {
        const h2 = h1 ? await bestHop(client, pp.pairUsdg, 'buy', h1.amountOut) : null;
        return h1 && h2 ? [h1, h2] : null;
      })
    : Promise.resolve(null);
  const [a, b] = await Promise.all([direct, via]);
  return finalOut(a) >= finalOut(b) ? a : b;
}

/** The best path pair -> ETH for `pairIn`, as quoted hops. The last hop's output is the gross ETH (or WETH). */
export async function quotePairToEth(client: PublicClient, pp: PairPools, pairIn: bigint): Promise<PairHop[] | null> {
  const direct = bestHop(client, pp.direct, 'sell', pairIn).then((h) => (h ? [h] : null));
  const via = pp.pairUsdg.length
    ? bestHop(client, pp.pairUsdg, 'sell', pairIn).then(async (h1) => {
        const h2 = h1 ? await bestHop(client, pp.usdgEth, 'sell', h1.amountOut) : null;
        return h1 && h2 ? [h1, h2] : null;
      })
    : Promise.resolve(null);
  const [a, b] = await Promise.all([direct, via]);
  return finalOut(a) >= finalOut(b) ? a : b;
}

/** Combined price impact of a path in bps (1 − Π(1 − impact_i)), venue fees excluded. */
export function pathImpactBps(parts: { spotOut: bigint | null; out: bigint; venueFeeBps: number }[]): number | null {
  let keep = 1;
  for (const p of parts) {
    if (!p.spotOut || p.spotOut <= 0n) return null;
    const impact = p.out >= p.spotOut ? 0 : Number(((p.spotOut - p.out) * 10_000n) / p.spotOut);
    keep *= 1 - Math.max(0, impact - p.venueFeeBps) / 10_000;
  }
  return Math.round((1 - keep) * 10_000);
}

export function pathLabel(hops: Pick<PairHop, 'pool'>[]): string {
  return hops.map((h) => h.pool.venueFeeLabel).join(' → ');
}

// ---- Universal Router plan ------------------------------------------------------------------------

export interface PairSwapPlan {
  side: 'buy' | 'sell';
  hops: Pick<PairHop, 'pool' | 'tokenIn' | 'tokenOut'>[];
  /** Buys: ETH into the first hop (after the fee). Sells: pair-token amount pulled from the user via Permit2. */
  amountIn: bigint;
  /** Buys: minimum pair token delivered to the user. Sells: minimum gross ETH before the fee. */
  minOut: bigint;
  treasury: Address;
  /** Buys: fee in ETH, TRANSFERred to the treasury first. */
  feeAmount?: bigint;
  /** Sells: fee rate taken with PAY_PORTION from the ETH output. */
  feeBps?: number;
  /** Sells: minimum ETH the user receives after the fee (checked by SWEEP). */
  minNet?: bigint;
}

/**
 * Universal Router commands for a pair route. Recipients are only the router itself (between hops) and the
 * user (UR_MSG_SENDER); the only other payee is the treasury's fee.
 *
 * Buys: TRANSFER fee · [WRAP_ETH] · hop 1 (fixed amount) · hop 2 (CONTRACT_BALANCE) -> user, final minimum.
 * Sells: hop 1 (pulls the pair token via Permit2) · hop 2 (CONTRACT_BALANCE) · [UNWRAP_WETH] · PAY_PORTION · SWEEP.
 */
export function planPairSwap(p: PairSwapPlan): EncodedCommand[] {
  if (!p.hops.length || p.hops.length > 2) throw new Error('pair route: 1 or 2 hops');
  const out: EncodedCommand[] = [];
  const ETH = TRADE_ADDRESSES.eth;
  const WETH = TRADE_ADDRESSES.weth;
  const buy = p.side === 'buy';
  if (buy && (p.feeAmount ?? 0n) > 0n) out.push(cmd.transfer(ETH, p.treasury, p.feeAmount!));
  if (buy && p.hops[0]!.tokenIn === WETH) out.push(cmd.wrapEth(UR_ADDRESS_THIS, p.amountIn));
  p.hops.forEach((h, i) => {
    const first = i === 0;
    const last = i === p.hops.length - 1;
    const amount = first ? p.amountIn : CONTRACT_BALANCE;
    const min = last ? p.minOut : 0n;
    const recipient = buy && last ? UR_MSG_SENDER : UR_ADDRESS_THIS;
    // Only a sell's first hop pulls from the user (Permit2); everything else spends the router's balance.
    const payerIsUser = !buy && first;
    switch (h.pool.venue) {
      case 'uniswap-v3':
        out.push(cmd.v3SwapExactIn(recipient, amount, min, encodeV3Path([h.tokenIn, h.tokenOut], [h.pool.fee]), payerIsUser));
        break;
      case 'uniswap-v2':
        out.push(cmd.v2SwapExactIn(recipient, amount, min, [h.tokenIn, h.tokenOut], payerIsUser));
        break;
      case 'uniswap-v4': {
        const pool = h.pool;
        const zeroForOne = pool.key.currency0 === h.tokenIn;
        const swap = (amountIn: bigint) => v4.swapExactInSingle({ poolKey: pool.key, zeroForOne, amountIn, amountOutMinimum: min, hookData: pool.hookData });
        // First hop: a fixed amount, paid by the router (ETH from msg.value) on buys or by the user on sells.
        // Later hops: settle the router's whole balance first, then swap the open credit.
        const steps = first
          ? [swap(p.amountIn), payerIsUser ? v4.settleAll(h.tokenIn, p.amountIn) : v4.settle(h.tokenIn, OPEN_DELTA, false)]
          : [v4.settle(h.tokenIn, CONTRACT_BALANCE, false), swap(OPEN_DELTA)];
        steps.push(buy && last ? v4.takeAll(h.tokenOut, min) : v4.take(h.tokenOut, UR_ADDRESS_THIS, OPEN_DELTA));
        out.push(cmd.v4Swap(steps));
        break;
      }
    }
  });
  if (!buy) {
    if (p.hops[p.hops.length - 1]!.tokenOut === WETH) out.push(cmd.unwrapWeth(UR_ADDRESS_THIS, p.minOut));
    if ((p.feeBps ?? 0) > 0) out.push(cmd.payPortion(ETH, p.treasury, p.feeBps!));
    out.push(cmd.sweep(ETH, UR_MSG_SENDER, p.minNet ?? 0n));
  }
  return out;
}

// ---- pair token metadata and receipts -------------------------------------------------------------

const KNOWN_SYMBOLS: Record<string, string> = {
  [TRADE_ADDRESSES.usdg]: 'USDG',
  ...Object.fromEntries(Object.entries(STOCK_QUOTES).map(([sym, a]) => [a.toLowerCase(), sym])),
};
const metaCache = new Map<string, Promise<{ symbol: string; decimals: number }>>();

/** Symbol and decimals of a pair token (cached per address; falls back to "pair token", 18). */
export function pairTokenMeta(client: PublicClient, token: Address): Promise<{ symbol: string; decimals: number }> {
  const k = lc(token);
  let p = metaCache.get(k);
  if (!p) {
    p = Promise.all([
      client.readContract({ address: k, abi: erc20Abi, functionName: 'symbol' }).catch(() => KNOWN_SYMBOLS[k] ?? 'pair token'),
      client.readContract({ address: k, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]).then(([symbol, decimals]) => ({ symbol: String(symbol).slice(0, 16), decimals: Number(decimals) }));
    metaCache.set(k, p);
  }
  return p;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Net amount of `token` that moved into `who` in a receipt's logs (negative when it moved out). */
export function netTokenIn(logs: readonly { address: string; topics: readonly string[]; data: string }[], token: Address, who: Address): bigint {
  const t = lc(token);
  const w = lc(who);
  let net = 0n;
  for (const l of logs) {
    if (lc(l.address) !== t || l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
    const from = lc(`0x${l.topics[1]!.slice(26)}`);
    const to = lc(`0x${l.topics[2]!.slice(26)}`);
    const v = BigInt(l.data as Hex);
    if (to === w) net += v;
    if (from === w) net -= v;
  }
  return net;
}

/** "0.1 ANT", trimmed to 6 decimals. */
export function formatPairAmount(amount: bigint, decimals: number, symbol: string): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}

// ---- ledger -------------------------------------------------------------------------------------

export interface PairCurveFill {
  side: 'buy' | 'sell';
  curve: Address;
  /** The curve's token, and how much of it the trader got (buys) or put in (sells). */
  token: Address;
  tokenAmount: bigint;
  /** The pair token the curve is priced in, and how much of it went in (buys) or came out (sells). */
  pairToken: Address;
  pairAmount: bigint;
}

/**
 * The curve leg of a pair trade, from its receipt: the curve's own fill event for `trader` gives side and
 * curve; the trader's two token flows in the same receipt say which token is the curve's (into the trader
 * on buys) and which the pair token (out on buys). Null when the receipt holds no such fill.
 */
export function pairCurveFillFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  trader: Address,
  fill: { side: 'buy' | 'sell'; curve: Address } | null,
): PairCurveFill | null {
  if (!fill) return null;
  const tokens = [...new Set(logs.filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3).map((l) => lc(l.address)))];
  const flows = tokens.map((t) => ({ t, net: netTokenIn(logs, t, trader) })).filter((x) => x.net !== 0n);
  const inflow = flows.find((x) => x.net > 0n);
  const outflow = flows.find((x) => x.net < 0n);
  if (!inflow || !outflow) return null;
  const [tok, pair] = fill.side === 'buy' ? [inflow, outflow] : [outflow, inflow];
  return { side: fill.side, curve: lc(fill.curve), token: tok.t, tokenAmount: tok.net < 0n ? -tok.net : tok.net, pairToken: pair.t, pairAmount: pair.net < 0n ? -pair.net : pair.net };
}
