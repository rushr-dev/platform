/**
 * Fee audit (read-only): for each trade, what the treasury actually received versus the expected fee
 * rate on the trade's notional. Nothing is signed or sent; the ledger is only read.
 *
 * Universal Router trades carry the fee inside the swap. Direct PONS curve trades pay it in a follow-up
 * transfer, which must come from the trader at the next nonce (its hash is in the ledger's flags as
 * `fee_tx:<hash>`, or given on the command line as `<trade hash>:<fee hash>`).
 *
 *   # specific transactions (a curve trade with its fee transfer: trade:fee)
 *   pnpm --filter @rushr/trade exec tsx scripts/fee-audit.ts --tx 0xabc… 0xdef…:0x123…
 *   # the last N trades in the trade ledger (all wallets, or one wallet; any status: each trade is
 *   # checked on the chain, so rows the ledger hasn't confirmed yet are audited too)
 *   pnpm --filter @rushr/trade exec tsx scripts/fee-audit.ts --last 20
 *   pnpm --filter @rushr/trade exec tsx scripts/fee-audit.ts --wallet 0x… --last 10
 *
 * Environment (or `--env <file>` with KEY=VALUE lines, repeatable, later files win; e.g. apps/indexer/.dev.vars):
 *   RPC_URL       an RPC with debug_traceTransaction (ETH fees are internal transfers, visible only in a
 *                 call trace). Without one, ETH trades are flagged `no_trace` and only tokens are checked.
 *   DATABASE_URL  the indexer database, for --last / --wallet (read in a read-only transaction).
 * Options: --bps <n> expected base rate (default: the config's, 25 during the beta); --json.
 * Exit code 1 when any trade is flagged.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createPublicClient, formatUnits, http, type Hex } from 'viem';
import { robinhoodChain } from '../src/chain';
import { DEFAULT_TRADE_CONFIG, resolveConfig } from '../src/config';
import { effectiveFeeBps } from '../src/referral';
import { auditFee, type CallFrame } from '../src/fee-audit';
import { auditCurveFee, curveFillFromLogs, type FeeTxInfo } from '../src/curve-fee';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// --env may repeat; a later file overrides an earlier one (e.g. .dev.vars, then .dev.vars.neon for the
// production database). Variables already set in the environment win over every file.
const fromFiles: Record<string, string> = {};
argv.forEach((a, i) => {
  if (a !== '--env' || !argv[i + 1]) return;
  for (const line of readFileSync(argv[i + 1]!, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) fromFiles[m[1]!] = m[2]!;
  }
});
for (const [k, v] of Object.entries(fromFiles)) if (!process.env[k]) process.env[k] = v;

const cfg = resolveConfig(opt('--bps') ? { feeBps: Number(opt('--bps')) } : {});
const referredBps = effectiveFeeBps(cfg, { referrer: cfg.feeRecipient });
const rpcUrl = process.env.RPC_URL;
const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
const ur = DEFAULT_TRADE_CONFIG.universalRouter.toLowerCase();

interface LedgerRow { tx_hash: Hex; trader: string; referrer: string | null; status: string; fee_amount: string | null; flags: string[] }
let rows: LedgerRow[];
const txIdx = argv.indexOf('--tx');
if (txIdx >= 0) {
  rows = argv
    .slice(txIdx + 1)
    .filter((a) => /^0x[0-9a-fA-F]{64}(:0x[0-9a-fA-F]{64})?$/.test(a))
    .map((a) => {
      const [h, fee] = a.split(':');
      return { tx_hash: h as Hex, trader: '', referrer: null, status: '', fee_amount: null, flags: fee ? [`fee_tx:${fee.toLowerCase()}`] : [] };
    });
} else {
  const n = Math.min(Number(opt('--last') ?? 20), 500);
  const wallet = opt('--wallet')?.toLowerCase();
  if (!process.env.DATABASE_URL) throw new Error('--last / --wallet read the trade ledger: set DATABASE_URL (or pass --env apps/indexer/.dev.vars)');
  // `postgres` is a dependency of @rushr/db, not of this package.
  type Tag = <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  type Sql = Tag & { begin<T>(mode: string, fn: (tx: Tag) => Promise<T>): Promise<T>; end(): Promise<void> };
  // postgres v4 is ESM-only: resolve it from @rushr/db and import it as ESM (its default export).
  const entry = createRequire(new URL('../../db/package.json', import.meta.url)).resolve('postgres');
  const postgres = ((await import(pathToFileURL(entry).href)) as { default: (url: string, o: object) => Sql }).default;
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    rows = await sql.begin('read only', (tx) =>
      wallet
        ? tx<LedgerRow[]>`select tx_hash, trader, referrer, status, fee_amount::text, flags from trades_ledger where chain_id = 4663 and trader = ${wallet} order by ts desc limit ${n}`
        : tx<LedgerRow[]>`select tx_hash, trader, referrer, status, fee_amount::text, flags from trades_ledger where chain_id = 4663 order by ts desc limit ${n}`,
    );
  } finally {
    await sql.end();
  }
  if (!rows.length) console.log('No trades in the ledger for that query.');
}

/** One line of the report, for either kind of trade. */
interface Result {
  hash: Hex;
  kind: 'universal-router' | 'curve';
  side: 'buy' | 'sell' | null;
  quoteAsset: 'ETH' | 'USDG' | null;
  notional: bigint | null;
  /** What the treasury received, per asset. */
  received: Record<string, bigint>;
  fee: bigint;
  feeBps: number | null;
  expectedBps: number | null;
  calldataBps: number | null;
  feeTxHash: Hex | null;
  flags: string[];
  ledger?: { status: string; fee: string | null; flags: string[] };
}

