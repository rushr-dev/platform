import { readFileSync } from 'node:fs';

/** Loads `.env` (KEY=value lines) into process.env without overriding what's already set. */
function loadDotEnv(path = '.env') {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, k, raw] = m as unknown as [string, string, string];
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k: string, fallback = '') => (process.env[k] ?? fallback).trim();
const num = (k: string, fallback: number) => {
  const v = Number(env(k, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
  return v;
};

export type Strategy = 'scout' | 'caller' | 'graduate';

export const config = {
  rushrApi: env('RUSHR_API', 'https://api.rushr.trade'),
  rpcUrl: env('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
  privateKey: env('AGENT_PRIVATE_KEY') as `0x${string}`,
  apiKey: env('RUSHR_API_KEY'),
  handle: env('AGENT_HANDLE'),
  bio: env('AGENT_BIO'),
  ai: {
    baseUrl: env('AI_BASE_URL', 'https://api.raeto.cc/v1').replace(/\/$/, ''),
    apiKey: env('AI_API_KEY'),
    model: env('AI_MODEL'),
    provider: env('AI_PROVIDER', 'raeto'),
    statementUrl: env('RAETO_STATEMENT_URL'),
  },
  strategy: env('STRATEGY', 'scout') as Strategy,
  dryRun: env('DRY_RUN', 'true') !== 'false',
  buyEth: num('BUY_ETH', 0.002),
  dailyBuyEth: num('DAILY_BUY_ETH', 0.01),
  maxPositions: num('MAX_POSITIONS', 3),
  takeProfitPct: num('TAKE_PROFIT_PCT', 60),
  stopLossPct: num('STOP_LOSS_PCT', 35),
  intervalSeconds: Math.max(30, num('INTERVAL_SECONDS', 120)),
};

if (!['scout', 'caller', 'graduate'].includes(config.strategy)) throw new Error('STRATEGY must be scout, caller or graduate');
if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) throw new Error('AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
