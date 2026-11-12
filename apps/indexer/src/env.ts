import type { ChainPoller } from './poller';
import type { LiveFeed } from './feed';
import type { Backfiller } from './backfill';
import type { Gateway } from './gateway';
import type { RpcBudget, TokenHydrator } from './hydrator';

export interface Env {
  CHAIN_ID: string;
  BLOCKSCOUT_API: string;
  RPC_URL: string;
  /** Bearer token for /admin/* in production (wrangler secret). */
  ADMIN_TOKEN?: string;
  DATABASE_URL?: string;
  /** First run only: how many blocks before head to start from (default 33000 ≈ 1h). */
  START_BLOCKS_BACK?: string;
  HYPERDRIVE?: Hyperdrive;
  /** '1': stream v3/v2 swaps of tracked pools over the socket (address-filtered). Otherwise polling only (~2-4s). */
  LIVE_PAIRS?: string;
  /** Cap on pools in the pair-swap socket subscription (default 150). */
  PAIR_SUB_MAX?: string;
  CHAIN_POLLER: DurableObjectNamespace<ChainPoller>;
  LIVE_FEED: DurableObjectNamespace<LiveFeed>;
  BACKFILLER: DurableObjectNamespace<Backfiller>;
  /** Realtime v2 gateways (docs/realtime.md). */
  GATEWAY: DurableObjectNamespace<Gateway>;
  /** Read-through hydration, one per token, and its global rate limit. */
  HYDRATOR: DurableObjectNamespace<TokenHydrator>;
  RPC_BUDGET: DurableObjectNamespace<RpcBudget>;
  ENRICH_QUEUE: Queue<EnrichMessage>;
  /** Token metadata only, so new launches get icons without waiting behind signal recomputes. */
  METADATA_QUEUE: Queue<EnrichMessage>;
}

export type EnrichMessage =
  | { kind: 'wallet-funding'; wallet: string }
  | { kind: 'token-signals'; token: string }
  | {
      kind: 'token-metadata';
      token: string;
      /** Only check DexScreener (no RPC): used for periodic retries. */
      dexOnly?: boolean;
      /** Follow-up number for launches whose metadata wasn't loadable yet (see METADATA_RETRY_S). */
      attempt?: number;
    };

/**
 * The poller, pinned to Asia-Pacific next to the database (Neon, Singapore). Durable Objects live
 * where they were first created and never move, so this is a new instance; 'main' (created in the
 * US) is the retired one, stopped via /admin/poller-legacy/stop.
 */
export const poller = (env: Env) => env.CHAIN_POLLER.get(env.CHAIN_POLLER.idFromName('main-apac'), { locationHint: 'apac' });

/** Pool-history backfill queue (a Backfiller instance of its own), next to the database. */
export const poolHistory = (env: Env) => env.BACKFILLER.get(env.BACKFILLER.idFromName('pools'), { locationHint: 'apac' });

/** Positions rebuild (a Backfiller instance of its own). */
export const positionsJob = (env: Env) => env.BACKFILLER.get(env.BACKFILLER.idFromName('positions'), { locationHint: 'apac' });

/** Full-history holder backfill queue (a Backfiller instance of its own), next to the database. */
export const holderHistory = (env: Env) => env.BACKFILLER.get(env.BACKFILLER.idFromName('holders'), { locationHint: 'apac' });

export function dbUrl(env: Env): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error('No database configured: set HYPERDRIVE binding or DATABASE_URL');
  return url;
}
