import { describe, expect, it } from 'vitest';
import { keccak256, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SendError, TxPipeline, verifySigned, type UnsignedEip1559 } from '../src/fast-send';
import { quickBuy, type WalletCall } from '../src/quick';
import { withSlippage, quotePool } from '../src/quote';
import { resolveConfig } from '../src/config';
import { TRADE_ADDRESSES } from '../src/addresses';
import type { V2Pool } from '../src/types';

// Well-known local test key (anvil #0); never holds funds on Robinhood Chain.
const acct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const sign = (tx: UnsignedEip1559) => acct.signTransaction(tx);
const call: WalletCall = { label: 'swap', chainId: 4663, to: '0x204faca1764b154221e35c0d20abb3c525710498', data: '0x3593564c', value: 10n ** 16n, gas: 380_000n };

const receipt = (hash: Hex) => ({
  blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x10', contractAddress: null, cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: acct.address,
  gasUsed: '0x23c34', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', to: call.to, transactionHash: hash, transactionIndex: '0x1', type: '0x2',
});

function fakeClient(rpc: (method: string, params: unknown[]) => unknown, nonce = 7) {
  const calls: string[] = [];
  const client = {
    getTransactionCount: async () => (calls.push('nonce'), nonce),
    getBlock: async () => (calls.push('block'), { baseFeePerGas: 20_000_000n }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => (calls.push('receipt'), { status: 'success', transactionHash: hash }),
    request: async ({ method, params }: { method: string; params: unknown[] }) => (calls.push(method), rpc(method, params)),
  } as unknown as PublicClient;
  return { client, calls };
}

describe('fast send', () => {
  it('signs with cached nonce/fees, reports the hash before the receipt, confirms via eth_sendRawTransactionSync', async () => {
    let sent: Hex | null = null;
    const { client, calls } = fakeClient((m, p) => {
      sent = p[0] as Hex;
      return receipt(keccak256(sent));
    });
    const pipe = new TxPipeline(client, acct.address);
    await pipe.warm();
    expect(pipe.cached).toEqual({ nonce: 7, maxFeePerGas: 40_000_000n });
    calls.length = 0;
    let submitted: Hex | null = null;
    const r = await pipe.send(call, sign, { onSubmitted: (h) => (submitted = h) });
    expect(calls).toEqual(['eth_sendRawTransactionSync']); // nothing fetched at click time
    expect(submitted).toBe(r.hash);
    expect(r.hash).toBe(keccak256(sent!));
    expect(r.receipt.status).toBe('success');
    expect(r.timings.via).toBe('sync');
    expect(pipe.cached.nonce).toBe(8);
    // Next trade uses the next nonce without asking the chain.
    await pipe.send(call, sign);
    expect(calls.filter((c) => c === 'nonce')).toEqual([]);
    expect(pipe.cached.nonce).toBe(9);
  });

  it('falls back to eth_sendRawTransaction + receipt polling when the sync method is missing', async () => {
    const { client, calls } = fakeClient((m) => {
      if (m === 'eth_sendRawTransactionSync') throw Object.assign(new Error('the method does not exist/is not available'), { code: -32601 });
      return '0x';
    });
    const pipe = new TxPipeline(client, acct.address, { pollMs: 1 });
    const r = await pipe.send(call, sign);
    expect(r.timings.via).toBe('poll');
    expect(calls).toContain('eth_sendRawTransaction');
    calls.length = 0;
    await pipe.send(call, sign);
    expect(calls).not.toContain('eth_sendRawTransactionSync'); // remembered
  });

  it('a rejected broadcast drops the cached nonce and says why', async () => {
    const { client } = fakeClient(() => {
      throw new Error('nonce too low: next nonce 9, tx nonce 7');
    });
    const pipe = new TxPipeline(client, acct.address);
    await expect(pipe.send(call, sign)).rejects.toMatchObject({ code: 'NONCE' });
    expect(pipe.cached.nonce).toBeNull();
  });

  it('never broadcasts a signature over a different transaction, or from another account', async () => {
    const tx: UnsignedEip1559 = { type: 'eip1559', chainId: 4663, nonce: 1, to: call.to, data: call.data, value: call.value, gas: call.gas, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n };
    await expect(verifySigned(await sign(tx), tx, acct.address)).resolves.toBeUndefined();
    await expect(verifySigned(await sign({ ...tx, value: 2n * 10n ** 16n }), tx, acct.address)).rejects.toBeInstanceOf(SendError);
    await expect(verifySigned(await sign({ ...tx, to: '0x000000000000000000000000000000000000dEaD' }), tx, acct.address)).rejects.toThrow(/different transaction/);
    await expect(verifySigned(await sign(tx), tx, '0x2222222222222222222222222222222222222222')).rejects.toThrow(/another account/);
    const { client, calls } = fakeClient(() => receipt('0x'));
    const pipe = new TxPipeline(client, acct.address);
    await expect(pipe.send(call, async (t) => sign({ ...t, data: '0xdeadbeef' }))).rejects.toMatchObject({ code: 'MISMATCH' });
    await expect(pipe.send(call, async () => `0x${'ab'.repeat(65)}`)).rejects.toMatchObject({ code: 'UNSUPPORTED' }); // a bare signature
    expect(calls.some((c) => c.startsWith('eth_send'))).toBe(false);
    expect(pipe.cached.nonce).toBe(7); // nothing reserved
  });
});

describe('fewer round trips', () => {
  const TOKEN = '0x39dbed3a2bd333467115de45665cc57f813c4571' as const;
  const v2: V2Pool = { venue: 'uniswap-v2', id: '0x8018ee3ad3000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, reserveToken: 10n ** 27n, reserveQuote: 10n ** 21n, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2' };
  const fake = { getGasPrice: async () => 100_000_000n } as unknown as PublicClient;
  const trader = '0x2222222222222222222222222222222222222222' as const;

  it('withSlippage equals a fresh quote at that slippage (no second quote call)', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const req = { side, token: TOKEN, quoteAsset: 'ETH' as const, amountIn: 10n ** 20n, trader };
      const at5 = await quotePool(fake, v2, { ...req, slippageBps: 500 }, resolveConfig());
      const at12 = await quotePool(fake, v2, { ...req, slippageBps: 1200 }, resolveConfig());
      expect(withSlippage(at5, 1200)).toEqual(at12);
    }
  });

  it('buys carry the approvals a later sell needs, with a generous per-venue gas limit', async () => {
    const t = await quickBuy(fake, { token: TOKEN, ethWei: 10n ** 17n, trader }, { discover: { pools: [v2] }, simulate: false, assume: { ethWei: 10n ** 18n }, now: () => 1_000_000 });
    expect(t.ok).toBe(true);
    expect(t.calls.map((c) => c.label)).toEqual(['swap']);
    expect(t.calls[0]!.gas).toBe(250_000n);
    expect(t.sellApprovals.map((c) => c.label)).toEqual(['approve token for Permit2', 'allow Universal Router in Permit2']);
  });
});
