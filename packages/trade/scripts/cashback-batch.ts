/**
 * Cashback (and referral earnings) batch from the treasury Safe: the fallback when claims (POST /v1/me/cashback/claim, paid from the
 * payer wallet) are off, or to pay everyone at once. Claims and batches share cashback_payouts, so nothing is
 * owed twice. Nothing here signs or sends anything: it reads the trade ledger, writes a Safe
 * Transaction Builder file for the treasury Safe's owners to review and sign, and keeps the books.
 *
 *   # 1. See what is owed (read-only): every wallet owed at least the minimum (src/cashback.ts CASHBACK_MIN)
 *   pnpm --filter @rushr/trade exec tsx scripts/cashback-batch.ts build 2026-12-01 --env ../../packages/db/.env.neon
 *   # 2. Same, and record the batch as pending (so it isn't owed twice) and write cashback-2026-12-01.json
 *   pnpm --filter @rushr/trade exec tsx scripts/cashback-batch.ts build 2026-12-01 --write --env ../../packages/db/.env.neon
 *   #    Safe → Apps → Transaction Builder → Upload the JSON → check every row → both owners sign → execute.
 *   # 3. Once executed: check the Safe transaction on chain and mark the batch paid
 *   pnpm --filter @rushr/trade exec tsx scripts/cashback-batch.ts paid 2026-12-01 0x<tx hash> --env ../../packages/db/.env.neon
 *   # Dropped instead (never executed): its amounts are owed again next week
 *   pnpm --filter @rushr/trade exec tsx scripts/cashback-batch.ts void 2026-12-01 --env ../../packages/db/.env.neon
 *
 * Environment (or --env <file> with KEY=VALUE lines): DATABASE_URL (the indexer database), RPC_URL for `paid`
 * (defaults to Robinhood Chain's public RPC).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createPublicClient, formatUnits, http, parseEventLogs, parseAbi, type Hex } from 'viem';
import { robinhoodChain } from '../src/chain';
import { DEFAULT_TRADE_CONFIG } from '../src/config';
import { NATIVE_FEE_TOKEN, payable, txBuilderFile, type Owed } from '../src/cashback';

const argv = process.argv.slice(2);
argv.forEach((a, i) => {
  if (a !== '--env' || !argv[i + 1]) return;
  for (const line of readFileSync(argv[i + 1]!, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
});
const [cmd, batch, hash] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--env');
if (!cmd || !['build', 'paid', 'void'].includes(cmd) || !batch || !/^\d{4}-\d{2}-\d{2}$/.test(batch)) {
  console.error('usage: cashback-batch.ts build|paid|void <YYYY-MM-DD> [tx hash] [--write] [--env file]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL (or pass --env packages/db/.env.neon)');

type Tag = <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
type Sql = Tag & { begin<T>(fn: (tx: Tag) => Promise<T>): Promise<T>; end(): Promise<void> };
// postgres v4 is ESM-only and a dependency of @rushr/db: resolve it there.
const entry = createRequire(new URL('../../db/package.json', import.meta.url)).resolve('postgres');
const postgres = ((await import(pathToFileURL(entry).href)) as { default: (url: string, o: object) => Sql }).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const SAFE = DEFAULT_TRADE_CONFIG.feeRecipient;
const fmt = (p: Owed) => `${formatUnits(p.owed, p.feeToken === NATIVE_FEE_TOKEN ? 18 : 6)} ${p.feeToken === NATIVE_FEE_TOKEN ? 'ETH' : 'USDG'}`;

try {
  if (cmd === 'build') {
    const rows = await sql<{ wallet: string; fee_token: string; owed: string }[]>`
      -- Owed per wallet: its cashback as a trader plus its referral share as a referrer, paid as one transfer.
      with e as (
        select trader as wallet, lower(fee_token) as fee_token, cashback_accrual as amount from trades_ledger
        where status = 'confirmed' and cashback_accrual > 0
        union all
        select lower(referrer), lower(fee_token), referrer_accrual from trades_ledger
        where status = 'confirmed' and referrer is not null and referrer_accrual > 0),
      a as (select wallet, fee_token, sum(amount) as accrued from e group by 1, 2),
      -- Batches and claims both count: paid, or in flight.
      p as (select wallet, lower(fee_token) as fee_token, sum(amount) as out from cashback_payouts
        where status in ('paid', 'pending') group by 1, 2)
      select a.wallet, a.fee_token, (a.accrued - coalesce(p.out, 0))::text as owed
      from a left join p using (wallet, fee_token) where a.accrued - coalesce(p.out, 0) > 0`;
    const all = rows.map((r) => ({ wallet: r.wallet, feeToken: r.fee_token, owed: BigInt(r.owed) }));
    const pay = payable(all);
    console.log(`Owed: ${all.length} wallet/token pair(s); paying ${pay.length} at or above the minimum.`);
    for (const p of pay) console.log(`  ${p.wallet}  ${fmt(p)}`);
    if (!argv.includes('--write')) {
      console.log('\nRead-only. Add --write to record the batch as pending and write the Transaction Builder file.');
    } else if (pay.length) {
      await sql.begin(async (tx) => {
        for (const p of pay) {
          await tx`insert into cashback_payouts (id, batch, wallet, fee_token, amount)
            values (${`${batch}:${p.wallet}:${p.feeToken}`}, ${batch}, ${p.wallet}, ${p.feeToken}, ${p.owed.toString()})`;
        }
      });
      const file = `cashback-${batch}.json`;
      writeFileSync(file, JSON.stringify(txBuilderFile({ safe: SAFE, chainId: robinhoodChain.id, batch, payouts: pay }), null, 2));
      console.log(`\nRecorded ${pay.length} pending payout(s) and wrote ${file}. Upload it in the Safe's Transaction Builder.`);
    }
  } else if (cmd === 'paid') {
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('paid needs the executed Safe transaction hash');
    const client = createPublicClient({ chain: robinhoodChain, transport: http(process.env.RPC_URL || undefined) });
    const r = await client.getTransactionReceipt({ hash: hash as Hex });
    if (r.status !== 'success' || r.to?.toLowerCase() !== SAFE.toLowerCase()) throw new Error(`${hash} is not a successful transaction to the treasury Safe`);
    // The Safe emits ExecutionSuccess for an executed transaction (ExecutionFailure when the inner calls revert).
    const ok = parseEventLogs({ abi: parseAbi(['event ExecutionSuccess(bytes32 txHash, uint256 payment)']), logs: r.logs }).some((l) => l.address.toLowerCase() === SAFE.toLowerCase());
    if (!ok) throw new Error(`${hash}: the Safe didn't report ExecutionSuccess`);
    const n = await sql<unknown[]>`update cashback_payouts set status = 'paid', tx_hash = ${hash.toLowerCase()}, paid_at = now()
      where batch = ${batch} and status = 'pending' returning id`;
    console.log(`Marked ${n.length} payout(s) in ${batch} paid (${hash}).`);
  } else {
    const n = await sql<unknown[]>`update cashback_payouts set status = 'void' where batch = ${batch} and status = 'pending' returning id`;
    console.log(`Voided ${n.length} pending payout(s) in ${batch}; they are owed again.`);
  }
} finally {
  await sql.end();
}
