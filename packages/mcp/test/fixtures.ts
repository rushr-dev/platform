import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address, type Hex } from 'viem';
import { ponsCurveAbi } from '@rushr/trade/abis';
import type { Built } from '../src/guards.ts';

/** A single-transaction build (Uniswap or curve): `tx` is always there. */
export type TxBuilt = Built & { tx: NonNullable<Built['tx']> };

const UR = '0x204faca1764b154221e35c0d20abb3c525710498' as Address;
/** Rushr's treasury Safe, as the API's curve builds name it. */
export const TREASURY = '0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3' as Address;
export const CURVE = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0' as Address;

/** A build response like the live API's, for an ETH buy or a sell. */
export function built(over: Partial<TxBuilt> = {}, amountIn = 1000n, side: 'buy' | 'sell' = 'buy'): TxBuilt {
  return {
    tx: { chainId: 4663, to: UR, data: '0x3593564c' as Hex, value: side === 'buy' ? amountIn.toString() : '0' },
    approvals: [],
    deadline: String(Math.floor(Date.now() / 1000) + 300),
    followUp: null,
    quote: { amountIn: amountIn.toString(), amountOut: '5000', minAmountOut: '4900', priceImpactBps: 120, fee: { feeBps: 25, feeAmount: '2' }, pool: { venue: 'v4' } },
    simulation: { ok: true, received: '5000', feePaid: '2' },
    warnings: [],
    ...over,
  };
}

/**
 * A PONS curve build in the shape the Agents API settled on: `tx` calls the curve directly, the fee is a
 * follow-up transfer to the treasury (25 bps of the ETH side), sells approve the curve on the token.
 */
export function curveBuilt(side: 'buy' | 'sell', amountIn: bigint, trader: Address, token: Address, over: Partial<TxBuilt> = {}): TxBuilt {
  const ethOut = 4_000_000_000_000_000n;
  const fee = side === 'buy' ? (amountIn * 25n) / 10_000n : (ethOut * 25n) / 9_975n;
  const minOut = 1n;
  return {
    tx: {
      chainId: 4663,
      to: CURVE,
      data: encodeFunctionData({ abi: ponsCurveAbi, functionName: side, args: [amountIn, minOut, trader] }),
      value: side === 'buy' ? amountIn.toString() : '0',
      gas: '400000',
    },
    approvals:
      side === 'sell'
        ? [{ kind: 'curve', token, spender: CURVE, amount: amountIn.toString(), tx: { chainId: 4663, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CURVE, maxUint256] }), value: '0', gas: '80000' } }]
        : [],
    followUp: { kind: 'rushr_fee', amount: fee.toString(), tx: { chainId: 4663, to: TREASURY, data: '0x', value: fee.toString(), gas: '60000' }, after: 'tx', report: 'POST /v1/agents/me/fees' },
    deadline: null,
    quote: {
      amountIn: amountIn.toString(),
      amountOut: side === 'buy' ? '123456789000000000000' : ethOut.toString(),
      minAmountOut: minOut.toString(),
      priceImpactBps: 150,
      fee: { feeBps: 25, feeAmount: fee.toString() },
      pool: { venue: 'pons-curve', id: CURVE, curve: CURVE },
    },
    simulation: { ok: true },
    warnings: ['PONS bonding curve: the Rushr fee is a separate transfer after the trade'],
    ...over,
  };
}

/** The pair token of a pair-curve fixture (a Robinhood stock token like ANT). */
export const PAIR = '0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0' as Address;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address;
const urAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const p2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

/**
 * A pair-token curve build as `pairCurveResponse` returns it: `tx: null`, ordered `steps` (approvals, then
 * swap and curve, in the side's order) and a `route`. Every approval the side can ask for is included.
 */
export function pairBuilt(side: 'buy' | 'sell', amountIn: bigint, trader: Address, token: Address, minPair = 1_000_000n): Built {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const tx = (to: Address, data: Hex, value = 0n) => ({ chainId: 4663, to, data, value: value.toString(), gas: '300000' });
  const approve = (on: Address, spender: Address) => tx(on, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }));
  const swap = tx(UR, encodeFunctionData({ abi: urAbi, functionName: 'execute', args: ['0x0b00', ['0x', '0x'], deadline] }), side === 'buy' ? amountIn : 0n);
  const curve = tx(CURVE, encodeFunctionData({ abi: ponsCurveAbi, functionName: side, args: side === 'buy' ? [minPair, 1n, trader] : [amountIn, minPair, trader] }));
  const raw: [kind: 'approve' | 'swap' | 'curve', label: string, t: ReturnType<typeof tx>][] =
    side === 'buy'
      ? [['approve', 'approve pair token for the curve', approve(PAIR, CURVE)], ['swap', 'swap', swap], ['curve', 'curve swap', curve]]
      : [
          ['approve', 'approve token for the curve', approve(token, CURVE)],
          ['approve', 'approve token for Permit2', approve(PAIR, PERMIT2)],
          ['approve', 'allow Universal Router in Permit2', tx(PERMIT2, encodeFunctionData({ abi: p2Abi, functionName: 'approve', args: [PAIR, UR, (1n << 160n) - 1n, Number(deadline) + 30 * 86_400] }))],
          ['curve', 'curve swap', curve],
          ['swap', 'swap', swap],
        ];
  const steps = raw.map(([kind, label, t], i) => ({ step: i + 1, kind, label, tx: t }));
  const fee = side === 'buy' ? (amountIn * 25n) / 10_000n : 10_000_000_000_000n;
  return {
    tx: null,
    steps,
    approvals: [],
    route: { kind: 'pair-curve', pairToken: PAIR, pairSymbol: 'ANT', pairDecimals: 18, path: 'Uniswap v4 · 0.05% pool fee', curve: CURVE, pairAmount: ((minPair * 102n) / 100n).toString(), minPairAmount: minPair.toString(), swapStep: steps.find((s) => s.kind === 'swap')!.step, curveStep: steps.find((s) => s.kind === 'curve')!.step },
    followUp: null,
    deadline: deadline.toString(),
    quote: {
      amountIn: amountIn.toString(),
      amountOut: side === 'buy' ? '123456789000000000000' : '4000000000000000',
      minAmountOut: '1',
      priceImpactBps: 150,
      fee: { feeBps: 25, feeAmount: fee.toString() },
      pool: { venue: 'pons-curve', id: CURVE, curve: CURVE },
    },
    simulation: { ok: true },
    warnings: ['Two trades: ETH → ANT on Uniswap (Rushr fee inside that swap), then ANT → token on the bonding curve.'],
  };
}
