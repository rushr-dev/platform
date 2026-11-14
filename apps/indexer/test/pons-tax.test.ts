import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import { readPonsTax } from '../src/pons-tax';
import type { Rpc } from '../src/rpc';

const TOKEN = '0x6dbe95076584f869dd09a44131e9a3c13f34d7d6';
const CURVE = '0x612229828e1d55628693b0220b16eaeab8b33572';
const u256 = (n: number) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)]);
// feeBps() and creatorTaxBps() selectors.
const FEE = '0x24a9d853';
const TAX = '0xc1bb8901';

function fakeRpc(answers: Record<string, Hex>) {
  const calls: string[] = [];
  const rpc = {
    async batch(cs: { method: string; params: [{ to: string; data: string }, string] }[]) {
      return cs.map((c) => {
        calls.push(`${c.params[0].to}:${c.params[0].data.slice(0, 10)}`);
        return answers[`${c.params[0].to}:${c.params[0].data.slice(0, 10)}`] ?? null;
      });
    },
  } as unknown as Rpc;
  return { rpc, calls };
}

const sqlWith = (rows: unknown[]) => (async () => rows) as never;

describe('readPonsTax', () => {
  it("reads the creator tax and fee from the token's curve in one batch", async () => {
    const { rpc, calls } = fakeRpc({ [`${CURVE}:${FEE}`]: u256(100), [`${CURVE}:${TAX}`]: u256(300) });
    const t = await readPonsTax(sqlWith([{ id: CURVE }]), rpc, TOKEN);
    expect(t).toMatchObject({ curve: CURVE, feeBps: 100, creatorTaxBps: 300 });
    expect(calls).toHaveLength(2);
  });

  it('finds the curve through the factory when no curve pool is stored', async () => {
    const launched = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [TOKEN, CURVE]);
    const { rpc } = fakeRpc({
      '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e:0x3cf28b5a': launched,
      [`${CURVE}:${FEE}`]: u256(100),
      [`${CURVE}:${TAX}`]: u256(200),
    });
    expect(await readPonsTax(sqlWith([]), rpc, TOKEN)).toMatchObject({ curve: CURVE, creatorTaxBps: 200 });
  });

  it('returns null for a token the factory does not know', async () => {
    const { rpc } = fakeRpc({});
    expect(await readPonsTax(sqlWith([]), rpc, TOKEN)).toBeNull();
  });
});