let traceOk = true;
const results: Result[] = [];
for (const r of rows) {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: r.tx_hash }), client.getTransactionReceipt({ hash: r.tx_hash })]);
  let trace: CallFrame | null = null;
  if (traceOk)
    trace = await client.request({ method: 'debug_traceTransaction' as never, params: [r.tx_hash, { tracer: 'callTracer' }] as never }).then((t) => t as CallFrame, () => ((traceOk = false), null));
  const ledger = r.trader ? { ledger: { status: r.status, fee: r.fee_amount, flags: r.flags } } : {};
  const referred = r.trader ? r.referrer != null : null;
  if (tx.to?.toLowerCase() !== ur && curveFillFromLogs(receipt.logs, tx.from)) {
    // Direct curve trade: the fee is the follow-up transfer.
    const feeHash = r.flags.find((f) => f.startsWith('fee_tx:'))?.slice('fee_tx:'.length) as Hex | undefined;
    let feeTx: FeeTxInfo | null = null;
    if (feeHash) {
      const [ft, fr] = await Promise.all([client.getTransaction({ hash: feeHash }), client.getTransactionReceipt({ hash: feeHash })]);
      feeTx = { hash: feeHash, from: ft.from, to: ft.to ?? null, value: ft.value, input: ft.input, nonce: ft.nonce, status: fr.status };
    }
    const c = auditCurveFee({ hash: r.tx_hash, from: tx.from, nonce: tx.nonce, value: tx.value, status: receipt.status, logs: receipt.logs, trace, feeTx, treasury: cfg.feeRecipient, feeBps: cfg.feeBps, referredFeeBps: referredBps, referred });
    if (r.trader && r.status === 'confirmed' && r.fee_amount != null && BigInt(r.fee_amount) !== c.fee) c.flags.push('ledger_fee_differs');
    results.push({ hash: c.hash, kind: 'curve', side: c.side, quoteAsset: 'ETH', notional: c.notional, received: c.fee ? { ETH: c.fee } : {}, fee: c.fee, feeBps: c.feeBps, expectedBps: c.expectedBps, calldataBps: null, feeTxHash: c.feeTxHash, flags: c.flags, ...ledger });
    continue;
  }
  const a = auditFee({
    hash: r.tx_hash,
    from: tx.from,
    to: tx.to ?? null,
    value: tx.value,
    input: tx.input,
    status: receipt.status,
    logs: receipt.logs as never,
    trace,
    treasury: cfg.feeRecipient,
    feeBps: cfg.feeBps,
    referredFeeBps: referredBps,
    referred,
  });
  if (r.trader && r.status === 'confirmed' && r.fee_amount != null && BigInt(r.fee_amount) !== a.fee && !a.flags.includes('no_trace')) a.flags.push('ledger_fee_differs');
  results.push({ hash: a.hash, kind: 'universal-router', side: a.side, quoteAsset: a.quoteAsset, notional: a.notional, received: a.received, fee: a.fee, feeBps: a.feeBps, expectedBps: a.expectedBps, calldataBps: a.calldataBps, feeTxHash: null, flags: a.flags, ...ledger });
}

if (argv.includes('--json')) console.log(JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
else {
  if (!traceOk) console.log('Note: this RPC has no debug_traceTransaction, so ETH fees could not be read (flag no_trace). Set RPC_URL.');
  console.log(`Expected: ${cfg.feeBps} bps (${referredBps} referred) to ${cfg.feeRecipient}\n`);
  for (const a of results) {
    const dec = a.quoteAsset === 'USDG' ? 6 : 18;
    const unit = a.quoteAsset ?? '';
    const paid = Object.entries(a.received).map(([k, v]) => `${formatUnits(v, k === 'ETH' ? 18 : dec)} ${k === 'ETH' ? 'ETH' : k.slice(0, 8)}`).join(' + ') || '0';
    console.log(
      `${a.flags.length ? 'FLAG' : 'ok  '} ${a.hash.slice(0, 12)}… ${a.kind === 'curve' ? 'curve ' : ''}${a.side ?? '?'} ${unit} notional ${a.notional != null ? formatUnits(a.notional, dec) : '?'}; treasury got ${paid}` +
        ` = ${a.feeBps ?? '?'} bps (expected ${a.expectedBps ?? '?'}, ${a.kind === 'curve' ? `fee tx ${a.feeTxHash ? `${a.feeTxHash.slice(0, 12)}…` : 'none'}` : `calldata ${a.calldataBps ?? '-'}`})` +
        (a.ledger ? `; ledger ${a.ledger.status} [${a.ledger.flags.join(', ')}]` : '') +
        (a.flags.length ? `\n     flags: ${a.flags.join(', ')}` : ''),
    );
  }
}
process.exitCode = results.some((a) => a.flags.length) ? 1 : 0;
