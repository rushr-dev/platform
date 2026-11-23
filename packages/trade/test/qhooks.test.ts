import { describe, expect, it } from 'vitest';
import { encodeFunctionData, type Address } from 'viem';
import { erc20Abi } from '../src/abis';
import { checkPrepared, qhooksPool, QHOOKS_FEE_ROUTER } from '../src/qhooks';
import fixture from './fixtures/qhooks-prepare-buy.json';

// A real prepare_trade answer (buy 0.001 WETH of QHOOKS, 2026-11-23), trimmed of its wallet_sendCalls copy.
const TOKEN = '0x20429af7ca3b0ce4d99edbaa0693f26c5df05195' as Address;
const TRADER = '0x4fc9e610c270ae08717f43275f0fcaa57af39e5d' as Address;
const req = { side: 'buy' as const, token: TOKEN, amountIn: 1_000_000_000_000_000n, trader: TRADER };
const clone = () => JSON.parse(JSON.stringify(fixture)) as typeof fixture;
const approve = (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

describe('QHooks prepared trades', () => {
  it('accepts the real answer: WETH approval to the fee router, then the router swap', () => {
    const p = checkPrepared(fixture, req);
    expect(p.approval?.to).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    expect(p.swap.to).toBe(QHOOKS_FEE_ROUTER);
    expect(p.routerFeeBps).toBe(100);
    expect(p.minOut).toBe(4996633088376145062486n);
    expect(p.poolAmountIn).toBe(990_000_000_000_000n);
  });

  it('refuses a swap that goes anywhere but the fee router', () => {
    const d = clone();
    d.transactions[1]!.to = '0x204faca1764b154221e35c0d20abb3c525710498';
    expect(() => checkPrepared(d, req)).toThrow(/swap target/);
  });

  it('refuses an approval to another spender or for more than the trade', () => {
    const d = clone();
    d.transactions[0]!.data = approve('0x000000000000000000000000000000000000dead', req.amountIn);
    expect(() => checkPrepared(d, req)).toThrow(/approval spender/);
    const e = clone();
    e.transactions[0]!.data = approve(QHOOKS_FEE_ROUTER, req.amountIn * 1000n);
    expect(() => checkPrepared(e, req)).toThrow(/approval amount/);
  });

  it('refuses ETH value, another trader, token, chain or amount, and extra transactions', () => {
    const cases: [string, (d: ReturnType<typeof clone>) => void][] = [
      ['ETH value', (d) => (d.transactions[1]!.value = '1')],
      ['trader', (d) => (d.trader = '0x000000000000000000000000000000000000beef')],
      ['token', (d) => (d.token = '0x000000000000000000000000000000000000beef')],
      ['chain', (d) => (d.chain = '8453')],
      ['amount', (d) => (d.amountIn = '2000000000000000')],
      ['transaction count', (d) => d.transactions.push({ ...d.transactions[1]! })],
    ];
    for (const [why, mutate] of cases) {
      const d = clone();
      mutate(d);
      expect(() => checkPrepared(d, req), why).toThrow(new RegExp(why));
    }
  });

  it('refuses a minimum above the quoted output', () => {
    const d = clone();
    d.minOut = (BigInt(d.quote.netAmountOut) + 1n).toString();
    expect(() => checkPrepared(d, req)).toThrow(/minimum output/);
  });

  it('finds the QHooks launch pool by its hook and WETH quote', () => {
    const base = { venue: 'uniswap-v4' as const, token: TOKEN, venueFeeBps: 100, venueFeeLabel: '1%', hookData: '0x' as const };
    const key = (hooks: Address) => ({ currency0: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks });
    const plain = { ...base, id: '0x01' as const, quote: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address, key: key('0x0000000000000000000000000000000000000000') };
    const q = { ...base, id: '0x02' as const, quote: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address, key: key('0x023623568f41c032ec2f4bba368dbafc123160cc') };
    expect(qhooksPool([plain])).toBeNull();
    expect(qhooksPool([plain, q])?.id).toBe('0x02');
    // Auction launches have their own hooks: the Rushr API's `qhooks` tag marks them.
    const auction = { ...base, id: '0x03' as const, quote: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address, key: key('0x08a7c13fd8bfeae5726abd8332c627a7ab01eacc') };
    expect(qhooksPool([plain, auction])).toBeNull();
    expect(qhooksPool([plain, auction], [{ pool: '0x03', launchpad: 'qhooks' }])?.id).toBe('0x03');
  });
});
