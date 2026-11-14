// PONS token tax, read from the token's curve contract.
//
// A PONS curve charges a protocol fee (`feeBps`, usually 1%) and a creator tax (`creatorTaxBps`, 1-4%) on
// the quote (ETH) side of every buy and sell. Both are taken in the quote, so a transfer-based tax
// measurement sees nothing. After graduation the PONS v2 hook keeps charging both on the v4 pool (checked
// on MORPH, 2026-11-14: the hook event split 4% into 1% protocol + 3% creator, buys and sells).
import type { Sql } from 'postgres';
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { ponsCurveAbi, ponsFactoryAbi, TRADE_ADDRESSES } from '@rushr/trade';
import type { Rpc } from './rpc';

/** Cached in the token's signals (`data.contractTax`). Owner-set and rarely changed, so refreshed weekly. */
export interface ContractTax {
  curve: string;
  creatorTaxBps: number;
  feeBps: number;
  /** Unix seconds of the read. */
  at: number;
}

export const CONTRACT_TAX_TTL_S = 7 * 24 * 3600;

const ethCall = (to: string, data: Hex) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });

/** The token's curve: from its pons-curve pool, else the factory's getLaunchedToken. */
async function curveOf(sql: Sql, rpc: Rpc, token: string): Promise<string | null> {
  const [p] = await sql<{ id: string }[]>`select id from pools where token = ${token} and dex = 'pons-curve' limit 1`;
  if (p) return p.id;
  const data = encodeFunctionData({ abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token as Hex] });
  const [out] = await rpc.batch<Hex>([ethCall(TRADE_ADDRESSES.pons.factory, data)]);
  if (!out || out === '0x') return null;
  const [, curve] = decodeFunctionResult({ abi: ponsFactoryAbi, functionName: 'getLaunchedToken', data: out });
  const c = curve.toLowerCase();
  return /^0x0{40}$/.test(c) ? null : c;
}

/** Read feeBps and creatorTaxBps from the curve (one batched call). null when it isn't a PONS token. */
export async function readPonsTax(sql: Sql, rpc: Rpc, token: string): Promise<ContractTax | null> {
  const curve = await curveOf(sql, rpc, token);
  if (!curve) return null;
  const [fee, tax] = await rpc.batch<Hex>([
    ethCall(curve, encodeFunctionData({ abi: ponsCurveAbi, functionName: 'feeBps' })),
    ethCall(curve, encodeFunctionData({ abi: ponsCurveAbi, functionName: 'creatorTaxBps' })),
  ]);
  if (!fee || !tax || fee === '0x' || tax === '0x') return null;
  return {
    curve,
    feeBps: Number(decodeFunctionResult({ abi: ponsCurveAbi, functionName: 'feeBps', data: fee })),
    creatorTaxBps: Number(decodeFunctionResult({ abi: ponsCurveAbi, functionName: 'creatorTaxBps', data: tax })),
    at: Math.floor(Date.now() / 1000),
  };
}
