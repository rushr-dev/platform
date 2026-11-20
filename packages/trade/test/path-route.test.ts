import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { buildSwap } from '../src/build';
import { resolveConfig, RUSHR_TREASURY } from '../src/config';
import { TRADE_ADDRESSES, UR_ADDRESS_THIS, UR_MSG_SENDER } from '../src/addresses';
import { CONTRACT_BALANCE, universalRouterAbi } from '../src/universal-router';
import { busiestIsPairQuoted, pairQuotedRows, quotePath, reversePath, type PairPools } from '../src/pair-route';
import { quickBuy, nonEthQuoteGuard } from '../src/quick';
import { v2AmountOut } from '../src/math';
import type { ApiPoolRow } from '../src/api-pools';
import type { SwapRequest, V2Pool } from '../src/types';

const TRADER: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x7d578ac588917519f339c70bdd991bf3aa9c0620'; // NVDAc
const NVDA: Address = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const WETH = TRADE_ADDRESSES.weth;
const cfg = resolveConfig();
const fake = { getGasPrice: async () => 100_000_000n } as unknown as PublicClient;
const E = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

// ETH at 3,000 USD-ish, NVDA ≈ 0.06 ETH, the token ≈ 1/30,000 NVDA (v2 math: no RPC).
const wethNvda: V2Pool = { venue: 'uniswap-v2', id: '0x1000000000000000000000000000000000000003', token: NVDA, quote: WETH, reserveToken: 100_000n * 10n ** 18n, reserveQuote: 6_000n * 10n ** 18n, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2 · 0.30% pool fee' };
const nvdaToken: V2Pool = { venue: 'uniswap-v2', id: '0x1000000000000000000000000000000000000004', token: TOKEN, quote: NVDA, reserveToken: 3_000_000_000n * 10n ** 18n, reserveQuote: 100_000n * 10n ** 18n, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2 · 0.30% pool fee' };
const known: PairPools[] = [{ pair: NVDA, direct: [wethNvda], pairUsdg: [], usdgEth: [] }];
const req = (side: 'buy' | 'sell', amountIn: bigint, o: Partial<SwapRequest> = {}): SwapRequest => ({ side, token: TOKEN, quoteAsset: 'ETH', amountIn, trader: TRADER, slippageBps: 300, ...o });
const low = (xs: readonly unknown[]): unknown[] => xs.map((x) => (typeof x === 'string' ? x.toLowerCase() : Array.isArray(x) ? low(x) : x));
const ur = (data: Hex) => decodeFunctionData({ abi: universalRouterAbi, data }).args as unknown as [Hex, Hex[], bigint];
const v2In = (h: Hex) => low(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }, { type: 'uint256[]' }], h).slice(0, 5));
const three = (h: Hex) => low(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], h));

