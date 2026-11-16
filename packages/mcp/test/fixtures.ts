import type { Address, Hex } from 'viem';
import type { Built } from '../src/guards.ts';

const UR = '0x204faca1764b154221e35c0d20abb3c525710498' as Address;

/** A build response like the live API's, for an ETH buy or a sell. */
export function built(over: Partial<Built> = {}, amountIn = 1000n, side: 'buy' | 'sell' = 'buy'): Built {
  return {
    tx: { chainId: 4663, to: UR, data: '0x3593564c' as Hex, value: side === 'buy' ? amountIn.toString() : '0' },
    approvals: [],
    deadline: String(Math.floor(Date.now() / 1000) + 300),
    quote: { amountIn: amountIn.toString(), amountOut: '5000', minAmountOut: '4900', priceImpactBps: 120, fee: { feeBps: 25, feeAmount: '2' }, pool: { venue: 'v4' } },
    simulation: { ok: true, received: '5000', feePaid: '2' },
    warnings: [],
    ...over,
  };
}

