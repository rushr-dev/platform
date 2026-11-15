// Talos: Rushr's own test trading agent. A small, conservative, fully independent agent built ONLY
// from https://rushr.trade/llms.txt, to prove an outside agent can register, post calls, trade and be
// ranked on the leaderboard.
//
//   node --experimental-strip-types talos.ts init     # new wallet + SIWE registration (no transaction)
//   node --experimental-strip-types talos.ts run      # SIGNS AND SENDS real transactions from the wallet
//   node --experimental-strip-types talos.ts run --dry-run   # everything up to simulation, sends nothing
//   node --experimental-strip-types talos.ts buy-hold <token> --usd <n> [--dry-run]   # one kept buy (max $35), disclosed callout
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
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatEther, http, parseEther, type Address, type Hex } from 'viem';
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
  gasReserve: parseEther(String(num('TALOS_GAS_RESERVE_ETH', 0.001))),
  /** Stop after this many trades (each round trip is 2) and at least this many distinct tokens. */
  targetTrades: num('TALOS_TARGET_TRADES', 6),
  minTokens: 3,
  /** Stop after this many failures in a row. */
  maxErrorStreak: 3,
  /**
   * Price impact caps for buys. The API's `priceImpactBps` includes any fixed tax a token's pool hook
   * takes (PONS-hooked pools charge 1-4%), which doesn't grow with size. So Talos measures that floor
   * with a tiny probe quote and caps two things:
   * - the part caused by the trade's size (full quote minus the floor) at `maxSizeImpactBps`;
   * - the total, floor included, at `maxImpactBps`.
   */
  maxSizeImpactBps: 300,
  maxImpactBps: 500,
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

type Impact = { totalBps: number; floorBps: number; sizeBps: number };

/** A buy refused on price impact. `run` skips the token without counting it as an error. */
class ImpactError extends Error {}

/**
 * Splits a buy's quoted impact into the fixed floor (pool hook tax, measured by quoting 1/20 of the
 * size) and the part caused by the size, then enforces both caps. Throws ImpactError on a refusal.
 * Only quotes: nothing is built or signed here.
 */
async function measureImpact(key: string, body: Record<string, unknown>, quotedBps: number | null, maxTotalBps: number): Promise<Impact> {
  if (quotedBps == null) throw new ImpactError('quote has no price impact; refusing to guess');
  const probeIn = BigInt(String(body.amountIn)) / 20n || 1n;
  const probe = await api<{ quote: Built['quote'] }>('POST', '/v1/trade/quote', { key, body: { ...body, amountIn: probeIn.toString() } });
  // A probe can't sensibly show more impact than the full size; if it does, treat it all as size impact.
  const floorBps = Math.max(0, Math.min(probe.quote.priceImpactBps ?? 0, quotedBps));
  const sizeBps = quotedBps - floorBps;
  const what = `impact ${quotedBps} bps (floor ${floorBps} from the pool's fixed tax, ${sizeBps} from size)`;
  if (sizeBps > LIMITS.maxSizeImpactBps) throw new ImpactError(`${what}: size impact over ${LIMITS.maxSizeImpactBps} bps`);
  if (quotedBps > maxTotalBps) throw new ImpactError(`${what}: total over ${maxTotalBps} bps`);
  return { totalBps: quotedBps, floorBps, sizeBps };
}

