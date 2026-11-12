import type { Address, Hex, PublicClient } from 'viem';
import { buildSwap, type BuildOptions } from './build';
import { assertSignable, resolveConfig, type TradeConfig } from './config';
import { findBestRoute } from './quote';
import { draftTradeRecord, type TradeRecord } from './referral';
import { simulateSwap, type SwapSimulation } from './simulate';
import type { DiscoverOptions } from './pools';
import { fetchApiPools, hintsFromApiPools, unroutableNote } from './api-pools';
import type { Approval, Pool, Quote, SwapRequest } from './types';

/**
 * Server / agent entry point: plain async functions, no browser globals, no keys. Agents (and the API)
 * get an UNSIGNED transaction plus the approvals it needs and the ledger record to store; signing
 * happens elsewhere, by the wallet that owns the funds.
 */
export interface PrepareOptions extends BuildOptions {
  /** Partial config merged over the defaults (fee rate, treasury, routers). */
  config?: Partial<TradeConfig>;
  discover?: Omit<DiscoverOptions, 'quoteAsset'> & { pools?: Pool[] };
  /** Run eth_simulateV1 on the built tx (approvals included). Default false. */
  simulate?: boolean;
  /** ETH added to the trader's balance inside the simulation only (lets agents dry-run without funds). */
  simulateFundEth?: bigint;
  /** Refuse unless the config is ready for real signing (treasury set). Default false. */
  forSigning?: boolean;
  /** Rushr API base for `/tokens/:a/pools` hints (default https://api.rushr.trade); false disables the lookup. */
  apiUrl?: string | false;
  fetch?: typeof fetch;
}

export interface PreparedSwap {
  quote: Quote;
  /** Other quoted routes, best first (excluding `quote`). */
  alternatives: Quote[];
  tx: { chainId: number; to: Address; data: Hex; value: bigint };
  approvals: Approval[];
  commands: string[];
  deadline: bigint;
  /** Ledger row to store when the tx is submitted (fee, referral accrual, source). */
  record: TradeRecord;
  simulation?: SwapSimulation;
  warnings: string[];
}

export async function prepareSwap(client: PublicClient, req: SwapRequest, opts: PrepareOptions = {}): Promise<PreparedSwap> {
  const cfg = resolveConfig(opts.config);
  if (opts.forSigning) assertSignable(cfg);
  let discover = opts.discover;
  let note: string | null = null;
  if (!discover?.pools && !discover?.apiPools && opts.apiUrl !== false) {
    const apiPools = await fetchApiPools(req.token, { apiUrl: opts.apiUrl || undefined, fetch: opts.fetch });
    if (apiPools) {
      discover = { ...discover, apiPools };
      note = unroutableNote(hintsFromApiPools(apiPools, req.quoteAsset));
    }
  }
  const route = await findBestRoute(client, req, cfg, discover);
  const built = buildSwap(route.best, cfg, opts);
  const simulation = opts.simulate ? await simulateSwap(client, built, cfg, opts.simulateFundEth ? { fundEth: opts.simulateFundEth } : {}) : undefined;
  return {
    quote: route.best,
    alternatives: route.quotes.filter((q) => q !== route.best),
    tx: { chainId: 4663, ...built.tx },
    approvals: built.approvals,
    commands: built.commands.map((c) => c.label),
    deadline: built.deadline,
    record: draftTradeRecord(route.best, cfg, built.tx.to, opts.now),
    simulation,
    warnings: note ? [...route.best.warnings, note] : route.best.warnings,
  };
}

/** JSON-safe copy (bigint → decimal string) for agent tool results, HTTP responses and logs. */
export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  return value;
}
