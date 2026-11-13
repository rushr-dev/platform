import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, zeroAddress, type Address, type PublicClient } from 'viem';
import { resolveConfig, assertSignable, PLACEHOLDER_FEE_RECIPIENT, STANDARD_FEE_BPS } from '../src/config';
import { confirmTradeRecord, draftTradeRecord, effectiveFeeBps, referrerAccrual } from '../src/referral';
import { quotePool } from '../src/quote';
import { buildSwap } from '../src/build';
import { prepareSwap, toJsonSafe } from '../src/agent';
import { ponsBuyCapped } from '../src/math';
import { TRADE_ADDRESSES } from '../src/addresses';
import { rushrPonsRouterAbi } from '../src/abis';
import type { PonsPool, SwapRequest, V2Pool } from '../src/types';

const TREASURY: Address = '0x1111111111111111111111111111111111111111';
const TRADER: Address = '0x2222222222222222222222222222222222222222';
const REFERRER: Address = '0x5555555555555555555555555555555555555555';
const TOKEN: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const noRpc = {} as PublicClient;
// The standard rate (0.5%, 10% referee discount, 20% referrer share); the beta default is tested below.
const cfg = resolveConfig({ feeRecipient: TREASURY, feeBps: STANDARD_FEE_BPS });
const beta = resolveConfig({ feeRecipient: TREASURY }); // default during the beta: 0.25%

const v2Pool: V2Pool = { venue: 'uniswap-v2', id: '0x8018ee3ad3000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, reserveToken: 10n ** 24n, reserveQuote: 10n ** 20n, venueFeeBps: 30, venueFeeLabel: 'v2' };
const req = (side: SwapRequest['side'], amountIn: bigint, referred = false): SwapRequest => ({
  side,
  token: TOKEN,
  quoteAsset: 'ETH',
  amountIn,
  trader: TRADER,
  slippageBps: 100,
  referral: referred ? { referrer: REFERRER, code: 'rush' } : null,
  source: { kind: 'agent', id: 'agent-7' },
});

describe('beta rate (default config): 0.25%, 0.22% for referees', () => {
  it('rounds the 10% referral discount in the referee\'s favour: 25 - ceil(2.5) = 22 bps', () => {
    expect(beta.feeBps).toBe(25);
    expect(effectiveFeeBps(beta)).toBe(25);
    expect(effectiveFeeBps(beta, { referrer: REFERRER })).toBe(22);
  });

  for (const referred of [false, true]) {
    const bps = referred ? 22n : 25n;
    it(`buy${referred ? ' (referred)' : ''}: TRANSFER of ${bps} bps of msg.value to the treasury`, async () => {
      const q = await quotePool(noRpc, v2Pool, req('buy', 10n ** 18n, referred), beta);
      expect(q.fee).toMatchObject({ feeBps: Number(bps), baseFeeBps: 25, feeAmount: bps * 10n ** 14n, referralDiscountAmount: referred ? 3n * 10n ** 14n : 0n });
      const built = buildSwap(q, beta);
      expect(built.tx.value).toBe(10n ** 18n);
      expect(built.commands[0]!.label).toBe('TRANSFER');
      const [asset, to, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], built.commands[0]!.input);
      expect([asset, to, amount]).toEqual([zeroAddress, TREASURY, bps * 10n ** 14n]);
      expect(q.swapAmountIn).toBe(10n ** 18n - bps * 10n ** 14n);
    });
    it(`sell${referred ? ' (referred)' : ''}: PAY_PORTION of ${bps} bips of the ETH out to the treasury`, async () => {
      const q = await quotePool(noRpc, v2Pool, req('sell', 10n ** 21n, referred), beta);
      const pay = buildSwap(q, beta).commands.find((c) => c.label === 'PAY_PORTION')!;
      const [asset, to, bips] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], pay.input);
      expect([asset, to, bips]).toEqual([zeroAddress, TREASURY, bps]);
      expect(q.fee.feeAmount).toBe((q.grossOut * bps) / 10_000n);
      expect(q.amountOut).toBe(q.grossOut - q.fee.feeAmount);
    });
  }
});

describe('referral fee model (off-chain accounting)', () => {
  it('0.5% base, 0.45% for referees, referrer accrues 20% of the fee collected', () => {
    expect(effectiveFeeBps(cfg)).toBe(50);
    expect(effectiveFeeBps(cfg, { referrer: REFERRER })).toBe(45);
    expect(referrerAccrual(45_000n, cfg, { referrer: REFERRER })).toBe(9_000n);
    expect(referrerAccrual(45_000n, cfg, null)).toBe(0n);
  });

  it('a referred buy pays 0.45% and records the discount and accrual', async () => {
    const q = await quotePool(noRpc, v2Pool, req('buy', 10n ** 18n, true), cfg);
    expect(q.fee).toMatchObject({ feeBps: 45, baseFeeBps: 50, feeAmount: 45n * 10n ** 14n, referralDiscountAmount: 5n * 10n ** 14n, referrerAccrual: 9n * 10n ** 14n });
    const built = buildSwap(q, cfg);
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], built.commands[0]!.input)[2]).toBe(45n * 10n ** 14n);
  });

  it('a referred sell takes PAY_PORTION at 45 bps', async () => {
    const q = await quotePool(noRpc, v2Pool, req('sell', 10n ** 21n, true), cfg);
    const pay = buildSwap(q, cfg).commands.find((c) => c.label === 'PAY_PORTION')!;
    expect(decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], pay.input)[2]).toBe(45n);
    expect(q.fee.feeAmount).toBe((q.grossOut * 45n) / 10_000n);
  });

  it('trade records carry everything the ledger needs, and confirm with the fee actually paid', async () => {
    const q = await quotePool(noRpc, v2Pool, req('buy', 10n ** 18n, true), cfg);
    const r = draftTradeRecord(q, cfg, cfg.universalRouter, 1_000);
    expect(r).toMatchObject({ status: 'quoted', trader: TRADER, referrer: REFERRER, referralCode: 'rush', feeBps: 45, baseFeeBps: 50, referrerShareBps: 2_000, source: { kind: 'agent', id: 'agent-7' }, venue: 'uniswap-v2' });
    const c = confirmTradeRecord(r, { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 5n, timestamp: 1_001, amountOut: 1n, feePaid: 40_000n }, cfg);
    expect(c).toMatchObject({ status: 'confirmed', feeAmount: 40_000n, referrerAccrual: 8_000n });
  });
});

