import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, type Address, type PublicClient } from 'viem';
import { autoSlippageBps, evaluateGuards, isFresh, prepareQuickTrade, quickBuy, quickSell, DEFAULT_QUICK_SETTINGS, explorerTxUrl, feeLine } from '../src/quick';
import { quotePool } from '../src/quote';
import { resolveConfig, RUSHR_TREASURY } from '../src/config';
import { TRADE_ADDRESSES } from '../src/addresses';
import { universalRouterAbi } from '../src/universal-router';
import { erc20Abi, permit2Abi } from '../src/abis';
import type { PonsPool, V2Pool } from '../src/types';

const TRADER: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const v2: V2Pool = { venue: 'uniswap-v2', id: '0x8018ee3ad3000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, reserveToken: 10n ** 27n, reserveQuote: 10n ** 21n, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2' };
const curve = { venue: 'pons-curve', id: '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050', graduated: false } as unknown as PonsPool;
/** Only gas price is read from the "chain" (balances come from `assume`, quotes from v2 reserves). */
const fake = { getGasPrice: async () => 100_000_000n } as unknown as PublicClient;
const E = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const opts = (o: object = {}) => ({ discover: { pools: [v2] }, simulate: false, assume: { ethWei: E(1), tokenWei: 10n ** 24n }, now: () => 1_000_000, ...o });

describe('automatic slippage', () => {
  it('5% base, up to 15% for young / volatile / high-impact tokens, plus tax on top', () => {
    expect(autoSlippageBps({ side: 'buy' })).toBe(500);
    expect(autoSlippageBps({ side: 'buy', ageMinutes: 30 })).toBe(800);
    expect(autoSlippageBps({ side: 'buy', ageMinutes: 5 })).toBe(1000);
    expect(autoSlippageBps({ side: 'buy', ageMinutes: 5, priceChange5mPct: -60 })).toBe(1500);
    expect(autoSlippageBps({ side: 'buy', ageMinutes: 5, priceChange5mPct: 80, priceImpactBps: 900 })).toBe(1500);
    expect(autoSlippageBps({ side: 'sell', taxBps: 1000 })).toBe(1500);
    expect(autoSlippageBps({ side: 'buy', ageMinutes: 1, priceChange5mPct: 90, taxBps: 2000 })).toBe(3500);
  });
});

describe('guards', () => {
  const base = async (side: 'buy' | 'sell', amountIn: bigint) => quotePool(fake, v2, { side, token: TOKEN, quoteAsset: 'ETH', amountIn, trader: TRADER, slippageBps: 500 }, resolveConfig());

  it('per-trade cap (default 0.25 ETH), on buys and on expected sell output', async () => {
    const ok = evaluateGuards({ quote: await base('buy', E(0.25)), settings: DEFAULT_QUICK_SETTINGS, acknowledgedHighRisk: false, ethBalanceWei: E(1), gasCostWei: 1n });
    expect(ok.blockers).toEqual([]);
    const over = evaluateGuards({ quote: await base('buy', E(0.26)), settings: DEFAULT_QUICK_SETTINGS, acknowledgedHighRisk: false, ethBalanceWei: E(1), gasCostWei: 1n });
    expect(over.blockers.map((b) => b.code)).toEqual(['OVER_CAP']);
    const raised = evaluateGuards({ quote: await base('buy', E(0.26)), settings: { ...DEFAULT_QUICK_SETTINGS, maxTradeWei: E(1) }, acknowledgedHighRisk: false, ethBalanceWei: E(2), gasCostWei: 1n });
    expect(raised.blockers).toEqual([]);
    const bigSell = evaluateGuards({ quote: await base('sell', 10n ** 26n), settings: DEFAULT_QUICK_SETTINGS, acknowledgedHighRisk: false, ethBalanceWei: E(1), tokenBalanceWei: 10n ** 26n, gasCostWei: 1n });
    expect(bigSell.blockers.map((b) => b.code)).toContain('OVER_CAP');
  });

  it('high risk needs "I understand" on buys only; honeypot always blocks; balances incl. gas', async () => {
    const q = await base('buy', E(0.1));
    const high = { risk: 'high' as const, verdict: 'Dev holds 40%' };
    expect(evaluateGuards({ quote: q, settings: DEFAULT_QUICK_SETTINGS, risk: high, acknowledgedHighRisk: false, ethBalanceWei: E(1), gasCostWei: 1n }).blockers[0]).toMatchObject({ code: 'RISK_ACK_REQUIRED', message: expect.stringContaining('Dev holds 40%') });
    expect(evaluateGuards({ quote: q, settings: DEFAULT_QUICK_SETTINGS, risk: high, acknowledgedHighRisk: true, ethBalanceWei: E(1), gasCostWei: 1n }).blockers).toEqual([]);
    expect(evaluateGuards({ quote: q, settings: DEFAULT_QUICK_SETTINGS, risk: { honeypot: true }, acknowledgedHighRisk: true, ethBalanceWei: E(1), gasCostWei: 1n }).blockers.map((b) => b.code)).toEqual(['HONEYPOT']);
    expect(evaluateGuards({ quote: q, settings: DEFAULT_QUICK_SETTINGS, acknowledgedHighRisk: false, ethBalanceWei: E(0.1), gasCostWei: 1n }).blockers.map((b) => b.code)).toEqual(['INSUFFICIENT_ETH']);
    const s = await base('sell', 10n ** 21n);
    expect(evaluateGuards({ quote: s, settings: DEFAULT_QUICK_SETTINGS, risk: high, acknowledgedHighRisk: false, ethBalanceWei: 0n, tokenBalanceWei: 0n, gasCostWei: 10n }).blockers.map((b) => b.code)).toEqual(['INSUFFICIENT_TOKEN', 'INSUFFICIENT_ETH']);
  });
});

