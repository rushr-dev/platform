import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEther, type Address, type Hex } from 'viem';
import { loadConfig } from '../src/config.ts';
import { checkBuyCaps, checkImpact, checkSafety, GuardError, probeAmount, SpendLedger, splitImpact, vetBuild } from '../src/guards.ts';
import { checkEthUsd } from '../src/price.ts';
import { withDisclosure } from '../src/rushr.ts';
import { built } from './fixtures.ts';

const TOKEN = '0x30768b5482e5dd8a2487ce0be61e01fa03af37ff' as Address;
const UR = '0x204faca1764b154221e35c0d20abb3c525710498' as Address;
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address;

const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof GuardError ? e.code : `not a GuardError: ${e}`;
  }
  return null;
};

describe('vetBuild', () => {
  it('accepts a clean ETH buy', () => expect(refusal(() => vetBuild(built(), 'buy', TOKEN, 1000n))).toBeNull());
  it('accepts a sell with token->Permit2 and Permit2->router approvals', () => {
    const b = built({ approvals: [
      { kind: 'erc20', token: TOKEN, spender: PERMIT2, amount: '1000', tx: { to: TOKEN, data: '0x095ea7b3aa' as Hex, value: '0' } },
      { kind: 'permit2', token: TOKEN, spender: UR, amount: '1000', tx: { to: PERMIT2, data: '0x87517c45bb' as Hex, value: '0' } },
    ] }, 1000n, 'sell');
    expect(refusal(() => vetBuild(b, 'sell', TOKEN, 1000n))).toBeNull();
  });
  it.each([
    ['unknown router', built({ tx: { chainId: 4663, to: '0x1111111111111111111111111111111111111111', data: '0x', value: '1000' } })],
    ['wrong chain', built({ tx: { chainId: 1, to: UR, data: '0x', value: '1000' } })],
    ['value differs from amountIn', built({ tx: { chainId: 4663, to: UR, data: '0x', value: '2000' } })],
    ['fee above 25 bps', built({ quote: { ...built().quote, fee: { feeBps: 50, feeAmount: '5' } } })],
    ['failed simulation', built({ simulation: { ok: false, error: 'reverted' } })],
    ['missing simulation', built({ simulation: null })],
    ['buy asking for approvals', built({ approvals: [{ kind: 'erc20', token: TOKEN, spender: PERMIT2, amount: '1', tx: { to: TOKEN, data: '0x095ea7b3' as Hex, value: '0' } }] })],
  ])('refuses: %s', (_, b) => expect(refusal(() => vetBuild(b, 'buy', TOKEN, 1000n))).toBe('refused_unsafe_build'));
  it('refuses an approval to anything but the token or Permit2', () => {
    const b = built({ approvals: [{ kind: 'erc20', token: TOKEN, spender: UR, amount: '1', tx: { to: '0x2222222222222222222222222222222222222222', data: '0x095ea7b3' as Hex, value: '0' } }] }, 1000n, 'sell');
    expect(refusal(() => vetBuild(b, 'sell', TOKEN, 1000n))).toBe('refused_unsafe_build');
  });
  it('refuses a sell carrying ETH value', () => {
    const b = built({ tx: { chainId: 4663, to: UR, data: '0x', value: '1' } }, 1000n, 'sell');
    expect(refusal(() => vetBuild(b, 'sell', TOKEN, 1000n))).toBe('refused_unsafe_build');
  });
});

describe('price impact: hook tax floor vs size impact', () => {
  const caps = { maxSizeImpactBps: 300, maxTotalImpactBps: 500 };
  it('probes at 1/20 of the size', () => expect(probeAmount(2000n)).toBe(100n));
  it('splits the fixed floor from size impact', () => expect(splitImpact(409, 400)).toEqual({ totalBps: 409, floorBps: 400, sizeBps: 9 }));
  it('treats a probe above the total as all size impact', () => expect(splitImpact(100, 150)).toEqual({ totalBps: 100, floorBps: 100, sizeBps: 0 }));
  it('refuses a missing impact', () => expect(refusal(() => splitImpact(null, 10))).toBe('refused_price_impact'));
  // Live numbers measured on 2026-11-16 (PURSER: 4% hook tax; NOMAD: no tax, real size impact).
  it('passes a 4% tax token with tiny size impact', () => expect(refusal(() => checkImpact(splitImpact(409, 400), caps))).toBeNull());
  it('refuses size impact over 3%', () => expect(refusal(() => checkImpact(splitImpact(420, 100), caps))).toBe('refused_size_impact'));
  it('refuses total over 5% even with small size impact', () => expect(refusal(() => checkImpact(splitImpact(560, 550), caps))).toBe('refused_total_impact'));
});

