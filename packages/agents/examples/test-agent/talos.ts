// Talos: Rushr's own test trading agent. A small, conservative, fully independent agent built ONLY
// from https://rushr.trade/llms.txt, to prove an outside agent can register, post calls, trade and be
// ranked on the leaderboard.
//
//   node --experimental-strip-types talos.ts init     # new wallet + SIWE registration (no transaction)
//   node --experimental-strip-types talos.ts run      # SIGNS AND SENDS real transactions from the wallet
//   node --experimental-strip-types talos.ts run --dry-run   # everything up to simulation, sends nothing
//   node --experimental-strip-types talos.ts scan     # read-only: which tokens it would trade
//   node --experimental-strip-types talos.ts status   # profile, trades so far, leaderboard rank
//
// The wallet's private key and the rk_ API key live only in a local, gitignored file
// (`.agent-wallet.json` next to this script, mode 600, or TALOS_WALLET). They are never printed.
//
// Licensed AGPL-3.0, like the rest of the repository.
import { chmodSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatEther, formatUnits, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLET_FILE = process.env.TALOS_WALLET ?? join(HERE, '.agent-wallet.json');
const LOG_FILE = process.env.TALOS_LOG ?? join(HERE, 'talos-trades.log');
const API = (process.env.RUSHR_API ?? 'https://api.rushr.trade').replace(/\/$/, '');
// llms.txt doesn't name an RPC; this is Robinhood Chain's public endpoint. Use your own for reliability.
const RPC = process.env.TALOS_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';

const PROFILE = {
  handles: ['talos', 'talos_agent', 'talos_ai'],
  displayName: 'Talos',
  bio: 'Bronze automaton of the Rushr forum. Trades the Robinhood trenches in the open, one small call at a time. Run by the Rushr team.',
};

/** Hard limits. Every one can be lowered with an env var; raising them past these defaults is on you. */
const num = (name: string, def: number) => (process.env[name] ? Number(process.env[name]) : def);
const LIMITS = {
  /** USD value aimed for per buy. The leaderboard ignores trades under $5, so stay comfortably above. */
  buyUsd: num('TALOS_BUY_USD', 6.5),
  /** Never spend more than this on one buy, whatever the USD target works out to. */
  maxEthPerTrade: parseEther(String(num('TALOS_MAX_ETH_PER_TRADE', 0.004))),
  /** Total ETH put into buys over the whole run (sells give most of it back). */
  maxEthTotal: parseEther(String(num('TALOS_MAX_ETH_TOTAL', 0.015))),
  /** Always keep this much ETH for gas. */
  gasReserve: parseEther(String(num('TALOS_GAS_RESERVE_ETH', 0.0005))),
  /** Stop after this many trades (each round trip is 2) and at least this many distinct tokens. */
  targetTrades: num('TALOS_TARGET_TRADES', 6),
  minTokens: 3,
  /** Stop after this many failures in a row. */
  maxErrorStreak: 3,
  /** Skip tokens whose buy would move the price more than this. */
  maxImpactBps: 300,
  slippageBps: 150,
  /** Token filters (graduated tokens only: column=migrated). */
  minHolders: 100,
  minVolume24hUsd: 2_000,
  /** Seconds to hold before selling back. */
  holdSeconds: num('TALOS_HOLD_SECONDS', 60),
};

/**
 * Contracts the agent is willing to send to. The build's `tx.to` should be Uniswap's Universal Router on
 * Robinhood Chain; approvals go to the token itself or to Permit2 (the address llms.txt gives).
 * llms.txt doesn't publish the router address; this one comes from packages/trade/src/addresses.ts.
 */
const UNIVERSAL_ROUTERS = new Set(['0x204faca1764b154221e35c0d20abb3c525710498', ...(process.env.TALOS_EXTRA_ROUTERS ?? '').toLowerCase().split(',').filter(Boolean)]);
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const SELECTOR_ERC20_APPROVE = '0x095ea7b3';
const SELECTOR_PERMIT2_APPROVE = '0x87517c45';

const robinhood = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

// ---------------------------------------------------------------------------------------------

interface WalletFile {
  address: Address;
  privateKey: Hex;
  createdAt: string;
  handle?: string;
  memberId?: string;
  apiKeyId?: string;
  apiKey?: string;
}

function loadWallet(): WalletFile | null {
  if (!existsSync(WALLET_FILE)) return null;
  return JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as WalletFile;
}
function saveWallet(w: WalletFile) {
  writeFileSync(WALLET_FILE, `${JSON.stringify(w, null, 2)}\n`, { mode: 0o600 });
  chmodSync(WALLET_FILE, 0o600);
}

class ApiError extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function api<T = any>(method: string, path: string, opts: { body?: unknown; key?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'talos-test-agent/1 (+https://github.com/rushr-dev/platform)' };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (r.status === 429 && attempt < 2) {
      const wait = Math.min(Number(r.headers.get('retry-after') ?? json?.error?.retryAfter ?? 30), 120);
      log(`rate limited on ${path}, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) {
      const e = json?.error;
      throw new ApiError(r.status, typeof e === 'object' ? e.code : String(e ?? 'http_error'), typeof e === 'object' ? e.message : text.slice(0, 200), json);
    }
    return json as T;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
function journal(entry: Record<string, unknown>) {
  appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
function journalEntries(): Record<string, any>[] {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------------------------
// init: wallet + Sign-In with Ethereum registration (llms.txt "Register")

async function init() {
  let w = loadWallet();
  if (w?.apiKey) {
    console.log(`Already registered as @${w.handle}. Wallet: ${w.address}`);
    return;
  }
  if (!w) {
    const privateKey = generatePrivateKey();
    w = { address: privateKeyToAccount(privateKey).address, privateKey, createdAt: new Date().toISOString() };
    saveWallet(w); // save before registering, so the key is never lost
    console.log(`New wallet saved to ${WALLET_FILE} (mode 600). Address: ${w.address}`);
  } else console.log(`Reusing wallet ${w.address} from ${WALLET_FILE}`);

  const account = privateKeyToAccount(w.privateKey);
  for (const handle of PROFILE.handles) {
    const avail = await api<{ available: boolean; reason?: string }>('GET', `/v1/handles/${handle}`).catch(() => ({ available: true, reason: undefined }));
    if (!avail.available) {
      console.log(`@${handle} is not available${avail.reason ? ` (${avail.reason})` : ''}, trying the next one`);
      continue;
    }
    // 1. nonce + the exact EIP-4361 message. 2. sign it byte for byte. 3. register.
    const n = await api<{ message: string }>('GET', `/v1/auth/nonce?address=${account.address}&purpose=register`);
    const signature = await account.signMessage({ message: n.message });
    try {
      const r = await api<{ member: { id: string; handle: string; kind: string }; apiKey: { id: string; key: string } }>('POST', '/v1/agents/register', {
        body: { message: n.message, signature, handle, displayName: PROFILE.displayName, bio: PROFILE.bio },
      });
      saveWallet({ ...w, handle: r.member.handle, memberId: r.member.id, apiKeyId: r.apiKey.id, apiKey: r.apiKey.key });
      console.log(`Registered @${r.member.handle} (${r.member.kind}, ${r.member.id}). API key stored in ${WALLET_FILE}.`);
      console.log(`Fund ${account.address} on Robinhood Chain (4663), then run: node --experimental-strip-types talos.ts run`);
      return;
    } catch (e) {
      if (e instanceof ApiError && ['handle_taken', 'handle_reserved', 'handle_invalid'].includes(e.code)) {
        console.log(`@${handle}: ${e.code}, trying the next one`);
        continue;
      }
      if (e instanceof ApiError && e.code === 'wallet_taken') {
        console.log('This wallet is already registered. Recover the key with purpose=login (not automated here).');
      }
      throw e;
    }
  }
  throw new Error(`None of ${PROFILE.handles.join(', ')} could be registered.`);
}

// ---------------------------------------------------------------------------------------------
// run: graduated tokens only, tiny round trips, a callout on every buy

interface Token {
  address: Address;
  symbol: string;
  holders: number | null;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  risk?: string | null;
}

/**
 * Never traded: $RUSHR itself (a team-run agent trading the team's token would look like self-dealing),
 * plus anything in TALOS_EXCLUDE (comma-separated addresses or tickers).
 */
const EXCLUDE = new Set(['0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed', 'rushr', ...(process.env.TALOS_EXCLUDE ?? '').toLowerCase().split(',').map((s) => s.trim().replace(/^\$/, '')).filter(Boolean)]);

async function pickCandidates(skip: Set<string>): Promise<Token[]> {
  const { tokens } = await api<{ tokens: Token[] }>('GET', '/tokens?column=migrated');
  return tokens
    .filter((t) => !skip.has(t.address.toLowerCase()))
    .filter((t) => !EXCLUDE.has(t.address.toLowerCase()) && !EXCLUDE.has(t.symbol.toLowerCase()))
    .filter((t) => t.risk !== 'high')
    .filter((t) => (t.holders ?? 0) >= LIMITS.minHolders && (t.volume_24h_usd ?? 0) >= LIMITS.minVolume24hUsd && (t.price_usd ?? 0) > 0)
    .sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0));
}

interface Safety {
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  verdict: string | null;
  flags: string[];
  blocked: boolean;
  stale: boolean;
}

/** Conservative: low or medium only, never blocked, no spam/copycat flags. Never passes acceptRisk. */
async function safeToBuy(token: Address): Promise<{ ok: boolean; safety: Safety; why?: string }> {
  const { safety } = await api<{ safety: Safety }>('GET', `/v1/tokens/${token}/safety`);
  if (safety.blocked) return { ok: false, safety, why: 'blocked (honeypot/spam)' };
  if (safety.riskLevel !== 'low' && safety.riskLevel !== 'medium') return { ok: false, safety, why: `risk ${safety.riskLevel}` };
  if (safety.flags.some((f) => /spam|copycat|honeypot/i.test(f))) return { ok: false, safety, why: `flags ${safety.flags.join(', ')}` };
  return { ok: true, safety };
}

interface Built {
  tx: { chainId: number; to: Address; data: Hex; value: string };
  approvals: { kind: string; token: Address; spender: Address; amount: string; tx: { to: Address; data: Hex; value: string } }[];
  deadline: string;
  quote: { amountIn: string; amountOut: string; minAmountOut: string; priceImpactBps: number | null; fee: { feeBps: number; feeAmount: string }; pool: { venue: string } };
  simulation: { ok: boolean; error?: string; received: string; feePaid: string } | null;
  warnings: string[];
}

/** Refuse anything that doesn't look like what llms.txt describes, before signing. */
function vet(b: Built, side: 'buy' | 'sell', token: Address, amountIn: bigint) {
  const problems: string[] = [];
  if (b.tx.chainId !== 4663) problems.push(`chainId ${b.tx.chainId}`);
  if (!UNIVERSAL_ROUTERS.has(b.tx.to.toLowerCase())) problems.push(`unexpected tx.to ${b.tx.to}`);
  if (side === 'buy' && BigInt(b.tx.value) !== amountIn) problems.push(`tx.value ${b.tx.value} != amountIn ${amountIn}`);
  if (side === 'sell' && BigInt(b.tx.value) !== 0n) problems.push(`sell with value ${b.tx.value}`);
  if (BigInt(b.quote.amountIn) !== amountIn) problems.push('quote.amountIn differs from what we asked');
  if (b.quote.fee.feeBps > 25) problems.push(`fee ${b.quote.fee.feeBps} bps (beta is 25)`);
  if (side === 'buy' && b.approvals.length) problems.push('ETH buy asked for approvals');
  for (const a of b.approvals) {
    const to = a.tx.to.toLowerCase();
    const sel = a.tx.data.slice(0, 10).toLowerCase();
    const okErc20 = a.kind === 'erc20' && to === token.toLowerCase() && sel === SELECTOR_ERC20_APPROVE;
    const okPermit2 = a.kind === 'permit2' && to === PERMIT2 && sel === SELECTOR_PERMIT2_APPROVE;
    if (!okErc20 && !okPermit2) problems.push(`unexpected approval ${a.kind} to ${a.tx.to} (${sel})`);
    if (BigInt(a.tx.value) !== 0n) problems.push('approval with value');
  }
  if (!b.simulation?.ok) problems.push(`simulation failed: ${b.simulation?.error ?? 'missing'}`);
  if (problems.length) throw new Error(`refusing to sign: ${problems.join('; ')}`);
}

async function run(dryRun: boolean) {
  const w = loadWallet();
  if (!w?.apiKey) throw new Error('Run init first.');
  const key = w.apiKey;
  const account = privateKeyToAccount(w.privateKey);
  const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
  const wallet = createWalletClient({ chain: robinhood, transport: http(RPC), account });

  const past = journalEntries().filter((e) => e.kind === 'trade' && e.status === 'success');
  let trades = past.length;
  const tokensDone = new Set(past.map((e) => String(e.token).toLowerCase()));
  let spent = past.filter((e) => e.side === 'buy').reduce((s, e) => s + BigInt(e.amountIn), 0n);
  let errors = 0;
  log(`@${w.handle} ${account.address}  trades so far ${trades}, tokens ${tokensDone.size}, ETH spent on buys ${formatEther(spent)}${dryRun ? '  [DRY RUN: nothing is sent]' : ''}`);

  const send = async (label: string, tx: { to: Address; data: Hex; value: string }) => {
    if (dryRun) {
      log(`  dry run: would send ${label} to ${tx.to}`);
      return null;
    }
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
    log(`  sent ${label}: ${hash}`);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    return hash;
  };

  const trade = async (side: 'buy' | 'sell', token: Token, amountIn: bigint) => {
    const body = { token: token.address, side, amountIn: amountIn.toString(), quoteAsset: 'ETH', slippageBps: LIMITS.slippageBps, from: account.address };
    const q = await api<{ quote: Built['quote']; wouldBuild: boolean; warnings: string[] }>('POST', '/v1/trade/quote', { key, body });
    if (side === 'buy' && !q.wouldBuild) throw new Error(`quote says wouldBuild=false (${q.warnings.join('; ')})`);
    if (side === 'buy' && (q.quote.priceImpactBps ?? 10_000) > LIMITS.maxImpactBps) throw new Error(`price impact ${q.quote.priceImpactBps} bps`);
    // Build right before signing: the tx expires 300 s after the build.
    const b = await api<Built>('POST', '/v1/trade/build', { key, body: { ...body, simulate: true } });
    vet(b, side, token.address, amountIn);
    log(`  ${side} ${token.symbol}: in ${side === 'buy' ? `${formatEther(amountIn)} ETH` : amountIn.toString()} → expected ${b.quote.amountOut} (min ${b.quote.minAmountOut}), fee ${b.quote.fee.feeAmount} (${b.quote.fee.feeBps} bps), impact ${b.quote.priceImpactBps} bps, venue ${b.quote.pool.venue}, sim ok`);
    if (Date.now() / 1000 > Number(b.deadline) - 30) throw new Error('build too close to its deadline');
    const hashes: string[] = [];
    for (const [i, a] of b.approvals.entries()) {
      const h = await send(`approval ${i + 1}/${b.approvals.length} (${a.kind})`, a.tx);
      if (h) hashes.push(h);
    }
    const hash = await send(`${side} tx`, b.tx);
    if (!dryRun) journal({ kind: 'trade', status: 'success', side, token: token.address, symbol: token.symbol, amountIn: amountIn.toString(), expectedOut: b.quote.amountOut, fee: b.quote.fee.feeAmount, hash, approvalHashes: hashes });
    return { hash, built: b };
  };

  while (trades < LIMITS.targetTrades || tokensDone.size < LIMITS.minTokens) {
    if (errors >= LIMITS.maxErrorStreak) throw new Error(`stopping after ${errors} errors in a row`);
    const candidates = await pickCandidates(tokensDone);
    if (!candidates.length) throw new Error('no candidate tokens left');
    let token: Token | null = null;
    let safety: Safety | null = null;
    for (const t of candidates.slice(0, 15)) {
      const s = await safeToBuy(t.address);
      if (s.ok) {
        token = t;
        safety = s.safety;
        break;
      }
      log(`skip ${t.symbol} ${t.address}: ${s.why}`);
    }
    if (!token || !safety) throw new Error('no safe candidate among the top 15 migrated tokens');

    try {
      // Size: about LIMITS.buyUsd, priced with the token's own USD price and a small probe quote.
      const probeIn = parseEther('0.001');
      const probe = await api<{ quote: Built['quote'] }>('POST', '/v1/trade/quote', { key, body: { token: token.address, side: 'buy', amountIn: probeIn.toString() } });
      const detail = await api<{ decimals?: number; price_usd?: number | null }>('GET', `/tokens/${token.address}`);
      const decimals = detail.decimals ?? 18;
      const probeUsd = Number(formatUnits(BigInt(probe.quote.amountOut), decimals)) * (detail.price_usd ?? token.price_usd ?? 0);
      if (!(probeUsd > 0)) throw new Error('could not price the token');
      const ethUsd = probeUsd / 0.001;
      let buyIn = parseEther((LIMITS.buyUsd / ethUsd).toFixed(18));
      if (buyIn > LIMITS.maxEthPerTrade) buyIn = LIMITS.maxEthPerTrade;
      if (spent + buyIn > LIMITS.maxEthTotal) throw new Error(`total spend cap reached (${formatEther(spent)} of ${formatEther(LIMITS.maxEthTotal)} ETH)`);
      if (!dryRun) {
        const bal = await pub.getBalance({ address: account.address });
        if (bal < buyIn + LIMITS.gasReserve) throw new Error(`balance ${formatEther(bal)} ETH is below buy ${formatEther(buyIn)} + gas reserve`);
      }
      const usd = Number(formatEther(buyIn)) * ethUsd;
      if (usd < 5) log(`  warning: this buy is about $${usd.toFixed(2)}; trades under $5 don't count for the leaderboard`);

      log(`BUY ${token.symbol} ${token.address}: ${formatEther(buyIn)} ETH (~$${usd.toFixed(2)}), risk ${safety.riskLevel}, ${token.holders} holders, $${Math.round(token.volume_24h_usd ?? 0)} 24h volume`);
      const buy = await trade('buy', token, buyIn);
      spent += buyIn;
      if (!dryRun) trades++;

      // A short callout with the reasoning. No links (beta rule). The buy above is linked as the entry.
      const why = `$${token.symbol}: graduated, ${safety.riskLevel} risk on Rushr's checks, ${token.holders} holders, $${Math.round(token.volume_24h_usd ?? 0).toLocaleString('en-US')} 24h volume, ${buy.built.quote.priceImpactBps ?? '?'} bps impact. Small test position, selling back soon. Not advice.`;
      if (!dryRun) {
        const c = await api<{ callout: { id: string } }>('POST', '/v1/callouts', { key, body: { token: token.address, stance: 'bullish', body: why } }).catch((e) => {
          log(`  callout failed: ${e instanceof Error ? e.message : e}`);
          return null;
        });
        if (c) {
          log(`  callout ${c.callout.id}: ${why}`);
          journal({ kind: 'callout', id: c.callout.id, token: token.address, body: why });
        }
      } else log(`  dry run: would post callout: ${why}`);

      if (dryRun) {
        log('  dry run: skipping the sell (nothing was bought)');
        tokensDone.add(token.address.toLowerCase());
        trades += 2;
        errors = 0;
        continue;
      }

      log(`  holding ${LIMITS.holdSeconds}s`);
      await sleep(LIMITS.holdSeconds * 1000);
      const held = await pub.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
      if (held === 0n) throw new Error('bought but hold 0 tokens');
      log(`SELL ${token.symbol}: all ${held} base units`);
      // Sells are never blocked; retry once so a transient error doesn't leave the position open.
      const t = token;
      await trade('sell', t, held).catch(async (e) => {
        log(`  sell failed (${e instanceof Error ? e.message : e}), retrying in 30s`);
        await sleep(30_000);
        const again = await pub.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
        if (again === 0n) return;
        return trade('sell', t, again);
      });
      trades++;
      tokensDone.add(token.address.toLowerCase());
      errors = 0;
    } catch (e) {
      errors++;
      tokensDone.add(token.address.toLowerCase()); // don't retry the same token
      log(`error (${errors}/${LIMITS.maxErrorStreak}) on ${token.symbol}: ${e instanceof Error ? e.message : e}`);
      journal({ kind: 'error', token: token.address, message: e instanceof Error ? e.message : String(e) });
      if (e instanceof ApiError && e.code === 'insufficient_funds') throw e;
    }
  }
  log(`done: ${trades} trades over ${tokensDone.size} tokens. Check: node --experimental-strip-types talos.ts status`);
}

// ---------------------------------------------------------------------------------------------
// scan: read-only, no key. Which tokens would `run` consider, and why it skips the others.

async function scan() {
  const candidates = await pickCandidates(new Set());
  console.log(`${candidates.length} migrated tokens pass the list filters (holders >= ${LIMITS.minHolders}, 24h volume >= $${LIMITS.minVolume24hUsd}, list risk not high)`);
  let ok = 0;
  for (const t of candidates.slice(0, 15)) {
    const s = await safeToBuy(t.address);
    if (s.ok) ok++;
    console.log(`  ${s.ok ? 'BUYABLE' : 'skip   '} ${t.symbol.padEnd(10)} ${t.address} risk=${s.safety.riskLevel}${s.safety.stale ? ' (stale)' : ''} holders=${t.holders} vol24h=$${Math.round(t.volume_24h_usd ?? 0)}${s.why ? `  ${s.why}` : ''}`);
  }
  console.log(`${ok} buyable among the top 15. run needs ${LIMITS.minTokens} distinct tokens.`);
}

// ---------------------------------------------------------------------------------------------
// status

async function status() {
  const w = loadWallet();
  if (!w) return console.log(`No wallet yet (${WALLET_FILE}). Run init.`);
  const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
  const bal = await pub.getBalance({ address: w.address }).catch(() => null);
  console.log(`Wallet ${w.address}  balance ${bal === null ? '?' : `${formatEther(bal)} ETH`}`);
  if (!w.apiKey) return console.log('Not registered yet. Run init.');
  const me = await api<{ member: Record<string, unknown>; keys: unknown[] }>('GET', '/v1/agents/me', { key: w.apiKey });
  const m = me.member as { handle: string; kind: string; displayName?: string; bio?: string; followers?: number };
  console.log(`@${m.handle} (${m.kind}) ${m.displayName ?? ''}: ${m.bio ?? ''}  followers ${m.followers ?? 0}, active keys ${me.keys.length}`);
  const local = journalEntries();
  const ok = local.filter((e) => e.kind === 'trade' && e.status === 'success');
  console.log(`Trades logged locally: ${ok.length} over ${new Set(ok.map((e) => e.token)).size} tokens, ${local.filter((e) => e.kind === 'callout').length} callouts, ${local.filter((e) => e.kind === 'error').length} errors`);
  for (const e of ok) console.log(`  ${e.at} ${e.side} ${e.symbol} ${e.hash}`);
  const profile = await api<{ member: { callouts?: number } }>('GET', `/v1/members/${m.handle}`);
  console.log(`Callouts on profile: ${profile.member.callouts ?? '?'}`);
  const rank = await api<Record<string, unknown>>('GET', `/v1/members/${m.handle}/rank`).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  console.log(`Leaderboard (season): ${JSON.stringify(rank)}`);
}

// ---------------------------------------------------------------------------------------------

const [cmd, ...flags] = process.argv.slice(2);
const main =
  cmd === 'init' ? init() : cmd === 'scan' ? scan() : cmd === 'run' ? run(flags.includes('--dry-run')) : cmd === 'status' ? status() : Promise.reject(new Error('usage: talos.ts init | scan | run [--dry-run] | status'));
main.catch((e) => {
  // Never echo request bodies or the wallet file: only the error message.
  console.error(`talos: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
