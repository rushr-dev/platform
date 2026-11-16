import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEther } from 'viem';

/**
 * Everything the server reads from its environment, parsed once at start-up. Caps can only be set
 * through the environment (the MCP client's config), never by a tool call, so a model can't raise them.
 */
export interface Config {
  apiUrl: string;
  rpcUrl: string;
  explorerUrl: string;
  /** Largest single buy, in USD. */
  maxTradeUsd: number;
  /** Total USD put into buys over any rolling 24 hours. */
  dailyUsd: number;
  /** Build and simulate, never sign or send. */
  dryRun: boolean;
  /** ETH always left in the wallet for gas. */
  gasReserveWei: bigint;
  /** Price impact caused by the trade's size (total minus the pool's fixed tax). */
  maxSizeImpactBps: number;
  /** Total price impact, the pool's fixed tax included. */
  maxTotalImpactBps: number;
  slippageBps: number;
  /** Where the API key (for RUSHR_PRIVATE_KEY wallets) and the daily spend ledger are kept. */
  stateDir: string;
  /** Where create_wallet writes a new keyfile, and where the server looks when no wallet is set: <stateDir>/agent-wallet.json. */
  defaultWalletFile: string;
  privateKey?: string;
  walletFile?: string;
  apiKey?: string;
}

export class ConfigError extends Error {}

const DEFAULTS = {
  apiUrl: 'https://api.rushr.trade',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  maxTradeUsd: 10,
  dailyUsd: 50,
  gasReserveEth: '0.001',
  maxSizeImpactBps: 300,
  maxTotalImpactBps: 500,
  slippageBps: 150,
};

/** Hard ceilings: an env var can lower the impact caps and slippage but not raise them past these. */
export const CEILINGS = { maxSizeImpactBps: 300, maxTotalImpactBps: 500, slippageBps: 500 } as const;

function positive(env: Record<string, string | undefined>, name: string, def: number, max?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number (got "${raw}")`);
  if (max !== undefined && n > max) throw new ConfigError(`${name} can't be above ${max} (got ${n})`);
  return n;
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const gasReserveEth = env.RUSHR_GAS_RESERVE_ETH || DEFAULTS.gasReserveEth;
  let gasReserveWei: bigint;
  try {
    gasReserveWei = parseEther(gasReserveEth);
  } catch {
    throw new ConfigError(`RUSHR_GAS_RESERVE_ETH must be an ETH amount like 0.001 (got "${gasReserveEth}")`);
  }
  if (gasReserveWei < parseEther(DEFAULTS.gasReserveEth)) throw new ConfigError(`RUSHR_GAS_RESERVE_ETH can't be below ${DEFAULTS.gasReserveEth}`);
  const privateKey = env.RUSHR_PRIVATE_KEY?.trim() || undefined;
  const stateDir = env.RUSHR_STATE_DIR || join(homedir(), '.rushr');
  const defaultWalletFile = join(stateDir, 'agent-wallet.json');
  let walletFile = env.RUSHR_WALLET_FILE?.trim() || undefined;
  if (privateKey && walletFile) throw new ConfigError('Set RUSHR_PRIVATE_KEY or RUSHR_WALLET_FILE, not both');
  // No wallet configured (e.g. installed as a Codex or Claude Code plugin): use the keyfile create_wallet writes, if it exists.
  if (!privateKey && !walletFile && existsSync(defaultWalletFile)) walletFile = defaultWalletFile;
  return {
    apiUrl: (env.RUSHR_API_URL || DEFAULTS.apiUrl).replace(/\/$/, ''),
    rpcUrl: env.RUSHR_RPC_URL || DEFAULTS.rpcUrl,
    explorerUrl: DEFAULTS.explorerUrl,
    maxTradeUsd: positive(env, 'RUSHR_MAX_TRADE_USD', DEFAULTS.maxTradeUsd),
    dailyUsd: positive(env, 'RUSHR_DAILY_USD', DEFAULTS.dailyUsd),
    dryRun: truthy(env.RUSHR_DRY_RUN),
    gasReserveWei,
    maxSizeImpactBps: positive(env, 'RUSHR_MAX_SIZE_IMPACT_BPS', DEFAULTS.maxSizeImpactBps, CEILINGS.maxSizeImpactBps),
    maxTotalImpactBps: positive(env, 'RUSHR_MAX_TOTAL_IMPACT_BPS', DEFAULTS.maxTotalImpactBps, CEILINGS.maxTotalImpactBps),
    slippageBps: positive(env, 'RUSHR_SLIPPAGE_BPS', DEFAULTS.slippageBps, CEILINGS.slippageBps),
    stateDir,
    defaultWalletFile,
    privateKey,
    walletFile,
    apiKey: env.RUSHR_API_KEY?.trim() || undefined,
  };
}

/** What the server tells a client about its configuration. No keys, no paths to key files. */
export function publicConfig(c: Config) {
  return {
    dryRun: c.dryRun,
    maxTradeUsd: c.maxTradeUsd,
    dailyUsd: c.dailyUsd,
    maxSizeImpactBps: c.maxSizeImpactBps,
    maxTotalImpactBps: c.maxTotalImpactBps,
    slippageBps: c.slippageBps,
    gasReserveEth: Number(c.gasReserveWei) / 1e18,
  };
}
