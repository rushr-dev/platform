/**
 * Read-only pool survey: for each token, its pools (venue, hooks, currency0, tick spacing, v4 active
 * liquidity) and a 0.001 ETH buy quote per pool (SIDE=sell: a 1000-token sell). Public RPC, nothing signed.
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/pool-survey.ts <token> [token…]
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { fetchApiPools } from '../src/api-pools';
import { discoverPools } from '../src/pools';
import { quotePool } from '../src/quote';
import { resolveConfig } from '../src/config';
import { TRADE_ADDRESSES } from '../src/addresses';
import { v4StateViewAbi } from '../src/abis';
const c = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const liqAbi = [{ type: 'function', name: 'getLiquidity', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'uint128' }] }] as const;
const trader = '0x00000000000000000000000000000000b0b0b0b0' as Address;
for (const token of process.argv.slice(2) as Address[]) {
  try {
    const h = (await (await fetch(`https://api.rushr.trade/tokens/${token}`)).json()) as any;
    const rows = await fetchApiPools(token);
    const pools = await discoverPools(c, token, { mainPool: h.main_pool, createdBlock: h.created_block ? BigInt(h.created_block) : undefined, apiPools: rows, quoteAsset: 'ETH', trader });
    const lines: string[] = [];
    for (const p of pools) {
      let liq = '';
      if (p.venue === 'uniswap-v4') liq = ' liq=' + String(await c.readContract({ address: TRADE_ADDRESSES.v4.stateView, abi: liqAbi, functionName: 'getLiquidity', args: [p.id as `0x${string}`] }).catch(() => '?'));
      const hooks = p.venue === 'uniswap-v4' ? ' hooks=' + p.key.hooks.slice(0, 8) + ' c0=' + p.key.currency0.slice(0, 6) + ' ts=' + p.key.tickSpacing : '';
      let r = '';
      try { const q = await quotePool(c, p, { side: (process.env.SIDE ?? 'buy') as 'buy', token, quoteAsset: 'ETH', amountIn: process.env.SIDE === 'sell' ? 10n ** 21n : 10n ** 15n, trader, slippageBps: 500 }, resolveConfig()); r = 'OK ' + q.amountOut; }
      catch (e: any) { r = 'ERR ' + String(e.message).replace(/https?:\/\/\S+/g, '').slice(0, 110); }
      lines.push(`   ${p.venue}${hooks}${liq} -> ${r}`);
    }
    console.log(`${h.symbol} ${token} lp=${h.launchpad} quote=${(h.quote ?? '').slice(0, 6)} apiRows=${rows?.length ?? 'null'} pools=${pools.length}`);
    lines.forEach((l) => console.log(l));
  } catch (e: any) { console.log(token, 'FATAL', String(e.message).replace(/https?:\/\/\S+/g, '').slice(0, 150)); }
}
