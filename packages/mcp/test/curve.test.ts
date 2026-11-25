import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther, type Address } from 'viem';
import { ponsCurveAbi } from '@rushr/trade/abis';
import { checkFeeUnpaid, GuardError, vetBuild, vetCurveBuild, type Built } from '../src/guards.ts';
import { built, CURVE, curveBuilt, TREASURY } from './fixtures.ts';
import { apiError, connect, fakeApi, fakeChain, TOKEN, type Route } from './harness.ts';

const TRADER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const AMOUNT = parseEther('0.003');

const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof GuardError ? e.code : `not a GuardError: ${e}`;
  }
  return null;
};
const problems = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as GuardError).details?.problems as string[];
  }
  return [];
};
const vet = (b: Built, side: 'buy' | 'sell' = 'buy', curveOnChain: Address | null = CURVE) => () => vetCurveBuild(b, side, TOKEN as Address, AMOUNT, { trader: TRADER, curveOnChain });

describe('curve build checks', () => {
  const buy = () => curveBuilt('buy', AMOUNT, TRADER, TOKEN as Address);
  const sell = () => curveBuilt('sell', AMOUNT, TRADER, TOKEN as Address);

  it('accepts a clean curve buy', () => expect(refusal(vet(buy()))).toBeNull());
  it('accepts a clean curve sell with token.approve(curve)', () => expect(refusal(vet(sell(), 'sell'))).toBeNull());
  it('vetBuild routes pons-curve builds to the curve checks', () => expect(refusal(() => vetBuild(buy(), 'buy', TOKEN as Address, AMOUNT, { trader: TRADER, curveOnChain: CURVE }))).toBeNull());

  it.each<[string, () => Built, Address | null]>([
    ['tx.to is not the quoted curve', () => ({ ...buy(), tx: { ...buy().tx, to: OTHER } }), CURVE],
    ['the quoted curve is not the token’s PONS curve on-chain', buy, OTHER],
    ['the curve could not be read on-chain', buy, null],
    ['calldata sends the tokens to someone else', () => ({ ...buy(), tx: { ...buy().tx, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: 'buy', args: [AMOUNT, 1n, OTHER] }) } }), CURVE],
    ['calldata amount differs', () => ({ ...buy(), tx: { ...buy().tx, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: 'buy', args: [AMOUNT + 1n, 1n, TRADER] }) } }), CURVE],
    ['calldata calls sell on a buy', () => ({ ...buy(), tx: { ...buy().tx, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: 'sell', args: [AMOUNT, 1n, TRADER] }) } }), CURVE],
    ['value is more than amountIn', () => ({ ...buy(), tx: { ...buy().tx, value: (AMOUNT + 1n).toString() } }), CURVE],
    ['no fee follow-up', () => ({ ...buy(), followUp: null }), CURVE],
    ['fee sent somewhere other than the treasury Safe', () => ({ ...buy(), followUp: { ...buy().followUp!, tx: { ...buy().followUp!.tx, to: OTHER } } }), CURVE],
    ['fee transfer carries calldata', () => ({ ...buy(), followUp: { ...buy().followUp!, tx: { ...buy().followUp!.tx, data: '0xdeadbeef' } } }), CURVE],
    ['fee value differs from the follow-up amount', () => ({ ...buy(), followUp: { ...buy().followUp!, tx: { ...buy().followUp!.tx, value: '1' } } }), CURVE],
    ['follow-up amount differs from the quoted fee', () => ({ ...buy(), quote: { ...buy().quote, fee: { feeBps: 25, feeAmount: '1' } } }), CURVE],
    ['fee above 1% of the trade', () => {
      const b = buy();
      const fee = ((AMOUNT * 130n) / 10_000n).toString();
      return { ...b, quote: { ...b.quote, fee: { feeBps: 25, feeAmount: fee } }, followUp: { ...b.followUp!, amount: fee, tx: { ...b.followUp!.tx, value: fee } } };
    }, CURVE],
    ['a buy asking for approvals', () => ({ ...buy(), approvals: sell().approvals }), CURVE],
    ['a failed simulation', () => ({ ...buy(), simulation: { ok: false, error: 'reverted' } }), CURVE],
  ])('refuses: %s', (_, make, onChain) => expect(refusal(vet(make(), 'buy', onChain))).toBe('refused_unsafe_build'));

  it('refuses a sell approval to anyone but the curve', () => {
    const s = sell();
    const bad = { ...s, approvals: [{ ...s.approvals[0]!, tx: { ...s.approvals[0]!.tx, data: s.approvals[0]!.tx.data.replace(CURVE.slice(2), OTHER.slice(2)) as `0x${string}` } }] };
    expect(problems(vet(bad, 'sell'))).toEqual([expect.stringMatching(/unexpected approval/)]);
  });
  it('refuses a sell fee above 1% of the gross ETH out', () => {
    const s = sell();
    const fee = ((BigInt(s.quote.amountOut) * 130n) / 10_000n).toString();
    const bad = { ...s, quote: { ...s.quote, fee: { feeBps: 25, feeAmount: fee } }, followUp: { ...s.followUp!, amount: fee, tx: { ...s.followUp!.tx, value: fee } } };
    expect(refusal(vet(bad, 'sell'))).toBe('refused_unsafe_build');
  });
  it('refuses a Uniswap build that carries a follow-up', () => {
    const b = { ...built({}, AMOUNT), followUp: buy().followUp };
    expect(refusal(() => vetBuild(b, 'buy', TOKEN as Address, AMOUNT))).toBe('refused_unsafe_build');
  });
});

