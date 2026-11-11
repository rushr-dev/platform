import type { ChainPoller } from './poller';
import type { LiveFeed } from './feed';
import type { Backfiller } from './backfill';

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
  CHAIN_POLLER: DurableObjectNamespace<ChainPoller>;
  LIVE_FEED: DurableObjectNamespace<LiveFeed>;
  BACKFILLER: DurableObjectNamespace<Backfiller>;
  ENRICH_QUEUE: Queue<EnrichMessage>;
}

export type EnrichMessage =
  | { kind: 'wallet-funding'; wallet: string }
  | { kind: 'token-signals'; token: string }
  | { kind: 'token-metadata'; token: string; /** Only check DexScreener (no RPC): used for periodic retries. */ dexOnly?: boolean };

export function dbUrl(env: Env): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error('No database configured: set HYPERDRIVE binding or DATABASE_URL');
  return url;
}
