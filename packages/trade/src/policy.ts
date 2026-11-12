import { toFunctionSelector, type Address } from 'viem';
import { rushrCurveRouterAbi } from './abis';
import { rushrRouterAbi } from './rushr-router';

/**
 * Privy policy for a Rushr session signer (quick-trade or one agent). Founder defaults (2026-11-12):
 * 0.25 ETH per trade, 1 ETH per rolling 24 h, 30-day grants, user-adjustable.
 *
 * What it allows (everything else is denied by Privy's default-deny):
 * - eth_signTransaction on chain 4663 to RushrRouter.{buy,sell} and RushrCurveRouter.{buy,sell}, with
 *   value <= per-trade cap, the rolling 24 h value sum <= daily cap, before expiry;
 * - ERC-20 approve whose spender is one of those routers, with value 0.
 * Never allowed: RushrRouter.sellAnyPool (user-confirmed exits only), transfers, other approvals,
 * Permit2, typed data, personal_sign, 7702.
 *
 * The JSON follows Privy's documented policy shape (docs.privy.io/controls/policies). Field names for the
 * aggregation reference and calldata conditions must be re-checked against Privy's API when the founder's
 * dev app exists. The policy's owner must be the USER's key quorum so Rushr can't loosen it.
 */
export interface SignerCaps {
  perTradeWei: bigint;
  dailyWei: bigint;
  /** Unix seconds. */
  expiresAt: number;
}

export const DEFAULT_CAPS = { perTradeWei: 250_000_000_000_000_000n, dailyWei: 1_000_000_000_000_000_000n, grantSeconds: 30 * 86_400 } as const;

export function defaultCaps(now: number): SignerCaps {
  return { perTradeWei: DEFAULT_CAPS.perTradeWei, dailyWei: DEFAULT_CAPS.dailyWei, expiresAt: now + DEFAULT_CAPS.grantSeconds };
}

export interface PolicyInput {
  /** e.g. 'quick-trade' or 'agent:<id>'. */
  purpose: string;
  /** The user's wallet (policy is per user; Privy policies have no "self" variable). */
  wallet: Address;
  rushrRouter: Address;
  curveRouter?: Address | null;
  caps: SignerCaps;
  /** Name of the app-level aggregation summing tx value per wallet over 24 h. */
  dailyAggregationId?: string;
}

/** Selectors the server signer may call. Exposed for tests and for an independent policy check. */
export function allowedSelectors() {
  const sel = (abi: readonly unknown[], name: string) => toFunctionSelector((abi as { type: string; name?: string }[]).find((f) => f.type === 'function' && f.name === name) as never);
  return {
    rushrBuy: sel(rushrRouterAbi, 'buy'),
    rushrSell: sel(rushrRouterAbi, 'sell'),
    rushrSellAnyPool: sel(rushrRouterAbi, 'sellAnyPool'), // NOT allowed; listed so tests can assert it
    curveBuy: sel(rushrCurveRouterAbi, 'buy'),
    curveSell: sel(rushrCurveRouterAbi, 'sell'),
    approve: '0x095ea7b3',
  };
}

const APPROVE_ABI = [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }];

export function buildSignerPolicy(p: PolicyInput) {
  if (p.caps.perTradeWei <= 0n || p.caps.dailyWei < p.caps.perTradeWei) throw new Error('caps: need 0 < perTrade <= daily');
  const routers = [p.rushrRouter, ...(p.curveRouter ? [p.curveRouter] : [])].map((a) => a.toLowerCase());
  const s = allowedSelectors();
  const selectors = [s.rushrBuy, s.rushrSell, ...(p.curveRouter ? [s.curveBuy, s.curveSell] : [])];
  const common = [
    { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
    { field_source: 'system', field: 'current_unix_timestamp', operator: 'lt', value: String(p.caps.expiresAt) },
  ];
  return {
    version: '1.0',
    name: `rushr:${p.purpose}:${p.wallet.toLowerCase()}`,
    chain_type: 'ethereum',
    rules: [
      {
        name: 'trade through Rushr routers within caps',
        method: 'eth_signTransaction',
        action: 'ALLOW',
        conditions: [
          ...common,
          { field_source: 'ethereum_transaction', field: 'to', operator: 'in', value: routers },
          { field_source: 'ethereum_calldata', field: 'function_selector', operator: 'in', value: selectors },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: p.caps.perTradeWei.toString() },
          { field_source: 'aggregation', field: p.dailyAggregationId ?? 'eth_value_24h', operator: 'lte', value: p.caps.dailyWei.toString() },
        ],
      },
      {
        name: 'approve Rushr routers only',
        method: 'eth_signTransaction',
        action: 'ALLOW',
        conditions: [
          ...common,
          { field_source: 'ethereum_calldata', field: 'approve.spender', operator: 'in', value: routers, abi: APPROVE_ABI },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
        ],
      },
    ],
  };
}
