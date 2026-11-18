import { describe, expect, it } from 'vitest';
import { busyFunders } from '../src/signals';
import type { Rpc } from '../src/rpc';

/** A fake RPC answering eth_getTransactionCount from a table, counting how often it's asked. */
function fakeRpc(nonces: Record<string, number>) {
  let calls = 0;
  const rpc = {
    async batch<T>(reqs: { method: string; params: unknown[] }[]) {
      calls += reqs.length;
      return reqs.map((r) => `0x${(nonces[r.params[0] as string] ?? 0).toString(16)}`) as T[];
    },
  } as unknown as Rpc;
  return { rpc, calls: () => calls };
}

describe('busyFunders', () => {
  it('treats a wallet with thousands of sends as a shared source, not a dev cluster', async () => {
    // 0x668b… funded the real $MORPH dev and 15 unrelated launchers: 4,846 sends on-chain.
    const exchange = '0x668b25b57779c07ccea2eeade67e5f90f56c92fe';
    const friend = '0x1111111111111111111111111111111111111111';
    const { rpc } = fakeRpc({ [exchange]: 4_846, [friend]: 12 });
    expect(await busyFunders(rpc, [exchange, friend])).toEqual(new Set([exchange]));
  });

  it('caches answers and works from the cache without an RPC', async () => {
    const hub = '0x2222222222222222222222222222222222222222';
    const { rpc, calls } = fakeRpc({ [hub]: 2_000 });
    await busyFunders(rpc, [hub]);
    await busyFunders(rpc, [hub]);
    expect(calls()).toBe(1);
    expect(await busyFunders(null, [hub])).toEqual(new Set([hub]));
    expect(await busyFunders(null, ['0x3333333333333333333333333333333333333333'])).toEqual(new Set());
  });
});
