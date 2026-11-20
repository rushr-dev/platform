import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseEther, type Address, type Hex } from 'viem';
import { ponsCurveAbi } from '@rushr/trade/abis';
import { GuardError, vetBuild, vetPairCurveBuild, type Built, type PairStep } from '../src/guards.ts';
import { CURVE, PAIR, pairBuilt } from './fixtures.ts';
import { connect, fakeApi, fakeChain, TOKEN, type Route } from './harness.ts';

const TRADER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const UR = '0x204faca1764b154221e35c0d20abb3c525710498';
const AMOUNT = parseEther('0.003');
const MIN_PAIR = 1_000_000n;

const problems = (f: () => unknown): string[] | null => {
  try {
    f();
  } catch (e) {
    if (!(e instanceof GuardError)) throw e;
    expect(e.code).toBe('refused_unsafe_build');
    return e.details?.problems as string[];
  }
  return null;
};
const vet = (b: Built, side: 'buy' | 'sell' = 'buy', curveOnChain: Address | null = CURVE) => () => vetPairCurveBuild(b, side, TOKEN as Address, AMOUNT, { trader: TRADER, curveOnChain });
const buy = () => pairBuilt('buy', AMOUNT, TRADER, TOKEN as Address, MIN_PAIR);
const sell = () => pairBuilt('sell', AMOUNT, TRADER, TOKEN as Address, MIN_PAIR);
/** The build with step `n` (1-based) changed. */
const withStep = (b: Built, n: number, f: (s: PairStep) => PairStep): Built => ({ ...b, steps: b.steps!.map((s) => (s.step === n ? f(s) : s)) });
const stepTx = (b: Built, n: number, over: Partial<PairStep['tx']>) => withStep(b, n, (s) => ({ ...s, tx: { ...s.tx, ...over } }));
const approveData = (spender: Address) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 1n] });
const curveData = (fn: 'buy' | 'sell', amt: bigint, to: Address = TRADER) => encodeFunctionData({ abi: ponsCurveAbi, functionName: fn, args: [amt, 1n, to] });

