import type { Address } from 'viem';
import { rushrPonsRouterAbi } from './abis';
import { rushrRouterAbi } from './rushr-router';

/**
 * Privy policy for a Rushr session signer (quick-trade or one agent), in Privy's API schema
 * (POST /v1/policies, checked against the OpenAPI spec 2026-11-12). Defaults: 0.25 ETH per
 * trade, 1 ETH per rolling 24 h, 30-day grants, user-adjustable.
 *
 * Allowed (Privy denies anything no ALLOW rule matches):
 * - eth_signTransaction on chain 4663 calling RushrRouter.buy / RushrRouter.sell /
 *   RushrPonsRouter.buy / RushrPonsRouter.sell. Each rule pins `to` to that router and decodes the
 *   calldata with that one function's ABI (so any other selector, e.g. sellAnyPool, can't match);
 *   value <= per-trade cap (0 for sells); rolling 24 h value sum <= daily cap; before expiry.
 * - ERC-20 approve whose decoded `spender` is one of the routers, value 0.
 * Never allowed: sellAnyPool (user-confirmed exits), transfers, other approvals, Permit2, typed
 * data, personal_sign, 7702, other chains.
 *
 * The policy's owner must be the USER's key quorum (owner_id) so neither Rushr's app secret nor its
 * authorization key can loosen it.
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
  /** The user's wallet (for the policy name; Privy policies have no "self" variable). */
  wallet: Address;
  rushrRouter: Address;
  ponsRouter?: Address | null;
  caps: SignerCaps;
  /** Privy aggregation id summing ETH value over a rolling 24 h (see buildDailyValueAggregation). */
  dailyAggregationId: string;
  /** Key quorum id of the user (wallet owner). Required in production; omitted only in tests. */
  ownerId?: string | null;
}

type AbiFn = { type: 'function'; name: string; inputs: readonly unknown[]; outputs: readonly unknown[]; stateMutability: string };

/** Single-function JSON ABI (Privy's AbiSchema) for one router function. */
export function functionAbi(abi: readonly unknown[], name: string): AbiFn[] {
  const fn = (abi as AbiFn[]).find((f) => f.type === 'function' && f.name === name);
  if (!fn) throw new Error(`no function ${name}`);
  return [JSON.parse(JSON.stringify(fn)) as AbiFn];
}

export const APPROVE_ABI: AbiFn[] = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
];

/** Router functions the server signer may call: [label, router key, abi, function, payable]. */
function allowedCalls(p: PolicyInput) {
  const calls: { router: Address; abi: readonly unknown[]; fn: 'buy' | 'sell'; payable: boolean; label: string }[] = [
    { router: p.rushrRouter, abi: rushrRouterAbi, fn: 'buy', payable: true, label: 'RushrRouter.buy' },
    { router: p.rushrRouter, abi: rushrRouterAbi, fn: 'sell', payable: false, label: 'RushrRouter.sell' },
  ];
  if (p.ponsRouter)
    calls.push(
      { router: p.ponsRouter, abi: rushrPonsRouterAbi, fn: 'buy', payable: true, label: 'RushrPonsRouter.buy' },
      { router: p.ponsRouter, abi: rushrPonsRouterAbi, fn: 'sell', payable: false, label: 'RushrPonsRouter.sell' },
    );
  return calls;
}

export function buildSignerPolicy(p: PolicyInput) {
  if (p.caps.perTradeWei <= 0n || p.caps.dailyWei < p.caps.perTradeWei) throw new Error('caps: need 0 < perTrade <= daily');
  if (!p.dailyAggregationId) throw new Error('dailyAggregationId required');
  const routers = [p.rushrRouter, ...(p.ponsRouter ? [p.ponsRouter] : [])].map((a) => a.toLowerCase());
  const common = [
    { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' },
    { field_source: 'system', field: 'current_unix_timestamp', operator: 'lt', value: String(p.caps.expiresAt) },
  ];
  const rules = allowedCalls(p).map((c) => ({
    name: c.label,
    method: 'eth_signTransaction',
    action: 'ALLOW',
    conditions: [
      ...common,
      { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: c.router.toLowerCase() },
      // Decodes only if the calldata is exactly this function: other selectors (sellAnyPool) never match.
      { field_source: 'ethereum_calldata', field: `${c.fn}.deadline`, operator: 'gt', value: '0', abi: functionAbi(c.abi, c.fn) },
      c.payable
        ? { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: p.caps.perTradeWei.toString() }
        : { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
      { field_source: 'reference', field: `aggregation.${p.dailyAggregationId}`, operator: 'lte', value: p.caps.dailyWei.toString() },
    ],
  }));
  rules.push({
    name: 'approve Rushr routers only',
    method: 'eth_signTransaction',
    action: 'ALLOW',
    conditions: [
      ...common,
      { field_source: 'ethereum_calldata', field: 'approve.spender', operator: 'in', value: routers, abi: APPROVE_ABI } as never,
      { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
    ],
  });
  return {
    version: '1.0' as const,
    name: `rushr:${p.purpose}:${p.wallet.toLowerCase()}`.slice(0, 100),
    chain_type: 'ethereum' as const,
    rules,
    ...(p.ownerId ? { owner_id: p.ownerId } : {}),
  };
}

/**
 * App-level aggregation: rolling 24 h sum of ETH `value` signed on chain 4663 (POST /v1/aggregations).
 * Privy keeps it per wallet; Privy notes concurrent requests can race past it ("disaster prevention"),
 * so the per-trade cap stays the hard bound.
 */
export function buildDailyValueAggregation(name = 'rushr: ETH value per rolling 24h on 4663') {
  return {
    name,
    method: 'eth_signTransaction',
    metric: { field_source: 'ethereum_transaction', field: 'value', function: 'sum' },
    window: { type: 'rolling', seconds: 86_400 },
    conditions: [{ field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '4663' }],
  };
}
