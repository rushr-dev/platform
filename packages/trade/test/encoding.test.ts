import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeErrorResult, parseAbi, toFunctionSelector, zeroAddress } from 'viem';
import { cmd, encodeExecute, encodeV3Path, universalRouterAbi, v4 } from '../src/universal-router';
import { ponsBuyOut, ponsSellOut, sortCurrencies, v2AmountOut, v4PoolId } from '../src/math';
import { decodeRevert } from '../src/revert';
import { spotOutFromSqrtPrice } from '../src/quote';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';

describe('Universal Router encoding', () => {
  it('uses execute(bytes,bytes[],uint256)', () => {
    expect(toFunctionSelector(universalRouterAbi[0])).toBe('0x3593564c');
    const data = encodeExecute([cmd.transfer(zeroAddress, '0x000000000000000000000000000000000000fee1', 5n), cmd.sweep(zeroAddress, '0x0000000000000000000000000000000000000001', 0n)], 123n);
    const d = decodeFunctionData({ abi: universalRouterAbi, data });
    expect(d.args[0]).toBe('0x0504');
    expect(d.args[2]).toBe(123n);
  });

  it('encodes a single-hop v3 path as 43 bytes', () => {
    const path = encodeV3Path([WETH, PONS], [3000]);
    expect((path.length - 2) / 2).toBe(43);
    expect(path.slice(42, 48)).toBe('000bb8');
    expect(() => encodeV3Path([WETH], [])).toThrow();
  });

  it('v3/v2 swap inputs carry the v2.1 maxHopSlippage array (320 bytes for one hop, like live txs)', () => {
    const v3 = cmd.v3SwapExactIn('0x0000000000000000000000000000000000000001', 1n, 2n, encodeV3Path([WETH, PONS], [3000]), false);
    expect((v3.input.length - 2) / 2).toBe(320);
    const [recipient, amountIn, minOut, , payerIsUser, hops] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
      v3.input,
    );
    expect([recipient, amountIn, minOut, payerIsUser, hops]).toEqual(['0x0000000000000000000000000000000000000001', 1n, 2n, false, []]);
    const v2 = cmd.v2SwapExactIn('0x0000000000000000000000000000000000000002', 1n, 2n, [PONS, WETH], true);
    expect(v2.command).toBe(0x08);
  });

  it('v4 SWAP_EXACT_IN_SINGLE params are 384 bytes with the per-hop word before hookData (like live txs)', () => {
    const step = v4.swapExactInSingle({ poolKey: { currency0: zeroAddress, currency1: PONS, fee: 3000, tickSpacing: 60, hooks: zeroAddress }, zeroForOne: true, amountIn: 10n, amountOutMinimum: 9n });
    expect((step.params.length - 2) / 2).toBe(384);
    const swap = cmd.v4Swap([step, v4.settle(zeroAddress, 0n, false), v4.takeAll(PONS, 9n)]);
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], swap.input);
    expect(actions).toBe('0x060b0f');
    expect(params).toHaveLength(3);
  });
});

describe('pool math', () => {
  it('PONS curve buy matches on-chain eth_simulateV1 to the wei (curve 0xdb0f…8050, 2026-11-12)', () => {
    const R = 2368777388466264608n;
    const T = 709226628124716270229357752n;
    expect(ponsBuyOut(10n ** 15n, R, T, 100, 125)).toBe(292548833791246087236961n);
    expect(ponsBuyOut(10n ** 17n, R, T, 100, 125)).toBe(28107088217779674192304270n);
  });

  it('PONS sell output is below the fee-free constant-product output', () => {
    const R = 2368777388466264608n;
    const T = 709226628124716270229357752n;
    const tokens = 10n ** 24n;
    const gross = (R * tokens) / (T + tokens);
    expect(ponsSellOut(tokens, R, T, 100, 125)).toBe(gross - (gross * 100n) / 10_000n - (gross * 125n) / 10_000n);
  });

  it('v2 getAmountOut', () => {
    expect(v2AmountOut(1000n, 1_000_000n, 1_000_000n)).toBe(996n);
    expect(v2AmountOut(0n, 1n, 1n)).toBe(0n);
  });

  it('v4 pool id matches the live PONS/ETH 0.30% pool', () => {
    expect(v4PoolId({ currency0: zeroAddress, currency1: PONS, fee: 3000, tickSpacing: 60, hooks: zeroAddress })).toBe(
      '0x6073975413484a350101c0c5d592a91ceb6c3ee881ad359613a08359fd1495a0',
    );
    expect(sortCurrencies(PONS, zeroAddress)).toEqual([zeroAddress, PONS]);
  });

  it('spot output from sqrtPriceX96 (price 1:1)', () => {
    const Q96 = 1n << 96n;
    expect(spotOutFromSqrtPrice(1000n, Q96, true)).toBe(1000n);
    expect(spotOutFromSqrtPrice(1000n, 2n * Q96, true)).toBe(4000n);
    expect(spotOutFromSqrtPrice(4000n, 2n * Q96, false)).toBe(1000n);
  });
});

describe('revert decoding', () => {
  it('unwraps Universal Router ExecutionFailed', () => {
    const abi = parseAbi(['error ExecutionFailed(uint256 commandIndex, bytes message)', 'error V3TooLittleReceived()']);
    const inner = encodeErrorResult({ abi, errorName: 'V3TooLittleReceived' });
    const outer = encodeErrorResult({ abi, errorName: 'ExecutionFailed', args: [2n, inner] });
    expect(decodeRevert(outer)).toBe('command 2 failed: V3TooLittleReceived()');
    expect(decodeRevert('0x')).toMatch(/no reason/);
    expect(decodeRevert('0x12345678')).toBe('revert 0x12345678');
  });
});