describe('fee_unpaid: when the server pays on its own', () => {
  const feeTx = (value: bigint, to: Address = TREASURY) => ({ chainId: 4663, to, data: '0x' as const, value: value.toString(), gas: '60000' });
  const ok = { feeUsd: 1, dailyUsd: 50, spent24hUsd: 0, freeWei: parseEther('0.01') };
  it('pays an exact transfer to the treasury', () => expect(checkFeeUnpaid({ owed: '1000', feeTx: feeTx(1000n) }, ok)).toBe(1000n));
  it('refuses above 0.005 ETH', () => expect(refusal(() => checkFeeUnpaid({ owed: parseEther('0.006').toString(), feeTx: feeTx(parseEther('0.006')) }, ok))).toBe('refused_fee_too_large'));
  it('refuses a transfer to anyone but the treasury', () => expect(refusal(() => checkFeeUnpaid({ owed: '1000', feeTx: feeTx(1000n, OTHER) }, ok))).toBe('refused_fee_tx'));
  it('refuses a transfer of a different amount', () => expect(refusal(() => checkFeeUnpaid({ owed: '1000', feeTx: feeTx(2000n) }, ok))).toBe('refused_fee_tx'));
  it('refuses past the daily cap', () => expect(refusal(() => checkFeeUnpaid({ owed: '1000', feeTx: feeTx(1000n) }, { ...ok, spent24hUsd: 49.5 }))).toBe('refused_daily_cap'));
  it('refuses dipping into the gas reserve', () => expect(refusal(() => checkFeeUnpaid({ owed: '1000', feeTx: feeTx(1000n) }, { ...ok, freeWei: 10n }))).toBe('refused_gas_reserve'));
});

// ---------------------------------------------------------------------------------------------
// End to end through the MCP server, against mocked curve responses (the settled API shape).

const curveQuote: Route = (b) => {
  const c = curveBuilt(b.side, BigInt(b.amountIn), b.from as Address, TOKEN as Address);
  return { quote: c.quote, warnings: [], wouldBuild: true, followUpFee: c.followUp!.amount, deadlineSeconds: null };
};
const curveBuild: Route = (b) => curveBuilt(b.side, BigInt(b.amountIn), b.from as Address, TOKEN as Address);
const curveApi = (over: Record<string, Route> = {}) => fakeApi({ 'POST /v1/trade/quote': curveQuote, 'POST /v1/trade/build': curveBuild, ...over });
const treasury = TREASURY.toLowerCase();
const feeReports = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === 'POST' && c.path === '/v1/agents/me/fees');