describe('pair-curve build checks', () => {
  it('accepts a clean pair buy (approve, swap, curve)', () => expect(problems(vet(buy()))).toBeNull());
  it('accepts a clean pair sell (three approvals, curve, swap)', () => expect(problems(vet(sell(), 'sell'))).toBeNull());
  it('vetBuild routes pair builds to the pair checks, not the single-tx curve checks', () => expect(problems(() => vetBuild(buy(), 'buy', TOKEN as Address, AMOUNT, { trader: TRADER, curveOnChain: CURVE }))).toBeNull());
  it('vetBuild refuses a build with no tx and no pair route', () => {
    const b = { ...buy(), route: null };
    expect(problems(() => vetBuild(b, 'buy', TOKEN as Address, AMOUNT, { trader: TRADER, curveOnChain: CURVE }))).toEqual(['tx is null']);
  });

  it.each<[string, () => Built, RegExp]>([
    ['swap step to another contract', () => stepTx(buy(), 2, { to: OTHER }), /not the Universal Router/],
    ['swap step sends more ETH than amountIn', () => stepTx(buy(), 2, { value: (AMOUNT + 1n).toString() }), /swap step: value/],
    ['swap step sends less ETH than amountIn', () => stepTx(buy(), 2, { value: '0' }), /swap step: value/],
    ['swap step is not execute(commands, inputs, deadline)', () => stepTx(buy(), 2, { data: '0xdeadbeef' }), /not Universal Router execute/],
    ['swap step deadline differs from the build', () => ({ ...buy(), deadline: '1' }), /deadline/],
    ['curve step to another contract', () => stepTx(buy(), 3, { to: OTHER }), /curve step: sends to/],
    ['curve step with ETH', () => stepTx(buy(), 3, { value: '1' }), /curve step: value/],
    ['curve step pays someone else', () => stepTx(buy(), 3, { data: curveData('buy', MIN_PAIR, OTHER) }), /recipient/],
    ['curve step spends more than the pair minimum', () => stepTx(buy(), 3, { data: curveData('buy', MIN_PAIR + 1n) }), /route.minPairAmount/],
    ['curve step sells on a buy', () => stepTx(buy(), 3, { data: curveData('sell', MIN_PAIR) }), /expected buy/],
    ['pair approval to another spender', () => stepTx(buy(), 1, { data: approveData(OTHER) }), /unexpected approval/],
    ['approval that sends ETH', () => stepTx(buy(), 1, { value: '1' }), /approval with value/],
    ['approval that is a transfer', () => stepTx(buy(), 1, { data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [OTHER, 1n] }) }), /not approve/],
    ['a buy approving the pair token for Permit2', () => stepTx(buy(), 1, { data: approveData('0x000000000022d473030f116ddee9f6b43ac78ba3') }), /unexpected approval/],
    ['a buy approving the traded token', () => stepTx(buy(), 1, { to: TOKEN as Address }), /unexpected approval/],
    ['trading steps in the sell order on a buy', () => {
      const b = buy();
      const [a, s, c] = b.steps!;
      return { ...b, steps: [a!, { ...c!, step: 2 }, { ...s!, step: 3 }], route: { ...b.route!, swapStep: 3, curveStep: 2 } };
    }, /expected \[swap, curve\]/],
    ['an approval after the trades start', () => {
      const b = buy();
      const [a, s, c] = b.steps!;
      return { ...b, steps: [{ ...s!, step: 1 }, { ...a!, step: 2 }, c!], route: { ...b.route!, swapStep: 1 } };
    }, /before the two trading steps/],
    ['a third trade', () => ({ ...buy(), steps: [...buy().steps!, { ...buy().steps![1]!, step: 4 }] }), /trading steps are/],
    ['steps out of number', () => withStep(buy(), 2, (s) => ({ ...s, step: 7 })), /numbered 7/],
    ['route.swapStep pointing elsewhere', () => ({ ...buy(), route: { ...buy().route!, swapStep: 3 } }), /route.swapStep/],
    ['route.curve not the quoted curve', () => ({ ...buy(), route: { ...buy().route!, curve: OTHER } }), /not the quoted curve/],
    ['a fee above 25 bps', () => ({ ...buy(), quote: { ...buy().quote, fee: { feeBps: 30, feeAmount: '1' } } }), /fee 30 bps/],
    ['a failed simulation', () => ({ ...buy(), simulation: { ok: false, error: 'reverted' } }), /simulation failed/],
    ['wrong chain', () => stepTx(buy(), 2, { chainId: 1 }), /chainId 1/],
  ])('refuses a buy with %s', (_, make, why) => expect(problems(vet(make()))).toEqual(expect.arrayContaining([expect.stringMatching(why)])));

  it.each<[string, () => Built, RegExp]>([
    ['a swap step that sends ETH', () => stepTx(sell(), 5, { value: '1' }), /swap step: value/],
    ['a curve step selling a different amount', () => stepTx(sell(), 4, { data: curveData('sell', AMOUNT + 1n) }), /amountIn/],
    ['a Permit2 approval for another spender', () => {
      const d = sell().steps![2]!.tx.data;
      return stepTx(sell(), 3, { data: d.replace(UR.slice(2), OTHER.slice(2)) as Hex });
    }, /unexpected Permit2 call/],
    ['a token approval to Permit2 (only the pair token goes to Permit2)', () => stepTx(sell(), 1, { data: approveData('0x000000000022d473030f116ddee9f6b43ac78ba3') }), /unexpected approval/],
  ])('refuses a sell with %s', (_, make, why) => expect(problems(vet(make(), 'sell'))).toEqual(expect.arrayContaining([expect.stringMatching(why)])));

  it.each<[string, () => Built]>([
    ['a tx next to its steps', () => ({ ...buy(), tx: { ...buy().steps![1]!.tx, chainId: 4663 } })],
    ['a fee follow-up', () => ({ ...buy(), followUp: { kind: 'rushr_fee', amount: '1', tx: buy().steps![1]!.tx, after: 'tx', report: '' } })],
    ['no steps', () => ({ ...buy(), steps: [] })],
  ])('refuses a build with %s', (_, make) => expect(problems(vet(make()))).not.toBeNull());

  it("refuses when the token's PONS curve on-chain is another one, or unknown", () => {
    expect(problems(vet(buy(), 'buy', OTHER))).toEqual([expect.stringMatching(/not the token's PONS curve/)]);
    expect(problems(vet(buy(), 'buy', null))).toEqual([expect.stringMatching(/couldn't confirm/)]);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end through the MCP server.

const ur = UR.toLowerCase();
const pair = PAIR.toLowerCase();
const curve = CURVE.toLowerCase();
const token = TOKEN.toLowerCase();

const pairQuote: Route = (b) => {
  const p = pairBuilt(b.side, BigInt(b.amountIn), b.from as Address, TOKEN as Address, MIN_PAIR);
  return { quote: p.quote, route: p.route, warnings: [], wouldBuild: true, followUpFee: null, deadlineSeconds: 300 };
};
const pairApi = (over: Record<string, Route> = {}) =>
  fakeApi({
    'POST /v1/trade/quote': pairQuote,
    'POST /v1/trade/build': (b) => pairBuilt(b.side, BigInt(b.amountIn), b.from as Address, TOKEN as Address, MIN_PAIR),
    'POST /v1/trades': () => new Response('{"id":"t_1","status":"submitted"}', { status: 202 }),
    ...over,
  });
const records = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === 'POST' && c.path === '/v1/trades').map((c) => c.body);
/** balanceOf(pair): `before`, plus `arrived` once the first trade (`after`) has been sent. */
const pairBalances = (o: { before?: bigint; arrived: bigint; after: string }) => (t: string, log: readonly string[]) => (t === pair ? (o.before ?? 0n) + (log.includes(`send:${o.after}`) ? o.arrived : 0n) : 10n ** 21n);
const sends = (log: readonly string[]) => log.filter((l) => l.startsWith('send:'));

describe('pair-curve trades through the MCP server', () => {
  it('buy: approval, swap, curve in order; the curve step spends what arrived; recorded with both hashes', async () => {
    const api = pairApi();
    const chain = fakeChain({ curve: CURVE, tokenBalance: pairBalances({ arrived: MIN_PAIR + 5n, after: ur }) });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(sends(chain.log)).toEqual([`send:${pair}`, `send:${ur}`, `send:${curve}`]);
    // Each step is confirmed before the next is sent.
    expect(chain.log.map((l) => l.split(':')[0])).toEqual(['send', 'confirm', 'send', 'confirm', 'send', 'confirm']);
    expect(chain.sent[1]!.value).toBe(AMOUNT);
    const d = decodeFunctionData({ abi: ponsCurveAbi, data: chain.sent[2]!.data });
    expect(d.args).toEqual([MIN_PAIR + 5n, 1n, expect.stringMatching(/^0x/)]);
    expect(r.json).toMatchObject({ swapHash: r.json.steps[1].hash, curveHash: r.json.steps[2].hash, recorded: { ok: true }, pairRoute: { pairSymbol: 'ANT' } });
    expect(records(api)).toEqual([{ txHash: r.json.swapHash, curveTxHash: r.json.curveHash, pairRoute: true, chainId: 4663 }]);
    expect(r.json.fee).toBeUndefined();
  });

  it('buy: pair token already in the wallet is not spent, only what the swap brought', async () => {
    const chain = fakeChain({ curve: CURVE, tokenBalance: pairBalances({ before: 7_000_000n, arrived: MIN_PAIR + 3n, after: ur }) });
    const { call } = await connect({}, pairApi(), chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(decodeFunctionData({ abi: ponsCurveAbi, data: chain.sent[2]!.data }).args[0]).toBe(MIN_PAIR + 3n);
  });

  it('buy: a balance under the minimum (scaled stock-token logs) holds the pair token instead of sending a curve call that reverts', async () => {
    const api = pairApi();
    const chain = fakeChain({ curve: CURVE, tokenBalance: pairBalances({ arrived: MIN_PAIR - 1n, after: ur }) });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.isError).toBe(false);
    expect(r.json.status).toBe('pair_token_held');
    expect(sends(chain.log)).toEqual([`send:${pair}`, `send:${ur}`]);
    expect(r.json.pairTokenHeld).toEqual({ token: PAIR, symbol: 'ANT', amount: (MIN_PAIR - 1n).toString() });
    expect(r.json.message).toMatch(/now holds 0\.000000000000999999 ANT/);
    expect(r.json.action).toMatch(/curve .* yourself|sell the ANT/);
    expect(records(api)).toEqual([{ txHash: r.json.swapHash, pairRoute: true, chainId: 4663 }]);
  });

  it('buy: a failed curve step reports that the wallet holds the pair token', async () => {
    const api = pairApi();
    const chain = fakeChain({ curve: CURVE, failSends: 1, failTo: CURVE, tokenBalance: pairBalances({ arrived: MIN_PAIR, after: ur }) });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json).toMatchObject({ status: 'pair_token_held', curveHash: null, error: 'fetch failed', pairTokenHeld: { amount: MIN_PAIR.toString() } });
    expect(r.json.message).toMatch(/the curve step failed/);
    expect(records(api)).toEqual([{ txHash: r.json.swapHash, pairRoute: true, chainId: 4663 }]);
  });

  it('buy: a failed swap step is a plain error; nothing more is sent and nothing recorded', async () => {
    const api = pairApi();
    const chain = fakeChain({ curve: CURVE, failSends: 1, failTo: UR, tokenBalance: pairBalances({ arrived: MIN_PAIR, after: ur }) });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.isError).toBe(true);
    expect(sends(chain.log)).toEqual([`send:${pair}`, `send:${ur}`]);
    expect(records(api)).toEqual([]);
  });

  it('sell: three approvals, curve, swap as built; recorded with both hashes', async () => {
    const api = pairApi();
    const chain = fakeChain({ curve: CURVE, tokenBalance: (t, log) => (t === pair ? (log.includes(`send:${curve}`) ? MIN_PAIR + 9n : 0n) : 10n ** 21n) });
    const { call } = await connect({}, api, chain);
    const r = await call('sell', { token: TOKEN, amount: AMOUNT.toString() });
    expect(r.json.status).toBe('confirmed');
    expect(sends(chain.log)).toEqual([`send:${token}`, `send:${pair}`, 'send:0x000000000022d473030f116ddee9f6b43ac78ba3', `send:${curve}`, `send:${ur}`]);
    const built = pairBuilt('sell', AMOUNT, TRADER, TOKEN as Address, MIN_PAIR);
    expect(chain.sent[4]).toMatchObject({ value: 0n, data: built.steps![4]!.tx.data });
    expect(records(api)).toEqual([{ txHash: r.json.swapHash, curveTxHash: r.json.curveHash, pairRoute: true, chainId: 4663 }]);
  });

  it('sell: a failed swap step leaves the pair token in the wallet and says how to sell it', async () => {
    const api = pairApi();
    const chain = fakeChain({ curve: CURVE, failSends: 1, failTo: UR, tokenBalance: (t, log) => (t === pair ? (log.includes(`send:${curve}`) ? MIN_PAIR : 0n) : 10n ** 21n) });
    const { call } = await connect({}, api, chain);
    const r = await call('sell', { token: TOKEN, amount: AMOUNT.toString() });
    expect(r.json).toMatchObject({ status: 'pair_token_held', swapHash: null, pairTokenHeld: { token: PAIR, amount: MIN_PAIR.toString() }, recorded: { ok: false } });
    expect(r.json.action).toMatch(new RegExp(`sell tool \\(token ${PAIR}\\)`));
    expect(records(api)).toEqual([]);
  });

  it('refuses before sending anything when a step is off (swap step to another contract)', async () => {
    const chain = fakeChain({ curve: CURVE });
    const api = pairApi({ 'POST /v1/trade/build': (b) => stepTx(pairBuilt(b.side, BigInt(b.amountIn), b.from as Address, TOKEN as Address, MIN_PAIR), 2, { to: OTHER }) });
    const { call } = await connect({}, api, chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe('refused_unsafe_build');
    expect(chain.sent).toEqual([]);
  });

  it('dry run: shows the steps, sends nothing', async () => {
    const chain = fakeChain({ curve: CURVE });
    const { call } = await connect({ RUSHR_DRY_RUN: '1' }, pairApi(), chain);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('dry_run');
    expect(r.json.pairRoute.steps.map((s: { kind: string }) => s.kind)).toEqual(['approve', 'swap', 'curve']);
    expect(r.json.note).toMatch(/keeps the ANT/);
    expect(chain.sent).toEqual([]);
  });
});