/** The signing side: one wallet, one API key. `dryRun` quotes, builds and simulates but never sends. */
function trader(dryRun: boolean) {
  const w = loadWallet();
  if (!w?.apiKey) throw new Error('Run init first.');
  const key = w.apiKey;
  const account = privateKeyToAccount(w.privateKey);
  const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
  const wallet = createWalletClient({ chain: robinhood, transport: http(RPC), account });

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

  /** quote → build (simulate: true) → vet → approvals → tx. Throws before signing if anything looks off. */
  const trade = async (side: 'buy' | 'sell', token: Token, amountIn: bigint, opts: { mode?: 'round_trip' | 'hold'; maxImpactBps?: number; journalExtra?: Record<string, unknown> } = {}) => {
    const mode = opts.mode ?? 'round_trip';
    const maxImpact = opts.maxImpactBps ?? LIMITS.maxImpactBps;
    const body = { token: token.address, side, amountIn: amountIn.toString(), quoteAsset: 'ETH', slippageBps: LIMITS.slippageBps, from: account.address };
    const q = await api<{ quote: Built['quote']; wouldBuild: boolean; warnings: string[] }>('POST', '/v1/trade/quote', { key, body });
    let impact: Impact | null = null;
    if (side === 'buy') {
      if (!q.wouldBuild) throw new Error(`quote says wouldBuild=false (${q.warnings.join('; ')})`);
      impact = await measureImpact(key, body, q.quote.priceImpactBps, maxImpact);
    }
    // Build right before signing: the tx expires 300 s after the build.
    const b = await api<Built>('POST', '/v1/trade/build', { key, body: { ...body, simulate: true } });
    vet(b, side, token.address, amountIn);
    log(`  ${side} ${token.symbol}: in ${side === 'buy' ? `${formatEther(amountIn)} ETH` : amountIn.toString()} → expected ${b.quote.amountOut} (min ${b.quote.minAmountOut}), fee ${b.quote.fee.feeAmount} (${b.quote.fee.feeBps} bps), impact ${b.quote.priceImpactBps} bps${impact ? ` (floor ${impact.floorBps} + size ${impact.sizeBps})` : ''}, venue ${b.quote.pool.venue}, sim ok`);
    if (Date.now() / 1000 > Number(b.deadline) - 30) throw new Error('build too close to its deadline');
    const hashes: string[] = [];
    for (const [i, a] of b.approvals.entries()) {
      const h = await send(`approval ${i + 1}/${b.approvals.length} (${a.kind})`, a.tx);
      if (h) hashes.push(h);
    }
    const hash = await send(`${side} tx`, b.tx);
    if (!dryRun) journal({ kind: 'trade', status: 'success', mode, ...opts.journalExtra, side, token: token.address, symbol: token.symbol, amountIn: amountIn.toString(), expectedOut: b.quote.amountOut, fee: b.quote.fee.feeAmount, hash, approvalHashes: hashes });
    return { hash, built: b, impact };
  };

  const callout = async (token: Address, body: string) => {
    if (dryRun) return log(`  dry run: would post callout (${body.length} chars): ${body}`);
    const c = await api<{ callout: { id: string } }>('POST', '/v1/callouts', { key, body: { token, stance: 'bullish', body } }).catch((e) => {
      log(`  callout failed: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (c) {
      log(`  callout ${c.callout.id}: ${body}`);
      journal({ kind: 'callout', id: c.callout.id, token, body });
    }
  };

  /** ETH the wallet can put into a buy: its balance minus the gas reserve (never negative). */
  const spendable = async () => {
    const bal = await pub.getBalance({ address: account.address });
    return { bal, free: bal > LIMITS.gasReserve ? bal - LIMITS.gasReserve : 0n };
  };

  return { w, key, account, pub, send, trade, callout, spendable };
}

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
let ethUsdCache: { at: number; usd: number } | null = null;

/**
 * USD per ETH from two independent sources, or a refusal. Primary: Rushr's `GET /transparency`
 * (`treasury.ethUsd`). Cross-check: DexScreener's deepest WETH/USDG pair on Robinhood Chain. They must
 * agree within 10% and sit in a sane band ($500-20,000). Cached for 5 minutes.
 * (An earlier version divided an ETH quote by a USDG quote of the same token; a thin USDG route made
 * that about 2x too high, which would have undersized every buy.)
 */
async function ethUsdPrice(): Promise<number> {
  if (ethUsdCache && Date.now() - ethUsdCache.at < 5 * 60_000) return ethUsdCache.usd;
  const rushr = await api<{ treasury?: { ethUsd?: number } }>('GET', '/transparency').then((j) => j.treasury?.ethUsd ?? null).catch(() => null);
  const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`)
    .then((r) => r.json() as Promise<{ pairs?: { chainId: string; baseToken: { address: string }; quoteToken: { address: string }; priceUsd?: string; liquidity?: { usd?: number } }[] }>)
    .then((j) => {
      const pairs = (j.pairs ?? []).filter((p) => p.chainId === 'robinhood' && p.baseToken.address.toLowerCase() === WETH && p.quoteToken.address.toLowerCase() === USDG && Number(p.priceUsd) > 0);
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return pairs[0] ? Number(pairs[0].priceUsd) : null;
    })
    .catch(() => null);
  if (rushr === null || dex === null) throw new Error(`can't price ETH: /transparency ${rushr ?? 'unavailable'}, DexScreener ${dex ?? 'unavailable'}; refusing to size a trade`);
  if (Math.abs(rushr - dex) / dex > 0.1) throw new Error(`ETH/USD sources disagree: Rushr $${rushr.toFixed(2)} vs DexScreener $${dex.toFixed(2)} (over 10%); refusing to size a trade`);
  if (!(rushr > 500 && rushr < 20_000)) throw new Error(`ETH/USD ${rushr} is outside $500-20,000; refusing to size a trade`);
  ethUsdCache = { at: Date.now(), usd: rushr };
  log(`ETH/USD $${rushr.toFixed(2)} (Rushr), DexScreener $${dex.toFixed(2)}`);
  return rushr;
}

const usdToWei = (usd: number, ethUsd: number) => parseEther((usd / ethUsd).toFixed(18));

// ---------------------------------------------------------------------------------------------
// run: the autonomous loop. Other tokens only, buy then sell back, hard caps.

async function run(dryRun: boolean) {
  const t = trader(dryRun);
  // Holds (buy-hold) are separate: they don't count toward this loop's trade target, tokens or spend cap.
  const past = journalEntries().filter((e) => e.kind === 'trade' && e.status === 'success' && e.mode !== 'hold');
  let trades = past.length;
  const tokensDone = new Set(past.map((e) => String(e.token).toLowerCase()));
  /** Tokens tried and given up on this run (errors, impact refusals). Not counted as traded. */
  const tokensSkipped = new Set<string>();
  let spent = past.filter((e) => e.side === 'buy').reduce((s, e) => s + BigInt(e.amountIn), 0n);
  let errors = 0;
  const start = await t.spendable();
  log(`@${t.w.handle} ${t.account.address}  balance ${formatEther(start.bal)} ETH (${formatEther(start.free)} spendable after the ${formatEther(LIMITS.gasReserve)} ETH gas reserve), round-trip trades so far ${trades}, tokens ${tokensDone.size}, ETH into buys ${formatEther(spent)}${dryRun ? '  [DRY RUN: nothing is sent]' : ''}`);

  while (trades < LIMITS.targetTrades || tokensDone.size < LIMITS.minTokens) {
    if (errors >= LIMITS.maxErrorStreak) throw new Error(`stopping after ${errors} errors in a row`);
    const candidates = await pickCandidates(new Set([...tokensDone, ...tokensSkipped]));
    if (!candidates.length) throw new Error('no candidate tokens left');
    let token: Token | null = null;
    let safety: Safety | null = null;
    for (const c of candidates.slice(0, 15)) {
      const s = await safeToBuy(c.address);
      if (s.ok) {
        token = c;
        safety = s.safety;
        break;
      }
      log(`skip ${c.symbol} ${c.address}: ${s.why}`);
    }
    if (!token || !safety) throw new Error('no safe candidate among the top 15 migrated tokens');

    try {
      // Size: about LIMITS.buyUsd, never above the per-trade cap, the total cap, or what the wallet can
      // spend after the gas reserve (read fresh every time, so a hold elsewhere is accounted for).
      const ethUsd = await ethUsdPrice();
      let buyIn = usdToWei(LIMITS.buyUsd, ethUsd);
      if (buyIn > LIMITS.maxEthPerTrade) buyIn = LIMITS.maxEthPerTrade;
      if (spent + buyIn > LIMITS.maxEthTotal) {
        log(`total spend cap reached (${formatEther(spent)} of ${formatEther(LIMITS.maxEthTotal)} ETH into buys); stopping`);
        break;
      }
      const { free } = await t.spendable();
      if (buyIn > free) buyIn = free;
      const usd = Number(formatEther(buyIn)) * ethUsd;
      if (usd < 5) {
        log(`only ${formatEther(free)} ETH spendable after the gas reserve (~$${usd.toFixed(2)}); trades under $5 don't count, so stopping. Top the wallet up to continue.`);
        break;
      }

      log(`BUY ${token.symbol} ${token.address}: ${formatEther(buyIn)} ETH (~$${usd.toFixed(2)} at $${ethUsd.toFixed(0)}/ETH), risk ${safety.riskLevel}, ${token.holders} holders, $${Math.round(token.volume_24h_usd ?? 0)} 24h volume`);
      const buy = await t.trade('buy', token, buyIn);
      spent += buyIn;
      if (!dryRun) trades++;

      // A short callout with the reasoning. No links (beta rule). The buy above is linked as the entry.
      await t.callout(
        token.address,
        `$${token.symbol}: graduated, ${safety.riskLevel} risk on Rushr's checks, ${token.holders} holders, $${Math.round(token.volume_24h_usd ?? 0).toLocaleString('en-US')} 24h volume, ${buy.impact ? `${buy.impact.sizeBps} bps size impact` : `${buy.built.quote.priceImpactBps ?? '?'} bps impact`}. Small test position, selling back soon. Not advice.`,
      );

      if (dryRun) {
        log('  dry run: skipping the sell (nothing was bought)');
        tokensDone.add(token.address.toLowerCase());
        trades += 2;
        errors = 0;
        continue;
      }

      log(`  holding ${LIMITS.holdSeconds}s`);
      await sleep(LIMITS.holdSeconds * 1000);
      const tok = token;
      const balanceOf = () => t.pub.readContract({ address: tok.address, abi: erc20Abi, functionName: 'balanceOf', args: [t.account.address] });
      const held = await balanceOf();
      if (held === 0n) throw new Error('bought but hold 0 tokens');
      log(`SELL ${tok.symbol}: all ${held} base units`);
      // Sells are never blocked; retry once so a transient error doesn't leave the position open.
      await t.trade('sell', tok, held).catch(async (e) => {
        log(`  sell failed (${e instanceof Error ? e.message : e}), retrying in 30s`);
        await sleep(30_000);
        const again = await balanceOf();
        if (again === 0n) return;
        return t.trade('sell', tok, again);
      });
      trades++;
      tokensDone.add(tok.address.toLowerCase());
      errors = 0;
    } catch (e) {
      tokensSkipped.add(token.address.toLowerCase()); // don't retry the same token this run
      if (e instanceof ImpactError) {
        // Too costly to enter, not a failure: move on to the next token.
        log(`skip ${token.symbol}: ${e.message}`);
        continue;
      }
      errors++;
      log(`error (${errors}/${LIMITS.maxErrorStreak}) on ${token.symbol}: ${e instanceof Error ? e.message : e}`);
      journal({ kind: 'error', token: token.address, message: e instanceof Error ? e.message : String(e) });
      if (e instanceof ApiError && e.code === 'insufficient_funds') throw e;
    }
  }
  log(`done: ${trades} round-trip trades over ${tokensDone.size} tokens. Check: node --experimental-strip-types talos.ts status`);
}

// ---------------------------------------------------------------------------------------------
// buy-hold: one explicit, operator-started buy that is kept (no sell), with a disclosed callout.
// The only way Talos ever buys a token on the EXCLUDE list (such as $RUSHR); `run` never does.

/** Refuse holds above this, whatever --usd says. */
const HOLD_MAX_USD = 35;
/** And never more than this much ETH, so a bad ETH/USD estimate can't oversize the buy. */
const HOLD_MAX_ETH = parseEther(String(num('TALOS_HOLD_MAX_ETH', 0.02)));

function disclosureCallout(symbol: string): string {
  if (symbol.toUpperCase() === 'RUSHR') {
    return "Bullish $RUSHR. Disclosure: I'm Talos, the Rushr team's own agent, and I'm holding this bag. Humans and agents on one feed, one leaderboard, built in the open. Not advice.";
  }
  return `Bullish $${symbol}. Disclosure: I'm Talos, the Rushr team's own agent, and I'm holding this bag. Not advice.`;
}

/** Flag value after `name`, or undefined. */
const flagValue = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
/** Holds may set the total impact cap explicitly (default LIMITS.maxImpactBps), never past this. */
const HOLD_MAX_IMPACT_BPS = 500;
const MAX_CHUNKS = 10;
/** Seconds between chunks (at least 60). */
const CHUNK_GAP_SECONDS = Math.max(60, num('TALOS_CHUNK_GAP_SECONDS', 60));

async function buyHold(args: string[], dryRun: boolean) {
  const usage = 'usage: talos.ts buy-hold <token address> --usd <n> [--chunks <n>] [--max-impact <bps>] [--dry-run] [--again]';
  const address = (args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? '').toLowerCase() as Address;
  if (!address) throw new Error(usage);
  const usdTarget = Number(flagValue(args, '--usd'));
  if (!(usdTarget > 0)) throw new Error('--usd must be a positive number');
  if (usdTarget > HOLD_MAX_USD) throw new Error(`refusing: --usd ${usdTarget} is above the $${HOLD_MAX_USD} cap for holds`);
  const chunks = args.includes('--chunks') ? Number(flagValue(args, '--chunks')) : 1;
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) throw new Error(`--chunks must be a whole number from 1 to ${MAX_CHUNKS}`);
  const maxImpactBps = args.includes('--max-impact') ? Number(flagValue(args, '--max-impact')) : LIMITS.maxImpactBps;
  if (!Number.isInteger(maxImpactBps) || maxImpactBps < 1 || maxImpactBps > HOLD_MAX_IMPACT_BPS) throw new Error(`--max-impact must be a whole number of bps from 1 to ${HOLD_MAX_IMPACT_BPS}`);
  const chunkUsd = usdTarget / chunks;
  if (chunkUsd < 5) log(`warning: each chunk is $${chunkUsd.toFixed(2)}, under $5, so these trades won't count for the leaderboard`);

  const t = trader(dryRun);
  const previous = journalEntries().filter((e) => e.kind === 'trade' && e.status === 'success' && e.mode === 'hold' && String(e.token).toLowerCase() === address);
  if (previous.length && !args.includes('--again')) throw new Error(`already holding from an earlier buy-hold (${previous.length} buys, last ${previous.at(-1)!.hash}); pass --again to buy more`);

  // Same token checks as run, except the EXCLUDE list (this command is the explicit override for it).
  const detail = await api<Token & { decimals?: number; status?: string }>('GET', `/tokens/${address}`);
  if (detail.status && detail.status !== 'migrated') throw new Error(`refusing: ${detail.symbol} is not graduated (status ${detail.status})`);
  const token: Token = { address, symbol: detail.symbol, holders: detail.holders, volume_24h_usd: detail.volume_24h_usd, liquidity_usd: detail.liquidity_usd, price_usd: detail.price_usd, risk: detail.risk };
  const s = await safeToBuy(address);
  if (!s.ok) throw new Error(`refusing: ${token.symbol} fails the safety check (${s.why})`);

  // Caps on the WHOLE hold (all chunks together), checked before the first buy.
  const ethUsd = await ethUsdPrice();
  const chunkWei = usdToWei(chunkUsd, ethUsd);
  const totalWei = chunkWei * BigInt(chunks);
  const totalUsd = Number(formatEther(totalWei)) * ethUsd;
  if (totalWei > HOLD_MAX_ETH) throw new Error(`refusing: $${usdTarget} is ${formatEther(totalWei)} ETH at $${ethUsd.toFixed(0)}/ETH, above the ${formatEther(HOLD_MAX_ETH)} ETH hold cap`);
  if (totalUsd > HOLD_MAX_USD) throw new Error(`refusing: ~$${totalUsd.toFixed(2)} is above the $${HOLD_MAX_USD} cap`);
  const start = await t.spendable();
  if (totalWei > start.free) throw new Error(`refusing: needs ${formatEther(totalWei)} ETH but only ${formatEther(start.free)} ETH is spendable (balance ${formatEther(start.bal)}, gas reserve ${formatEther(LIMITS.gasReserve)})`);

  log(
    `BUY-HOLD ${token.symbol} ${address}: ~$${totalUsd.toFixed(2)} = ${formatEther(totalWei)} ETH at $${ethUsd.toFixed(2)}/ETH, in ${chunks} chunk${chunks > 1 ? 's' : ''} of ${formatEther(chunkWei)} ETH (~$${chunkUsd.toFixed(2)})` +
      `${chunks > 1 ? ` ${CHUNK_GAP_SECONDS}s apart` : ''}, impact caps per chunk: size ${LIMITS.maxSizeImpactBps} bps, total ${maxImpactBps} bps (floor included), risk ${s.safety.riskLevel}, balance ${formatEther(start.bal)} ETH${dryRun ? '  [DRY RUN: nothing is sent]' : ''}`,
  );

  let filled = 0;
  for (let i = 0; i < chunks; i++) {
    if (i > 0) {
      if (dryRun) {
        log(`  dry run: chunks ${i + 1}-${chunks} would each be re-quoted, re-checked (size impact <= ${LIMITS.maxSizeImpactBps} bps, total <= ${maxImpactBps} bps, balance) and simulated ${CHUNK_GAP_SECONDS}s apart; only the first is simulated now`);
        break;
      }
      log(`  waiting ${CHUNK_GAP_SECONDS}s before chunk ${i + 1}/${chunks}`);
      await sleep(CHUNK_GAP_SECONDS * 1000);
      const { free } = await t.spendable();
      if (chunkWei > free) {
        log(`stopping: chunk ${i + 1} needs ${formatEther(chunkWei)} ETH, only ${formatEther(free)} spendable after the gas reserve`);
        break;
      }
    }
    log(`  chunk ${i + 1}/${chunks}`);
    try {
      await t.trade('buy', token, chunkWei, { mode: 'hold', maxImpactBps, journalExtra: { chunk: i + 1, chunks } });
    } catch (e) {
      // Each chunk is checked on its own (the price moves after every fill). Stop, keep what filled.
      if (i === 0) throw e;
      log(`stopping after ${filled} of ${chunks} chunks: ${e instanceof Error ? e.message : e}`);
      journal({ kind: 'error', token: address, message: `buy-hold chunk ${i + 1}: ${e instanceof Error ? e.message : String(e)}` });
      break;
    }
    filled++;
    // ONE disclosed callout, right after the first chunk fills (it becomes the callout's entry).
    if (i === 0) await t.callout(address, disclosureCallout(token.symbol));
  }
  if (!dryRun) {
    const after = await t.spendable();
    log(`done: ${filled} of ${chunks} chunks filled (${formatEther(chunkWei * BigInt(filled))} ETH). Holding ${token.symbol}; ${formatEther(after.free)} ETH left for run after the gas reserve.`);
  }
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
const dry = flags.includes('--dry-run');
const main =
  cmd === 'init' ? init()
  : cmd === 'scan' ? scan()
  : cmd === 'run' ? run(dry)
  : cmd === 'buy-hold' ? buyHold(flags, dry)
  : cmd === 'price' ? ethUsdPrice().then((p) => console.log(`ETH/USD $${p.toFixed(2)}; $${LIMITS.buyUsd} = ${formatEther(usdToWei(LIMITS.buyUsd, p))} ETH, $30 = ${formatEther(usdToWei(30, p))} ETH`))
  : cmd === 'status' ? status()
  : Promise.reject(new Error('usage: talos.ts init | scan | run [--dry-run] | buy-hold <token> --usd <n> [--chunks <n>] [--max-impact <bps>] [--dry-run] [--again] | price | status'));
main.catch((e) => {
  // Never echo request bodies or the wallet file: only the error message.
  console.error(`talos: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
