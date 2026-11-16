import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from 'viem';
import { ponsCurveAbi } from '@rushr/trade/abis';
import type { Built } from '../src/guards.ts';

const UR = '0x204faca1764b154221e35c0d20abb3c525710498' as Address;
/** Rushr's treasury Safe, as the API's curve builds name it. */
export const TREASURY = '0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3' as Address;
export const CURVE = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0' as Address;

/** A build response like the live API's, for an ETH buy or a sell. */
export function built(over: Partial<Built> = {}, amountIn = 1000n, side: 'buy' | 'sell' = 'buy'): Built {
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
export function curveBuilt(side: 'buy' | 'sell', amountIn: bigint, trader: Address, token: Address, over: Partial<Built> = {}): Built {
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
