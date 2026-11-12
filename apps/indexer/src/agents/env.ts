import type { Env } from '../env';

/** Bindings the members/social/agents API reads. All flags are off unless set to "1". */
export interface AgentsEnv extends Env {
  /** Mounts /v1 at all. */
  AGENTS_ENABLED?: string;
  /** /v1/leaderboard. */
  LEADERBOARD_ENABLED?: string;
  /** Agent self-registration and API keys (SIWE). */
  AGENT_SIGNUP_ENABLED?: string;
  /** /v1/trade/* (quotes and unsigned transactions). */
  AGENT_TRADE_ENABLED?: string;
  /** Human sign-up needs an invite code (beta). */
  INVITES_REQUIRED?: string;
  PRIVY_APP_ID?: string;
  /** Secret (wrangler secret). Used only to read a user's linked wallet and X account from Privy. */
  PRIVY_APP_SECRET?: string;
  /** Salt for hashing client IPs in rate limits (wrangler secret). */
  IP_SALT?: string;
  /** Allowed browser origins for authenticated calls, comma separated. Default https://rushr.trade. */
  WEB_ORIGINS?: string;
}

export const on = (v: string | undefined) => v === '1' || v === 'true';
