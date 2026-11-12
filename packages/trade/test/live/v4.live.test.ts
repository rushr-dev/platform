/**
 * LIVE fixtures (read-only): Uniswap v4 tokens on Robinhood Chain, quoted and simulated against the
 * public RPC and the Rushr API. Nothing is signed or broadcast. Skipped unless LIVE=1:
 *
 *   pnpm --filter @rushr/trade test:live
 *
 * Chain state moves: a fixture that starts failing may have been rugged or migrated since
 * 2026-11-12. Check the pool's liquidity before "fixing" the engine.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../../src/chain';
import { fetchApiPools } from '../../src/api-pools';
import { quickBuy, quickSell } from '../../src/quick';

const LIVE = process.env.LIVE === '1';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const trader: Address = '0x00000000000000000000000000000000b0b0b0b0';

async function discover(token: Address) {
  const h = (await (await fetch(`https://api.rushr.trade/tokens/${token}`, { signal: AbortSignal.timeout(15_000) })).json()) as { main_pool?: `0x${string}`; created_block?: string };
  return { mainPool: h.main_pool ?? null, createdBlock: h.created_block ? BigInt(h.created_block) : undefined, apiPools: await fetchApiPools(token) };
}

/**
 * v4 pools of each kind seen on 2026-11-12. `sell`: what a sell from current state returns.
 * (GIRAFF, a plain v4 launch, quoted at 21:10 and had its liquidity pulled by 21:40: the common case.)
 */
const FIXTURES: { name: string; token: Address; kind: string; sell: 'quote' | RegExp }[] = [
  { name: 'FLC', token: '0xa581544c81b8c96218f0dd53b93aa82ef55b8360', kind: 'plain v4, native ETH, tickSpacing 1', sell: 'quote' },
  { name: 'PONS', token: '0x39dbed3a2bd333467115de45665cc57f813c4571', kind: 'graduated PONS, v4 with the PONS v2 hook', sell: 'quote' },
  { name: 'LLEAK', token: '0xda966f4a022fe922af2650ffd30c6a246992354c', kind: 'hooked v4, WETH currency0 (plus a drained plain pool)', sell: /hook rejects sells/ },
  { name: 'E/ACC', token: '0x67916e42208d50a8a61ae7ebeb4e87754c3549e7', kind: 'Doppler v4 (hooked), WETH numeraire, no buys yet', sell: /Nothing to sell into yet/ },
];

describe.skipIf(!LIVE)('live v4 quotes', () => {
  for (const f of FIXTURES)
    it(`${f.name}: ${f.kind}: buy quotes and simulates`, async () => {
      const d = await discover(f.token);
      const buy = await quickBuy(client, { token: f.token, ethWei: 10n ** 15n, trader }, { discover: d, acknowledgedHighRisk: true, assume: { ethWei: 10n ** 18n } });
      expect(buy.blockers, JSON.stringify(buy.blockers)).toEqual([]);
      expect(buy.quote!.amountOut).toBeGreaterThan(0n);
      expect(buy.warnings.join(' ')).not.toMatch(/simulation unavailable/i);
      const sell = await quickSell(client, { token: f.token, trader, amount: buy.quote!.amountOut / 2n }, { discover: d, simulate: false, assume: { ethWei: 10n ** 18n, tokenWei: buy.quote!.amountOut } });
      if (f.sell === 'quote') expect(sell.quote?.amountOut ?? 0n, JSON.stringify(sell.blockers)).toBeGreaterThan(0n);
      else expect(sell.blockers[0]?.message ?? '').toMatch(f.sell);
    }, 60_000);

  it('a v4 pool whose liquidity was withdrawn (AGENTIX 0xa5d7…a540, pulled ~10 min after launch) → LIQUIDITY_REMOVED', async () => {
    const token: Address = '0xa5d7a0df79ab3a43cde8b0a31e4b3458b962a540';
    const buy = await quickBuy(client, { token, ethWei: 10n ** 15n, trader }, { discover: await discover(token), assume: { ethWei: 10n ** 18n } });
    expect(buy.blockers.map((b) => b.code)).toEqual(['LIQUIDITY_REMOVED']);
  }, 60_000);

  it('a Doppler token priced in USDG (NIHAO) → NON_ETH_QUOTE, not "no pool"', async () => {
    const token: Address = '0xb9d6b00373afd8820ffea0956420a7e0ff93dd62';
    const buy = await quickBuy(client, { token, ethWei: 10n ** 15n, trader }, { discover: await discover(token), assume: { ethWei: 10n ** 18n } });
    expect(buy.blockers.map((b) => b.code)).toEqual(['NON_ETH_QUOTE']);
    expect(buy.blockers[0]!.message).toContain('USDG');
  }, 60_000);
});