describe('buy caps', () => {
  const base = { usd: 8, amountWei: parseEther('0.004'), maxTradeUsd: 10, dailyUsd: 50, spent24hUsd: 0, freeWei: parseEther('0.01'), dryRun: false };
  it('passes inside every cap', () => expect(checkBuyCaps(base)).toEqual([]));
  it('refuses above the per-trade cap', () => expect(refusal(() => checkBuyCaps({ ...base, usd: 10.01 }))).toBe('refused_trade_cap'));
  it('refuses past the daily cap', () => expect(refusal(() => checkBuyCaps({ ...base, spent24hUsd: 45 }))).toBe('refused_daily_cap'));
  it('refuses dipping into the gas reserve', () => expect(refusal(() => checkBuyCaps({ ...base, freeWei: parseEther('0.001') }))).toBe('refused_gas_reserve'));
  it('only warns about the balance in dry run', () => expect(checkBuyCaps({ ...base, freeWei: 0n, dryRun: true })[0]).toMatch(/would be refused/));
  it('still refuses caps in dry run', () => expect(refusal(() => checkBuyCaps({ ...base, usd: 11, dryRun: true }))).toBe('refused_trade_cap'));
  it('refuses zero', () => expect(refusal(() => checkBuyCaps({ ...base, usd: 0 }))).toBe('refused_amount'));
});

describe('spend ledger', () => {
  it('sums the last 24 hours and persists with mode 600', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rushr-mcp-')), 'spend.json');
    const now = 1_800_000_000_000;
    const l = new SpendLedger(path);
    l.record(10, '0xa', now - 25 * 3_600_000);
    l.record(7, '0xb', now - 3_600_000);
    l.record(5, '0xc', now);
    expect(l.spent24h(now)).toBe(12);
    expect(new SpendLedger(path).spent24h(now)).toBe(12);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('safety and price', () => {
  it('refuses blocked tokens as honeypot', () => expect(refusal(() => checkSafety({ riskLevel: 'high', verdict: 'honeypot', flags: [], blocked: true }))).toBe('honeypot'));
  it('lets unblocked tokens through to the API guards', () => expect(refusal(() => checkSafety({ riskLevel: 'medium', verdict: null, flags: [], blocked: false }))).toBeNull());
  it('accepts agreeing ETH prices', () => expect(checkEthUsd(1827, 1830)).toBe(1827));
  it('refuses disagreeing ETH prices', () => expect(refusal(() => checkEthUsd(3600, 1830))).toBe('refused_price_disagreement'));
  it('refuses a missing source', () => expect(refusal(() => checkEthUsd(null, 1830))).toBe('refused_price_unavailable'));
});

describe('config', () => {
  it('defaults: $10 per trade, $50 a day, live', () => {
    const c = loadConfig({});
    expect([c.maxTradeUsd, c.dailyUsd, c.dryRun, c.maxSizeImpactBps, c.maxTotalImpactBps, c.gasReserveWei]).toEqual([10, 50, false, 300, 500, parseEther('0.001')]);
  });
  it('reads caps and dry run from env', () => {
    const c = loadConfig({ RUSHR_MAX_TRADE_USD: '5', RUSHR_DAILY_USD: '20', RUSHR_DRY_RUN: '1' });
    expect([c.maxTradeUsd, c.dailyUsd, c.dryRun]).toEqual([5, 20, true]);
  });
  it.each([
    [{ RUSHR_MAX_TRADE_USD: '-1' }],
    [{ RUSHR_DAILY_USD: 'lots' }],
    [{ RUSHR_MAX_SIZE_IMPACT_BPS: '900' }],
    [{ RUSHR_MAX_TOTAL_IMPACT_BPS: '501' }],
    [{ RUSHR_GAS_RESERVE_ETH: '0.0001' }],
    [{ RUSHR_PRIVATE_KEY: '0x1', RUSHR_WALLET_FILE: '/x' }],
  ])('rejects %j', (env) => expect(() => loadConfig(env)).toThrow());
});

describe('callout disclosure', () => {
  it('says an agent posted it and that it holds the token', () => expect(withDisclosure('Strong volume.', 'BULL', true)).toBe('Strong volume.\n\nDisclosure: posted by an AI agent that holds $BULL. Not advice.'));
  it('says so when it holds none', () => expect(withDisclosure('Fading this.', 'BULL', false)).toMatch(/AI agent; no \$BULL position/));
  it("doesn't double a disclosure the author already wrote", () => expect(withDisclosure('Disclosure: I hold it.', 'BULL', true)).toBe('Disclosure: I hold it.'));
});
