/**
 * End-to-end simulation of beta trading v0: builds exactly the calls the Privy embedded wallet would
 * send for a quick buy and a quick sell (incl. approvals), and runs them in one eth_simulateV1 block from
 * a fresh address with a simulated ETH balance. Nothing is signed or broadcast. Public RPC (no secrets).
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/quick-sim.ts [token ...]
 */
import { createPublicClient, formatEther, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { quickBuy, quickSell } from '../src/quick';
import { simulateCalls, analyzeSwapTransfers, NATIVE_TRANSFER_EMITTER } from '../src/simulate';
import { fetchApiPools } from '../src/api-pools';
import { RUSHR_TREASURY } from '../src/config';

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const trader: Address = '0x00000000000000000000000000000000b0b0b0b0';
const tokens = (process.argv.slice(2).length ? process.argv.slice(2) : ['0x39dbed3a2bd333467115de45665cc57f813c4571', '0x8801a9f7f9f08ba843f1af0e9832026201d60087', '0x89964d7fcd9cdee7c1e4fdc17b997bb979b05525']) as Address[];

async function hints(token: Address) {
  try {
    const t = (await (await fetch(`https://api.rushr.trade/tokens/${token}`)).json()) as { main_pool?: `0x${string}`; created_block?: string; symbol?: string; risk?: string };
    return { mainPool: t.main_pool ?? null, createdBlock: t.created_block ? BigInt(t.created_block) : undefined, symbol: t.symbol ?? token.slice(0, 8), risk: t.risk };
  } catch {
    return { mainPool: null, createdBlock: undefined, symbol: token.slice(0, 8), risk: undefined };
  }
}

let failures = 0;
for (const token of tokens) {
  const h = await hints(token);
  console.log(`\n=== ${h.symbol} ${token} (risk ${h.risk ?? '?'})`);
  const discover = { mainPool: h.mainPool, createdBlock: h.createdBlock, apiPools: await fetchApiPools(token) };
  const ethIn = 10n ** 16n;
  const buy = await quickBuy(client, { token, ethWei: ethIn, trader }, { discover, assume: { ethWei: 10n ** 18n }, acknowledgedHighRisk: true });
  if (!buy.ok) {
    console.log(`  buy blocked: ${buy.blockers.map((b) => `${b.code}: ${b.message}`).join(' | ')}`);
    if (!buy.blockers.every((b) => b.code === 'CURVE_NOT_GRADUATED')) failures++;
    continue;
  }
  const q = buy.quote!;
  console.log(`  buy:  ${q.pool.venueFeeLabel} | slippage ${buy.slippageBps / 100}% | expect ${q.amountOut} min ${q.minAmountOut} | calls ${buy.calls.map((c) => c.label).join(', ')} | gas ${buy.calls.map((c) => c.gas).join('/')}`);

  // Sell 90% of the expected amount right after the buy, in the same simulated block.
  const sellAmount = (q.amountOut * 9n) / 10n;
  const sell = await quickSell(client, { token, trader, amount: sellAmount }, { discover, simulate: false, assume: { ethWei: 10n ** 18n, tokenWei: sellAmount } });
  if (!sell.quote) {
    // Launch pools with one-sided liquidity (e.g. lift.fun) can't quote a sell until a buy has landed;
    // a real user's own buy creates that liquidity. Only the buy is checked here.
    const sim = await simulateCalls(client, buy.calls.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: 10n ** 18n } });
    const b = analyzeSwapTransfers(q, sim.transfers, RUSHR_TREASURY);
    const ok = sim.ok && b.received >= q.minAmountOut && b.feePaid === q.fee.feeAmount;
    if (!ok) failures++;
    console.log(`  buy sim: ${sim.ok ? 'ok' : 'REVERT'} | received ${b.received} | fee ${formatEther(b.feePaid)} ETH`);
    console.log(`  sell: not quotable before any buy (${sell.blockers.map((x) => x.code).join(', ')}): one-sided launch liquidity, expected`);
    console.log(`  => ${ok ? 'PASS (buy)' : 'FAIL'}`);
    continue;
  }
  const all = [...buy.calls, ...sell.calls].map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label }));
  const sim = await simulateCalls(client, all, { fund: { [trader]: 10n ** 18n } });
  const buyIdx = 0;
  const sellIdx = all.length - 1;
  const b = analyzeSwapTransfers(q, sim.transfers.filter((t) => t.callIndex === buyIdx), RUSHR_TREASURY);
  // Sell quoted at pre-buy state: re-check the minimum against what actually happened.
  const s = analyzeSwapTransfers(sell.quote, sim.transfers.filter((t) => t.callIndex === sellIdx), RUSHR_TREASURY);
  const feeEth = sim.transfers.filter((t) => t.token === NATIVE_TRANSFER_EMITTER && t.to.toLowerCase() === RUSHR_TREASURY.toLowerCase());
  const ok = sim.ok && b.received >= q.minAmountOut && b.feePaid === q.fee.feeAmount && s.received > 0n;
  if (!ok) failures++;
  console.log(`  sim:  ${sim.calls.map((c) => `${c.label}=${c.ok ? 'ok' : `REVERT ${c.error}`}`).join(', ')}`);
  console.log(`  buy:  received ${b.received} (quoted ${q.amountOut}) | fee to treasury ${formatEther(b.feePaid)} ETH (expected ${formatEther(q.fee.feeAmount)}) | tax ${b.tokenTaxBps}bps`);
  console.log(`  sell: ${sellAmount} tokens → ${formatEther(s.received)} ETH to user (min at pre-buy state ${formatEther(sell.quote.minAmountOut)}) | fee ${formatEther(s.feePaid)} ETH | treasury transfers ${feeEth.length}`);
  console.log(`  => ${ok ? 'PASS' : 'FAIL'}`);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exitCode = failures ? 1 : 0;
