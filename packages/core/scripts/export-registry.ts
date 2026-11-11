/**
 * Write the Robinhood Chain registry as plain JSON, for the public rushr-dev/registry repo
 * and anyone who wants the addresses without pulling in TypeScript.
 * Usage: npm run registry -- [outDir=.]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ETH_USD_REFERENCE_POOLS,
  INFRA_ADDRESSES,
  LAUNCHPADS,
  MINOR_V4_LAUNCHERS,
  NATIVE_ETH,
  QUOTES,
  ROBINHOOD_CHAIN,
  STOCK_QUOTES,
  TOPICS,
  UNISWAP,
} from '../src/chain/robinhood.ts';

const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

const files: Record<string, unknown> = {
  'chain.json': ROBINHOOD_CHAIN,
  'quotes.json': { native: NATIVE_ETH, ...QUOTES, stocks: STOCK_QUOTES, ethUsdReferencePools: ETH_USD_REFERENCE_POOLS },
  'dex.json': UNISWAP,
  'launchpads.json': LAUNCHPADS.map(({ launchesPer12h: _activity, ...lp }) => lp),
  'minor-v4-launchers.json': Object.entries(MINOR_V4_LAUNCHERS).map(([hook, launcher]) => ({ hook, launcher })),
  'infra.json': INFRA_ADDRESSES,
  'topics.json': TOPICS,
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(outDir, name), JSON.stringify(data, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(files).length} files to ${outDir}`);