describe('multi-hop route: a token priced in another token, bought and sold with ETH in one call', () => {
  it('buy: TRANSFER the ETH fee, wrap, ETH -> NVDA into the router, NVDA (whole balance) -> token to the user with the minimum', async () => {
    const q = (await quotePath(fake, req('buy', E(0.01)), cfg, [nvdaToken], { known }))!;
    const net = E(0.01) - E(0.000025);
    const nvda = v2AmountOut(net, wethNvda.reserveQuote, wethNvda.reserveToken);
    const out = v2AmountOut(nvda, nvdaToken.reserveQuote, nvdaToken.reserveToken);
    expect(q).toMatchObject({ amountIn: E(0.01), swapAmountIn: net, amountOut: out, minAmountOut: (out * 9_700n) / 10_000n });
    expect(q.fee).toMatchObject({ feeToken: TRADE_ADDRESSES.eth, feeBps: 25, feeAmount: E(0.000025) });
    expect(q.pool).toBe(nvdaToken);
    expect(q.path!.map((h) => [h.tokenIn, h.tokenOut])).toEqual([[WETH, NVDA], [NVDA, TOKEN]]);
    const b = buildSwap(q, cfg, { now: 1_000 });
    expect(b.tx).toMatchObject({ to: TRADE_ADDRESSES.universalRouter, value: E(0.01) });
    expect(b.approvals).toEqual([]);
    const [commands, inputs] = ur(b.tx.data);
    expect(commands).toBe('0x050b0808');
    expect(three(inputs[0]!)).toEqual(['0x0000000000000000000000000000000000000000', RUSHR_TREASURY.toLowerCase(), E(0.000025)]);
    expect(v2In(inputs[2]!)).toEqual([UR_ADDRESS_THIS, net, 0n, [WETH, NVDA], false]);
    expect(v2In(inputs[3]!)).toEqual([UR_MSG_SENDER, CONTRACT_BALANCE, q.minAmountOut, [NVDA, TOKEN], false]);
  });

  it('sell: pull the token via Permit2, token -> NVDA -> WETH, unwrap, PAY_PORTION, SWEEP the net minimum; holder discount kept', async () => {
    const amount = 10n ** 24n;
    const q = (await quotePath(fake, req('sell', amount, { holderDiscountBps: 2_500 }), cfg, [nvdaToken], { known }))!;
    const gross = v2AmountOut(v2AmountOut(amount, nvdaToken.reserveToken, nvdaToken.reserveQuote), wethNvda.reserveToken, wethNvda.reserveQuote);
    expect(q.grossOut).toBe(gross);
    expect(q.fee).toMatchObject({ feeBps: 18, holderDiscountBps: 2_500, feeAmount: (gross * 18n) / 10_000n });
    const b = buildSwap(q, cfg, { now: 1_000 });
    expect(b.tx.value).toBe(0n);
    expect(b.approvals.map((a) => [a.kind, a.token])).toEqual([['erc20', TOKEN], ['permit2', TOKEN]]);
    const [commands, inputs] = ur(b.tx.data);
    expect(commands).toBe('0x08080c0604');
    expect(v2In(inputs[0]!)).toEqual([UR_ADDRESS_THIS, amount, 0n, [TOKEN, NVDA], true]);
    expect(v2In(inputs[1]!)).toEqual([UR_ADDRESS_THIS, CONTRACT_BALANCE, q.minGrossOut, [NVDA, WETH], false]);
    expect(three(inputs[3]!)).toEqual(['0x0000000000000000000000000000000000000000', RUSHR_TREASURY.toLowerCase(), 18n]);
    expect(three(inputs[4]!)).toEqual(['0x0000000000000000000000000000000000000000', UR_MSG_SENDER, q.minAmountOut]);
  });

  it('reverses a path for the matching sell; spots pair-quoted pools in the API rows', () => {
    const path = [{ pool: wethNvda, tokenIn: WETH, tokenOut: NVDA }, { pool: nvdaToken, tokenIn: NVDA, tokenOut: TOKEN }];
    expect(reversePath(path).map((h) => [h.pool.id, h.tokenIn, h.tokenOut])).toEqual([[nvdaToken.id, TOKEN, NVDA], [wethNvda.id, NVDA, WETH]]);
    const row = (quote: string, volume: number, version = 'v4', dex = 'uniswap') => ({ pool: '0x01', dex, version, launchpad: null, quote, token_is_currency0: false, key: null, liquidity_usd: null, volume_24h_usd: volume, trades_24h: 1, created_at: '' }) as ApiPoolRow;
    const rows = [row(NVDA, 315_000), row(TRADE_ADDRESSES.usdg, 461), row(TRADE_ADDRESSES.eth, 1), row(NVDA, 9, 'v3', 'aero')];
    expect(pairQuotedRows(rows).map((r) => r.quote)).toEqual([NVDA, TRADE_ADDRESSES.usdg]);
    expect(busiestIsPairQuoted(rows)).toBe(true);
    expect(busiestIsPairQuoted([row(TRADE_ADDRESSES.eth, 10), row(NVDA, 5)])).toBe(false);
  });

  it('only trap pools against ETH and no quotable path: says which token it trades against', async () => {
    const trap: V2Pool = { ...wethNvda, token: TOKEN, venueFeeBps: 9_000, venueFeeLabel: 'Uniswap v4 · 90% pool fee' };
    const rows = [{ pool: '0x01', dex: 'uniswap', version: 'v4', launchpad: 'pons', quote: NVDA, token_is_currency0: false, key: null, liquidity_usd: null, volume_24h_usd: 315_000, trades_24h: 5000, created_at: '' }] as ApiPoolRow[];
    const t = await quickBuy(fake, { token: TOKEN, ethWei: E(0.01), trader: TRADER }, { discover: { pools: [trap], apiPools: rows }, simulate: false, assume: { ethWei: E(1) } });
    expect(t.blockers).toEqual([nonEthQuoteGuard(rows)]);
    expect(t.blockers[0]!.message).toContain('trades against NVDA');
  });
});
