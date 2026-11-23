// Transfer-tax samples: a routed buy whose recorded trader is a fee wallet or a router must not read as a
// 99.8% / 100% tax, while a real tax (sent to the token contract) is still measured. Local Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { measureTax } from '@rushr/core';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { taxSampleRows } from '../src/signals';

const pg = await pgAvailable();

const TOKEN = '0x7070000000000000000000000000000000000007';
const POOL = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const FEE_WALLET = '0xb85e67cf7728572033a9d36aee3218dadf85baa2';
const ROUTER_A = '0xe8852602f84e04e284286d8db01a41edd0ccefb0';
const ROUTER_B = '0x0729e2a4716d9f7dd17858d5d504426d228697f7';
const BUYER = '0x67312a62aab218f6d863c1d909f4abfab184e9a6';
const E18 = 10n ** 18n;

let sql: Sql;
let drop: () => Promise<void>;
let block = 100n;

async function trade(tx: string, side: 'buy' | 'sell', trader: string, tokenAmount: bigint, moves: [string, string, bigint][]) {
  block += 1n;
  await sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount)
    values (${tx}, 0, ${TOKEN}, ${POOL}, ${block.toString()}, now(), ${trader}, ${side}, ${tokenAmount.toString()}, 'eth', '1')`;
  let i = 1;
  for (const [from, to, amount] of moves) {
    await sql`insert into transfers (tx, log_index, token, block, time, "from", "to", amount)
      values (${tx}, ${i++}, ${TOKEN}, ${block.toString()}, now(), ${from}, ${to}, ${amount.toString()})`;
  }
}

const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe.skipIf(!pg)('taxSampleRows', () => {
  beforeAll(async () => {
    ({ sql, drop } = await freshDb('tax_samples'));
  });
  afterAll(async () => drop?.());

  it('ignores routed buys credited to a 0.2% fee wallet or a router, and reads the real 0.2% charge', async () => {
    // QHooks-style buy: 0.2% to the fee wallet, the rest hops through two routers to the buyer.
    const amt = 1_000n * E18;
    const fee = amt / 500n;
    for (let k = 0; k < 3; k++) {
      await trade(tx(10 + k), 'buy', BUYER, amt, [
        [POOL, FEE_WALLET, fee],
        [POOL, ROUTER_A, amt - fee],
        [ROUTER_A, ROUTER_B, amt - fee],
        [ROUTER_B, BUYER, amt - fee],
      ]);
    }
    // The same buys, mis-resolved to the fee wallet (looks like 99.8%) and to a router (looks like 100%).
    for (let k = 0; k < 4; k++) {
      await trade(tx(20 + k), 'buy', FEE_WALLET, amt, [
        [POOL, FEE_WALLET, fee],
        [POOL, ROUTER_A, amt - fee],
        [ROUTER_A, BUYER, amt - fee],
      ]);
      await trade(tx(30 + k), 'buy', ROUTER_A, amt, [
        [POOL, ROUTER_A, amt],
        [ROUTER_A, BUYER, amt],
      ]);
    }
    const rows = await taxSampleRows(sql, TOKEN);
    expect(rows).toHaveLength(3);
    const tax = measureTax(rows.map((r) => ({ side: r.side, swapAmount: BigInt(r.token_amount), traderNet: BigInt(r.net) })));
    expect(tax.buyTaxBps).toBe(20);
  });

  it('still measures a real tax that goes to the token contract', async () => {
    await sql`delete from swaps`;
    await sql`delete from transfers`;
    const amt = 1_000n * E18;
    for (let k = 0; k < 3; k++) {
      // 10% kept by the token contract, 90% to the buyer.
      await trade(tx(40 + k), 'buy', BUYER, amt, [
        [POOL, TOKEN, amt / 10n],
        [POOL, BUYER, amt - amt / 10n],
      ]);
    }
    const rows = await taxSampleRows(sql, TOKEN);
    const tax = measureTax(rows.map((r) => ({ side: r.side, swapAmount: BigInt(r.token_amount), traderNet: BigInt(r.net) })));
    expect(tax.buyTaxBps).toBe(1_000);
  });
});