describe('PONS graduation cap (curve 0xdb0f…8050, eth_simulateV1 2026-11-12)', () => {
  const curve = {
    quoteReserve: 2227385255280461543n,
    tokenReserve: 754247607600537239666020435n,
    feeBps: 100,
    creatorTaxBps: 125,
    realQuoteReserve: 547385255280461543n,
    graduationThreshold: 4_200_000_000_000_000_000n,
    sellableTokens: 468533321886251525380306150n,
  };

  it('caps the output at the sellable tokens and keeps only what reaches the threshold', () => {
    const b = ponsBuyCapped(10n * 10n ** 18n, curve);
    expect(b.capped).toBe(true);
    expect(b.out).toBe(468533321886251525380306150n);
    // On-chain the curve kept 3736690275927916673 wei (refunded 6.2633 ETH); our estimate is within 100 wei.
    expect(Number(3736690275927916673n - b.used)).toBeLessThan(100);
    expect(Number(3736690275927916673n - b.used)).toBeGreaterThanOrEqual(0);
  });

  it('is the plain curve formula below the threshold', () => {
    expect(ponsBuyCapped(10n ** 15n, curve).capped).toBe(false);
  });

  it('quotes a graduating buy with the fee only on what is spent, and a refund', async () => {
    const pool: PonsPool = { venue: 'pons-curve', id: '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050', curve: '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050', token: TOKEN, quote: zeroAddress, snipeTaxBps: 0, graduated: false, venueFeeBps: 225, venueFeeLabel: 'PONS', ...curve };
    const q = await quotePool(noRpc, pool, req('buy', 10n * 10n ** 18n), cfg);
    expect(q.expectedRefund).toBeGreaterThan(6n * 10n ** 18n);
    expect(q.swapAmountIn + q.fee.feeAmount + q.expectedRefund).toBe(q.amountIn);
    expect(q.fee.feeAmount).toBe((q.swapAmountIn * 50n) / 9_950n);
    expect(q.warnings.join(' ')).toMatch(/graduates/);
    const withRouter = resolveConfig({ feeRecipient: TREASURY, ponsRouter: '0x3333333333333333333333333333333333333333' });
    const d = decodeFunctionData({ abi: rushrPonsRouterAbi, data: buildSwap(q, withRouter).tx.data });
    expect(d.args.at(-1)).toBe(false); // not referred
  });
});

describe('prepareSwap (server / agent entry point)', () => {
  it('returns an unsigned tx, approvals and a ledger record without touching RPC when pools are given', async () => {
    const p = await prepareSwap(noRpc, req('sell', 10n ** 21n, true), { config: { feeRecipient: TREASURY, feeBps: STANDARD_FEE_BPS }, discover: { pools: [v2Pool] }, now: 1_000 });
    expect(p.tx).toMatchObject({ chainId: 4663, to: TRADE_ADDRESSES.universalRouter, value: 0n });
    expect(p.commands).toEqual(['V2_SWAP_EXACT_IN', 'UNWRAP_WETH', 'PAY_PORTION', 'SWEEP']);
    expect(p.approvals.map((a) => a.kind)).toEqual(['erc20', 'permit2']);
    expect(p.record.feeBps).toBe(45);
    expect(p.deadline).toBe(1_300n);
    const json = JSON.parse(JSON.stringify(toJsonSafe(p)));
    expect(json.tx.value).toBe('0');
    expect(json.record.referrer).toBe(REFERRER);
  });

  it('refuses forSigning with a placeholder treasury, and one-click until RushrRouter is deployed AND audited', async () => {
    const pools = { pools: [v2Pool] };
    await expect(prepareSwap(noRpc, req('buy', 10n ** 18n), { config: { feeRecipient: PLACEHOLDER_FEE_RECIPIENT }, discover: pools, forSigning: true })).rejects.toMatchObject({ code: 'FEE_RECIPIENT_PLACEHOLDER' });
    expect(() => assertSignable(cfg)).not.toThrow();
    // The default config (the real treasury) is fine for user-confirmed signing...
    await expect(prepareSwap(noRpc, req('buy', 10n ** 18n), { discover: pools, forSigning: true })).resolves.toBeTruthy();
    // ...but never for one-click: no RushrRouter yet, then not audited.
    await expect(prepareSwap(noRpc, req('buy', 10n ** 18n), { discover: pools, oneClick: true })).rejects.toThrow(/RushrRouter deployed/);
    await expect(prepareSwap(noRpc, req('buy', 10n ** 18n), { config: { rushrRouter: TREASURY }, discover: pools, oneClick: true })).rejects.toThrow(/audited/);
  });
});
