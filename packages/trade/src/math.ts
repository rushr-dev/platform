import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { BPS } from './fees.ts';
import type { PoolKey } from './universal-router.ts';

/** Uniswap v2 getAmountOut with the 0.30% LP fee (997/1000). */
export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * 997n;
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee);
}

/** Spot output for v2 (no fee, no impact), for price impact. */
export function v2SpotOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return reserveIn > 0n ? (amountIn * reserveOut) / reserveIn : 0n;
}

/**
 * PONS curve buy: constant product on the curve's virtual reserves (quoteReserve includes the phantom
 * quote), with the protocol fee and creator tax taken from the input first. Verified to the wei against
 * eth_simulateV1 of curve.buy on 2026-11-12.
 */
export function ponsBuyOut(quoteIn: bigint, quoteReserve: bigint, tokenReserve: bigint, feeBps: number, creatorTaxBps: number): bigint {
  if (quoteIn <= 0n) return 0n;
  const net = quoteIn - (quoteIn * BigInt(feeBps)) / BPS - (quoteIn * BigInt(creatorTaxBps)) / BPS;
  return (tokenReserve * net) / (quoteReserve + net);
}

/** PONS curve sell: constant product, fees taken from the quote output (checked by simulation, see scripts/simulate.ts). */
export function ponsSellOut(tokensIn: bigint, quoteReserve: bigint, tokenReserve: bigint, feeBps: number, creatorTaxBps: number): bigint {
  if (tokensIn <= 0n) return 0n;
  const gross = (quoteReserve * tokensIn) / (tokenReserve + tokensIn);
  return gross - (gross * BigInt(feeBps)) / BPS - (gross * BigInt(creatorTaxBps)) / BPS;
}

export function ponsSpotBuyOut(quoteIn: bigint, quoteReserve: bigint, tokenReserve: bigint): bigint {
  return quoteReserve > 0n ? (quoteIn * tokenReserve) / quoteReserve : 0n;
}

/** v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function v4PoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Sort two currencies as v4/v3 do (numerically, native ETH 0x0 first). */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/** v4 dynamic-fee flag in PoolKey.fee. */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