describe('prepareQuickTrade (Universal Router, client-side signing)', () => {
  it('buy: one swap call to the Universal Router, fee to the treasury, recipient = user', async () => {
    const t = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts());
    expect(t.ok).toBe(true);
    expect(t.calls.map((c) => c.label)).toEqual(['swap']);
    const call = t.calls[0]!;
    expect(call).toMatchObject({ chainId: 4663, to: TRADE_ADDRESSES.universalRouter, value: E(0.1) });
    const d = decodeFunctionData({ abi: universalRouterAbi, data: call.data });
    expect(d.args[0]).toBe('0x050b08'); // TRANSFER fee, WRAP_ETH, V2_SWAP_EXACT_IN
    const [token, recipient, fee] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], d.args[1][0]!);
    expect([token, recipient, fee]).toEqual(['0x0000000000000000000000000000000000000000', RUSHR_TREASURY, E(0.0005)]);
    expect(t.slippageBps).toBe(500);
    expect(t.record).toMatchObject({ side: 'buy', feeBps: 50, venue: 'uniswap-v2', source: { kind: 'web' } });
    expect(isFresh(t, 1_000_000 + 9_999)).toBe(true);
    expect(isFresh(t, 1_000_000 + 10_001)).toBe(false);
    expect(feeLine(t.quote!)).toBe('Rushr fee 0.5%');
  });

  it('sell: approval calls first (ERC-20 → Permit2, Permit2 → Universal Router, 30 days), then the swap', async () => {
    const t = await quickSell(fake, { token: TOKEN, trader: TRADER, percent: 50 }, opts());
    expect(t.quote!.amountIn).toBe(5n * 10n ** 23n);
    expect(t.calls.map((c) => c.label)).toEqual(['approve token for Permit2', 'allow Universal Router in Permit2', 'swap']);
    const a = decodeFunctionData({ abi: erc20Abi, data: t.calls[0]!.data });
    expect([String(a.args[0]).toLowerCase(), a.args[1]]).toEqual([TRADE_ADDRESSES.permit2, 2n ** 256n - 1n]);
    expect(t.calls[0]!.to).toBe(TOKEN);
    const p = decodeFunctionData({ abi: permit2Abi, data: t.calls[1]!.data });
    expect([String(p.args[0]).toLowerCase(), String(p.args[1]).toLowerCase(), p.args[2]]).toEqual([TOKEN, resolveConfig().universalRouter.toLowerCase(), (1n << 160n) - 1n]);
    expect(p.args[3]).toBe(1_000 + 30 * 86_400);
    expect(decodeFunctionData({ abi: universalRouterAbi, data: t.calls[2]!.data }).args[0]).toBe('0x080c0604'); // V2 swap, UNWRAP, PAY_PORTION, SWEEP
  });

  it('PONS curve tokens: tradable after graduation, even if other pools exist; no pools: clear message', async () => {
    const c = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ discover: { pools: [curve] } }));
    expect(c).toMatchObject({ ok: false, calls: [], blockers: [{ code: 'CURVE_NOT_GRADUATED', message: expect.stringContaining('Tradable after graduation') }] });
    // Found live: a token still on its curve also had a stray 89%-fee v4 pool. Never route it.
    const both = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ discover: { pools: [v2, curve] } }));
    expect(both.blockers[0]!.code).toBe('CURVE_NOT_GRADUATED');
    const n = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ discover: { pools: [] } }));
    expect(n.blockers[0]!.code).toBe('NO_ROUTE');
  });

  it('never routes pools with a venue fee above 10%, and blocks price impact above 30%', async () => {
    const trap = { ...v2, id: '0x1111111111111111111111111111111111111111', venueFeeBps: 8_900, venueFeeLabel: 'Uniswap v4 · 89.00% pool fee', reserveQuote: 10n ** 30n } as V2Pool;
    const t = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ discover: { pools: [trap, v2] } }));
    expect(t.quote!.pool.id).toBe(v2.id);
    const only = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ discover: { pools: [trap] } }));
    expect(only.blockers[0]).toMatchObject({ code: 'NO_ROUTE', message: expect.stringContaining('above 10%') });
    const thin = { ...v2, reserveQuote: 10n ** 17n, reserveToken: 10n ** 24n } as V2Pool; // 0.1 ETH of liquidity
    const big = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ discover: { pools: [thin] } }));
    expect(big.blockers.map((b) => b.code)).toContain('HIGH_IMPACT');
  });

  it('blocks over the cap and high risk without acknowledgement; referred users pay 0.45%', async () => {
    const big = await quickBuy(fake, { token: TOKEN, ethWei: E(0.5), trader: TRADER }, opts());
    expect(big.ok).toBe(false);
    expect(big.blockers.map((b) => b.code)).toEqual(['OVER_CAP']);
    expect(big.calls).toHaveLength(1); // built for display, but not sendable
    const risky = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ risk: { risk: 'high', ageMinutes: 3 } }));
    expect(risky.blockers.map((b) => b.code)).toEqual(['RISK_ACK_REQUIRED']);
    expect(risky.slippageBps).toBe(1000); // young token
    const ref = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER, referral: { referrer: '0x5555555555555555555555555555555555555555' } }, opts());
    expect(ref.quote!.fee.feeBps).toBe(45);
    expect(explorerTxUrl('0xabc')).toBe('https://robinhoodchain.blockscout.com/tx/0xabc');
  });
});