describe('curve trades through the MCP server', () => {
  it('buy: trade, wait for its receipt, then the fee transfer, then the report', async () => {
    const api = curveApi();
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(chain.log).toEqual([`send:${CURVE}`, `confirm:${r.json.hash}`, `send:${treasury}`, `confirm:${r.json.fee.hash}`]);
    expect(r.json.explorer).toBe(`https://robinhoodchain.blockscout.com/tx/${r.json.hash}`);
    expect(r.json.fee).toMatchObject({ status: 'paid', explorer: `https://robinhoodchain.blockscout.com/tx/${r.json.fee.hash}`, attempts: 1 });
    expect(chain.sent[1]).toMatchObject({ value: BigInt(r.json.curveFee.amountWei), data: '0x', gas: 60_000n, nonce: 7 });
    expect(feeReports(api).map((c) => c.body.txHash)).toEqual([r.json.fee.hash]);
  });

  it('sell: approval, trade, fee, report, in that order', async () => {
    const api = curveApi();
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    const r = await call('sell', { token: TOKEN });
    expect(r.json.status).toBe('confirmed');
    expect(chain.log.filter((l) => l.startsWith('send:'))).toEqual([`send:${TOKEN}`, `send:${CURVE}`, `send:${treasury}`]);
    expect(r.json.approvals).toHaveLength(1);
    expect(feeReports(api)).toHaveLength(1);
  });

  it('retries a failed fee send with the same nonce, so it can never pay twice', async () => {
    const chain = fakeChain({ curve: CURVE, failSends: 2, failTo: TREASURY });
    const { call } = await connect({}, curveApi(), chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(r.json.fee).toMatchObject({ status: 'paid', attempts: 3 });
    expect(chain.log.filter((l) => l === `send:${treasury}`)).toHaveLength(3);
    expect(chain.sent.filter((t) => t.to.toLowerCase() === treasury)).toEqual([expect.objectContaining({ nonce: 7 })]);
  });

  it('never leaves a fee unpaid silently: the trade result says so and what to do', async () => {
    const api = curveApi();
    const chain = fakeChain({ curve: CURVE, failSends: 99, failTo: TREASURY });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed_fee_unpaid');
    expect(r.json.hash).toMatch(/^0x/);
    expect(r.json.fee).toMatchObject({ status: 'unpaid', attempts: 3, error: 'fetch failed' });
    expect(r.json.fee.action).toMatch(/still owed/);
    expect(feeReports(api)).toHaveLength(0);
  });

  it("stops retrying when the nonce is taken (an earlier attempt may have gone through)", async () => {
    const chain = fakeChain({ curve: CURVE, failSends: 99, failTo: TREASURY, failMessage: 'nonce too low' });
    const { call } = await connect({}, curveApi(), chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.fee).toMatchObject({ status: 'unpaid', attempts: 1 });
    expect(r.json.fee.action).toMatch(/Check my_status/);
  });

  it('retries the report while the API has not seen the transfer yet', async () => {
    const api = curveApi({ 'POST /v1/agents/me/fees': (_, n) => (n < 3 ? apiError(404, 'tx_not_found') : new Response('{}', { status: 201 })) });
    const { call } = await connect({}, api, fakeChain({ curve: CURVE }));
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json).toMatchObject({ status: 'confirmed', fee: { status: 'paid' } });
    expect(feeReports(api)).toHaveLength(3);
  });

  it('a paid but unreported fee is reported later, never paid again', async () => {
    let reportUp = false;
    let buildN = 0;
    const api = curveApi({
      'POST /v1/agents/me/fees': () => (reportUp ? new Response('{}', { status: 201 }) : apiError(503, 'unavailable')),
      'POST /v1/trade/build': (b) => (++buildN === 2 ? apiError(402, 'fee_unpaid', { owed: '7500000000000', feeTx: { chainId: 4663, to: TREASURY, data: '0x', value: '7500000000000' } }) : curveBuild(b, buildN)),
    });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    const first = await call('buy', { token: TOKEN, usd: 6 });
    expect(first.json.status).toBe('confirmed_fee_unreported');
    reportUp = true;
    const second = await call('buy', { token: TOKEN, usd: 6 });
    expect(second.json.status).toBe('confirmed');
    // Fee transfers: one per trade, none for the 402 (the unreported one was reported instead).
    expect(chain.sent.filter((t) => t.to.toLowerCase() === treasury)).toHaveLength(2);
    expect(feeReports(api).map((c) => c.body.txHash)).toContain(first.json.fee.hash);
  });

  it('fee_unpaid: pays the overdue transfer, reports it, and retries the build once', async () => {
    const owed = '1000000000000000';
    const api = curveApi({ 'POST /v1/trade/build': (b, n) => (n === 1 ? apiError(402, 'fee_unpaid', { owed, overdue: owed, feeTx: { chainId: 4663, to: TREASURY, data: '0x', value: owed, gas: '60000' }, report: 'POST /v1/agents/me/fees' }) : curveBuild(b, n)) });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(r.json.overdueFeePaid).toMatchObject({ status: 'paid', amountWei: owed });
    expect(chain.log.filter((l) => l.startsWith('send:'))).toEqual([`send:${treasury}`, `send:${CURVE}`, `send:${treasury}`]);
    expect(chain.sent[0]!.value).toBe(BigInt(owed));
    expect(feeReports(api)).toHaveLength(2);
  });

  it('fee_unpaid above 0.005 ETH: refuses and tells the user, sends nothing', async () => {
    const owed = parseEther('0.006').toString();
    const api = curveApi({ 'POST /v1/trade/build': () => apiError(402, 'fee_unpaid', { owed, feeTx: { chainId: 4663, to: TREASURY, data: '0x', value: owed } }) });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.error.code).toBe('refused_fee_too_large');
    expect(r.json.error.message).toMatch(/Pay error.feeTx/);
    expect(chain.sent).toHaveLength(0);
  });

  it('fee_unpaid with a transfer to anyone but the treasury: refuses', async () => {
    const api = curveApi({ 'POST /v1/trade/build': () => apiError(402, 'fee_unpaid', { owed: '1000', feeTx: { chainId: 4663, to: OTHER, data: '0x', value: '1000' } }) });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    expect((await call('sell', { token: TOKEN })).json.error.code).toBe('refused_fee_tx');
    expect(chain.sent).toHaveLength(0);
  });

  it('fee_unpaid in dry run: explains, pays nothing', async () => {
    const api = curveApi({ 'POST /v1/trade/build': () => apiError(402, 'fee_unpaid', { owed: '1000', feeTx: { chainId: 4663, to: TREASURY, data: '0x', value: '1000' } }) });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({ RUSHR_DRY_RUN: '1' }, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.error.code).toBe('fee_unpaid');
    expect(chain.log).toHaveLength(0);
  });

  it('curve_graduated: quotes again and builds on Uniswap', async () => {
    const api = curveApi({ 'POST /v1/trade/build': (b, n) => (n === 1 ? apiError(409, 'curve_graduated') : built({}, BigInt(b.amountIn), b.side)) });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(r.json.fee).toBeUndefined();
    expect(api.calls.filter((c) => c.path === '/v1/trade/quote')).toHaveLength(4);
  });

  it("passes snipe_tax_active straight through", async () => {
    const api = curveApi({ 'POST /v1/trade/build': () => apiError(422, 'snipe_tax_active', { retryAfter: 10 }) });
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({}, api, chain);
    expect((await call('buy', { token: TOKEN, usd: 6 })).json.error).toMatchObject({ code: 'snipe_tax_active', source: 'rushr_api' });
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses when the on-chain PONS curve is a different contract', async () => {
    const chain = fakeChain({ curve: OTHER });
    const { call } = await connect({}, curveApi(), chain);
    expect((await call('buy', { token: TOKEN, usd: 6 })).json.error.code).toBe('refused_unsafe_build');
    expect(chain.sent).toHaveLength(0);
  });

  it('counts the fee toward the per-trade cap', async () => {
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({ RUSHR_MAX_TRADE_USD: '6.01' }, curveApi(), chain);
    expect((await call('buy', { token: TOKEN, usd: 6 })).json.error.code).toBe('refused_trade_cap');
    expect(chain.sent).toHaveLength(0);
  });

  it('dry run: builds and checks a curve buy, shows the fee, sends nothing', async () => {
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({ RUSHR_DRY_RUN: '1' }, curveApi(), chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json).toMatchObject({ status: 'dry_run', venue: 'pons-curve', curveFee: { amountWei: '7500000000000', to: TREASURY } });
    expect(chain.log).toHaveLength(0);
  });

  it('quote shows the curve fee follow-up', async () => {
    const { call } = await connect({}, curveApi(), fakeChain({ curve: CURVE }));
    const r = await call('quote', { token: TOKEN, side: 'buy', usd: 6 });
    expect(r.json).toMatchObject({ venue: 'pons-curve', curveFee: { amountWei: '7500000000000', amountEth: '0.0000075' }, wouldTrade: true });
  });

  it('my_status shows the curve fees owed', async () => {
    const api = curveApi({ 'GET /v1/agents/me/fees': () => ({ fees: { owed: '9000000000000', paid: '1500000000000', overdue: '0', outstanding: '7500000000000', graceMinutes: 10, feeTx: null, trades: [{}, {}] } }) });
    const { call } = await connect({}, api, fakeChain({ curve: CURVE }));
    const r = await call('my_status');
    expect(r.json.curveFees).toEqual({ owedEth: '0.000009', paidEth: '0.0000015', outstandingEth: '0.0000075', overdueEth: '0', graceMinutes: 10, buildsBlocked: false, trades: 2 });
  });
});
