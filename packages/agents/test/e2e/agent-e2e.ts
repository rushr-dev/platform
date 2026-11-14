// End-to-end agent journey against a Rushr API, run the way a third-party AI agent would use it.
//
//   AGENT_E2E_BASE_URL=http://localhost:8788 \
//   AGENT_E2E_RPC_URL=<Robinhood Chain RPC, optional: enables eth_simulateV1 checks> \
//   node --experimental-strip-types packages/agents/test/e2e/agent-e2e.ts
//
// What it does, in order: discover (llms.txt), register (SIWE nonce, sign, verify, API key), read the
// market data, social (callout, like, comment, follow, feeds, delete), trade (quote + UNSIGNED build,
// then an eth_simulateV1 dry run with a state-override balance), limits and errors, leaderboard.
//
// Safety:
// - The wallets are throwaway keys generated in memory for this run. They are never funded, never
//   saved, and only sign SIWE messages. Nothing is ever broadcast: trades are simulated only.
// - It only writes to the API you point it at (accounts, callouts, likes, follows). Point it at a
//   LOCAL indexer (wrangler dev + local Postgres). It refuses a non-local base URL unless
//   AGENT_E2E_ALLOW_REMOTE=1, and even then it never signs or sends a transaction.
// - Local runs send a random `cf-connecting-ip` per run so per-IP limits (5 registrations/day) don't
//   carry over between runs. Cloudflare overwrites that header in production.
//
// Optional overrides: AGENT_E2E_GRADUATED (a token trading on Uniswap), AGENT_E2E_CURVE (a PONS token
// still on its curve), AGENT_E2E_HIGH_RISK, AGENT_E2E_BLOCKED, AGENT_E2E_OUT (write results as JSON),
// AGENT_E2E_SKIP_LIMITS=1 (skip the rate-limit floods).
import { encodeFunctionData, formatEther, getAddress, maxUint256, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.AGENT_E2E_BASE_URL ?? 'http://localhost:8788').replace(/\/$/, '');
const RPC = process.env.AGENT_E2E_RPC_URL ?? '';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);
if (!LOCAL && process.env.AGENT_E2E_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to run against ${BASE}: this script creates accounts and posts. Use a local indexer, or set AGENT_E2E_ALLOW_REMOTE=1.`);
  process.exit(2);
}

const TREASURY = '0x447a590b70cd55cc6b62ceaf79d4c6c09a955e40';
const PERMIT2: Address = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const NATIVE_EMITTER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BETA_FEE_BPS = 25n;
const RUN = Date.now().toString(36).slice(-5);
const RUN_IP = `10.${rand(255)}.${rand(255)}.${rand(255)}`;

function rand(n: number) {
  return Math.floor(Math.random() * n);
}
/** A new client IP (local runs only), so one negative test's failed attempts don't rate-limit the next. */
const freshIp = () => `10.${100 + rand(100)}.${rand(255)}.${rand(255)}`;
const ADMIN_TOKEN = process.env.AGENT_E2E_ADMIN_TOKEN;

// ---------------------------------------------------------------------------------------------
// Results

type Status = 'pass' | 'fail' | 'warn' | 'skip';
interface Result {
  step: string;
  name: string;
  status: Status;
  detail?: string;
}
const results: Result[] = [];
let step = '0 setup';

function record(status: Status, name: string, detail?: string) {
  results.push({ step, name, status, detail });
  const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }[status];
  console.log(`  ${mark}  ${name}${detail ? `  (${detail})` : ''}`);
}
const check = (cond: unknown, name: string, detail?: string, onFail: Status = 'fail') => {
  record(cond ? 'pass' : onFail, name, detail);
  return Boolean(cond);
};
function section(s: string) {
  step = s;
  console.log(`\n== ${s}`);
}

// ---------------------------------------------------------------------------------------------
// HTTP

interface Res<T = any> {
  status: number;
  headers: Headers;
  json: T;
  ms: number;
}

async function api<T = any>(method: string, path: string, opts: { body?: unknown; raw?: string; key?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (LOCAL) headers['cf-connecting-ip'] = opts.ip ?? RUN_IP;
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t0 = performance.now();
  const r = await fetch(BASE + path, { method, headers, body });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _text: text.slice(0, 200) };
  }
  return { status: r.status, headers: r.headers, json, ms: Math.round(performance.now() - t0) };
}

const errCode = (r: Res) => r.json?.error?.code as string | undefined;
const brief = (r: Res) => `${r.status} ${errCode(r) ?? ''} ${r.json?.error?.message ?? ''}`.trim();

/** An error response is "clear" when it has a code, a human message and (for 4xx from /v1) a docs link. */
function errorShapeOk(r: Res) {
  return Boolean(r.json?.error?.code && r.json?.error?.message);
}

// ---------------------------------------------------------------------------------------------
// Agent helpers

interface Agent {
  account: PrivateKeyAccount;
  handle: string;
  key: string;
  keyId: string;
  memberId: string;
}

async function siweMessage(address: string, purpose: 'register' | 'login', ip?: string) {
  return api('GET', `/v1/auth/nonce?address=${address}&purpose=${purpose}`, { ip });
}

async function register(handle: string, opts: { account?: PrivateKeyAccount; ip?: string; bio?: string } = {}): Promise<{ res: Res; agent?: Agent }> {
  const account = opts.account ?? privateKeyToAccount(generatePrivateKey());
  const n = await siweMessage(account.address, 'register', opts.ip);
  if (n.status !== 200) return { res: n };
  const signature = await account.signMessage({ message: n.json.message });
  const res = await api('POST', '/v1/agents/register', { body: { message: n.json.message, signature, handle, bio: opts.bio }, ip: opts.ip });
  if (res.status !== 201) return { res };
  return { res, agent: { account, handle: res.json.member.handle, key: res.json.apiKey.key, keyId: res.json.apiKey.id, memberId: res.json.member.id } };
}

// ---------------------------------------------------------------------------------------------
// Simulation (eth_simulateV1, never broadcast)

interface SimCall {
  from: string;
  to: string;
  data?: string;
  value?: string;
}
interface SimBlock {
  calls: SimCall[];
  stateOverrides?: Record<string, { balance: string }>;
  blockOverrides?: { time?: string };
}
interface SimLog {
  address: string;
  topics: string[];
  data: string;
}
interface SimCallResult {
  status: string;
  gasUsed: string;
  logs: SimLog[];
  error?: { message: string; data?: string };
  returnData?: string;
}

async function simulate(blocks: SimBlock[]): Promise<{ ok: boolean; blocks?: { calls: SimCallResult[] }[]; error?: string }> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: blocks, traceTransfers: true, validation: false }, 'latest'] }),
  });
  const j: any = await r.json();
  if (j.error) return { ok: false, error: `${j.error.code}: ${j.error.message}` };
  return { ok: true, blocks: j.result };
}

const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase();

/** Sum Transfer events of `asset` (a token, or NATIVE_EMITTER for ETH) going to `to`. */
function received(calls: SimCallResult[], asset: string, to: string): bigint {
  let sum = 0n;
  for (const c of calls)
    for (const l of c.logs ?? [])
      if (l.address.toLowerCase() === asset.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && topicAddr(l.topics[2]!) === to.toLowerCase()) sum += BigInt(l.data);
  return sum;
}

function approvalCall(a: { kind: string; token: string; spender: string; amount: string }, from: string): SimCall {
  if (a.kind === 'erc20') {
    return { from, to: a.token, data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: 'approve', args: [a.spender as Address, maxUint256] }) };
  }
  const amt = BigInt(a.amount);
  const max160 = (1n << 160n) - 1n;
  return {
    from,
    to: PERMIT2,
    data: encodeFunctionData({ abi: permit2ApproveAbi, functionName: 'approve', args: [a.token as Address, a.spender as Address, amt > max160 ? max160 : amt, Number((1n << 48n) - 1n)] }),
  };
}

const erc20ApproveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const permit2ApproveAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] },
] as const;

const txCall = (tx: { to: string; data: string; value: string }, from: string): SimCall => ({ from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` });
const fundOverride = (addr: string, eth: string) => ({ [addr]: { balance: `0x${parseEther(eth).toString(16)}` } });
const bps = (part: bigint, whole: bigint) => (whole === 0n ? NaN : Number((part * 1_000_000n) / whole) / 100);

// ---------------------------------------------------------------------------------------------
// The journey

const findings: string[] = [];
const note = (s: string) => {
  findings.push(`[${step}] ${s}`);
  console.log(`  NOTE  ${s}`);
};

async function main() {
  console.log(`Rushr agent e2e: ${BASE}  run=${RUN}  rpc=${RPC ? 'yes (simulations on)' : 'no (simulations skipped)'}`);

  // ---- 1. Discover ----
  section('1 discover');
  const llmsCandidates = ['https://rushr.trade/llms.txt', `${BASE}/llms.txt`, `${BASE}/v1/llms.txt`];
  let llms = '';
  for (const u of llmsCandidates) {
    try {
      const r = await fetch(u);
      const t = await r.text();
      const ok = r.status === 200 && t.startsWith('# Rushr');
      record(ok ? 'pass' : 'fail', `llms.txt served at ${u}`, `${r.status}`);
      if (ok && !llms) llms = t;
    } catch (e) {
      record('fail', `llms.txt served at ${u}`, (e as Error).message);
    }
  }
  const notFound = await api('GET', '/v1/definitely-not-a-route');
  check(notFound.status === 404 && notFound.json?.error?.docs, 'unknown /v1 routes answer JSON with a docs link', notFound.json?.error?.docs ?? `${notFound.status} ${JSON.stringify(notFound.json)}`);

  // ---- 2. Register ----
  section('2 register');
  const handle = `e2e_${RUN}`;
  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = await siweMessage(account.address, 'register');
  check(nonce.status === 200 && nonce.json?.message && nonce.json?.nonce, 'GET /v1/auth/nonce returns a message to sign', brief(nonce));
  const msg: string = nonce.json?.message ?? '';
  check(msg.includes('rushr.trade') && msg.includes('Chain ID: 4663') && msg.includes(getAddress(account.address)), 'nonce message is EIP-4361 for rushr.trade, chain 4663, checksummed address');
  check(nonce.headers.get('cache-control')?.includes('no-store'), 'nonce response is not cacheable');
  const signature = await account.signMessage({ message: msg });
  const reg = await api('POST', '/v1/agents/register', { body: { message: msg, signature, handle, bio: 'Automated e2e test agent. Ignore me.' } });
  if (!check(reg.status === 201 && reg.json?.apiKey?.key?.startsWith('rk_'), 'POST /v1/agents/register issues an rk_ API key', brief(reg))) {
    console.error('Cannot continue without an API key.');
    return;
  }
  const me: Agent = { account, handle, key: reg.json.apiKey.key, keyId: reg.json.apiKey.id, memberId: reg.json.member.id };
  check(reg.json.member.kind === 'agent', 'registered member has kind=agent', reg.json.member.kind);
  check(reg.json.member.handle === handle, 'handle stored as sent');
  check(!JSON.stringify(reg.json.member).includes('privy'), 'public member has no private fields');
  const replay = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: msg, signature, handle: `${handle}x` } });
  check(replay.status === 401 && errCode(replay) === 'nonce_used', 'replaying the same signed message is refused (nonce_used)', brief(replay));

  const meRes = await api('GET', '/v1/agents/me', { key: me.key });
  check(meRes.status === 200 && meRes.json?.keys?.length === 1 && meRes.json?.currentKey === me.keyId, 'GET /v1/agents/me lists the active key', brief(meRes));
  const v1me = await api('GET', '/v1/me', { key: me.key });
  check(v1me.status === 200 && v1me.json?.member?.id === me.memberId, 'GET /v1/me works with an agent key', brief(v1me));

  // Profile (PATCH /v1/me is not in llms.txt; an agent would have to guess it).
  const patch = await api('PATCH', '/v1/me', { key: me.key, body: { displayName: `E2E ${RUN}`, bio: 'Test agent, one line.', avatarUrl: 'https://rushr.trade/logo.png' } });
  check(patch.status === 200 && patch.json?.member?.displayName === `E2E ${RUN}`, 'PATCH /v1/me updates the agent profile', brief(patch));
  const httpAvatar = await api('PATCH', '/v1/me', { key: me.key, body: { avatarUrl: 'http://example.com/a.png' } });
  check(httpAvatar.status === 422, 'non-https avatarUrl is refused', brief(httpAvatar));
  const profile = await api('GET', `/v1/members/${handle}`);
  check(profile.status === 200 && profile.json?.member?.kind === 'agent', 'public profile shows the agent with kind=agent', brief(profile));

  // A second agent to follow, like and comment between members.
  const other = await register(`e2e_${RUN}_b`, { ip: freshIp() });
  check(other.agent, 'second test agent registers', brief(other.res));

  // Owner linking: designed in docs/agents.md, not offered by the API.
  const link = await api('GET', `/v1/auth/nonce?address=${account.address}&purpose=link`);
  check(link.status === 422, 'purpose=link is not available (owner linking not shipped)', brief(link), 'warn');

  // ---- 3. Read ----
  section('3 read');
  const columns: Record<string, any[]> = {};
  let copycats: string[] = [];
  for (const col of ['new', 'almost', 'migrated']) {
    const r = await api('GET', `/tokens?column=${col}`);
    columns[col] = r.json?.tokens ?? [];
    check(r.status === 200 && Array.isArray(r.json?.tokens), `trenches column=${col}`, `${columns[col]!.length} tokens, ${r.ms}ms`);
    if (r.status === 200 && columns[col]!.length === 0) note(`trenches column=${col} is empty`);
  }
  const graduated = (process.env.AGENT_E2E_GRADUATED ?? columns.migrated?.[0]?.address ?? '').toLowerCase();
  const curveToken = (process.env.AGENT_E2E_CURVE ?? columns.new?.find((t) => t.launchpad === 'pons')?.address ?? '').toLowerCase();
  console.log(`  tokens: graduated=${graduated || '-'} curve=${curveToken || '-'}`);

  if (graduated) {
    const t = await api('GET', `/tokens/${graduated}`);
    check(t.status === 200 && (t.json?.address ?? t.json?.token?.address), 'token detail', `${t.ms}ms`);
    for (const sub of ['signals', 'holders', 'trades', 'candles?interval=1m', 'pools', 'stats']) {
      const r = await api('GET', `/tokens/${graduated}/${sub}`);
      check(r.status === 200, `token /${sub}`, `${r.status}, ${r.ms}ms`);
    }
    const safety = await api('GET', `/v1/tokens/${graduated}/safety`);
    check(safety.status === 200 && ['low', 'medium', 'high', 'unknown'].includes(safety.json?.safety?.riskLevel), 'v1 token safety', `${safety.json?.safety?.riskLevel} stale=${safety.json?.safety?.stale}`);
    const sym = t.json?.symbol ?? t.json?.token?.symbol;
    if (sym) {
      const s = await api('GET', `/search?q=${encodeURIComponent(sym)}`);
      const hits: any[] = s.json?.tokens ?? [];
      check(s.status === 200 && hits.some((h) => h.address === graduated), `search by ticker "${sym}" finds the real (migrated) token`, `${hits.length} results, ${hits.filter((h) => h.risk === 'high').length} high-risk, real one ${hits.findIndex((h) => h.address === graduated) < 0 ? 'missing' : `#${hits.findIndex((h) => h.address === graduated) + 1}`}`);
      copycats = hits.filter((h) => h.address !== graduated).map((h) => h.address);
      const byAddr = await api('GET', `/search?q=${graduated}`);
      check(byAddr.json?.tokens?.[0]?.address === graduated, 'search by address finds it');
    }
  } else record('skip', 'token reads', 'no migrated token found');
  const badAddr = await api('GET', '/v1/tokens/0x123/safety');
  check(badAddr.status === 422 && errorShapeOk(badAddr), 'bad token address gives a clear 422', brief(badAddr));
  const feed = await api('GET', '/v1/feed');
  check(feed.status === 200 && Array.isArray(feed.json?.items), 'global feed', `${feed.json?.items?.length} items`);
  for (const w of ['season', '24h', '7d', '30d']) {
    const lb = await api('GET', `/v1/leaderboard?window=${w}&kind=agent`);
    const noSeason = w === 'season' && errCode(lb) === 'no_season';
    check(lb.status === 200, `leaderboard window=${w} kind=agent`, brief(lb), noSeason ? 'warn' : 'fail');
    if (noSeason) note('window=season (the llms.txt example) answers 404 no_season until an admin creates a season');
  }
  const badWindow = await api('GET', '/v1/leaderboard?window=1y');
  check(badWindow.status === 422, 'unknown leaderboard window → 422', brief(badWindow));

  // ---- 4. Social ----
  section('4 social');
  let callout: string | undefined;
  if (graduated) {
    const post = await api('POST', '/v1/callouts', { key: me.key, body: { token: graduated, stance: 'bullish', body: `E2E test callout ${RUN}. Not advice.` } });
    callout = post.json?.callout?.id;
    check(post.status === 201 && callout, 'POST /v1/callouts (bullish)', brief(post));
    check(post.json?.callout?.entry === null, 'callout from a wallet with no buys has entry=null');
    const dup = await api('POST', '/v1/callouts', { key: me.key, body: { token: graduated, stance: 'bullish', body: `E2E test callout ${RUN}. Not advice.` } });
    check(dup.status === 409 && errCode(dup) === 'duplicate', 'duplicate callout is refused', brief(dup));
    const linkPost = await api('POST', '/v1/callouts', { key: me.key, body: { token: graduated, body: 'see https://evil.example' } });
    check(linkPost.status === 422 && errCode(linkPost) === 'links_not_allowed', 'links in callouts are refused', brief(linkPost));
    const unknown = await api('POST', '/v1/callouts', { key: me.key, body: { token: '0x000000000000000000000000000000000000dead', body: `nothing ${RUN}` } });
    check(unknown.status === 404 && errCode(unknown) === 'unknown_token', 'callout on an unindexed token is refused', brief(unknown));
  } else record('skip', 'callouts', 'no token');

  if (callout && other.agent) {
    const like = await api('POST', `/v1/callouts/${callout}/like`, { key: other.agent.key });
    check(like.status === 200 && like.json?.likes === 1, 'another agent likes the callout', brief(like));
    const like2 = await api('POST', `/v1/callouts/${callout}/like`, { key: other.agent.key });
    check(like2.status === 200 && like2.json?.likes === 1, 'liking twice is idempotent');
    const selfLike = await api('POST', `/v1/callouts/${callout}/like`, { key: me.key });
    check(selfLike.status !== 200, 'liking your own callout is refused', `${selfLike.status} likes=${selfLike.json?.likes}`, 'warn');
    const com = await api('POST', `/v1/callouts/${callout}/comments`, { key: other.agent.key, body: { body: `Nice call ${RUN}` } });
    check(com.status === 201 && com.json?.comment?.id, 'comment on the callout', brief(com));
    const comments = await api('GET', `/v1/callouts/${callout}/comments`);
    check(comments.status === 200 && comments.json?.items?.length === 1, 'comments list shows it');
    const follow = await api('POST', `/v1/follows/${other.agent.handle}`, { key: me.key });
    check(follow.status === 200 && follow.json?.following === true, 'follow another member', brief(follow));
    const followSelf = await api('POST', `/v1/follows/${handle}`, { key: me.key });
    check(followSelf.status === 422, "can't follow yourself", brief(followSelf));
    const rel = await api('GET', `/v1/me/relationship/${other.agent.handle}`, { key: me.key });
    check(rel.status === 200 && rel.json?.following === true, 'relationship shows following');
    // The followee posts; the follower's feed should show it.
    const theirs = await api('POST', '/v1/callouts', { key: other.agent.key, body: { token: graduated, stance: 'bearish', body: `Bearish e2e ${RUN}` } });
    const myFeed = await api('GET', '/v1/me/feed', { key: me.key });
    const ids = (myFeed.json?.items ?? []).map((i: any) => i.id);
    check(myFeed.status === 200 && ids.includes(callout) && ids.includes(theirs.json?.callout?.id), '/v1/me/feed has my callout and the followee’s', brief(myFeed));
    const tokenCallouts = await api('GET', `/v1/tokens/${graduated}/callouts`);
    check(tokenCallouts.status === 200 && tokenCallouts.json?.items?.some((i: any) => i.id === callout), 'token callouts list it');
    const del = await api('DELETE', `/v1/callouts/${callout}`, { key: me.key });
    check(del.status === 200, 'delete the test callout', brief(del));
    const gone = await api('GET', `/v1/callouts/${callout}`);
    check(gone.status === 404, 'deleted callout is gone', brief(gone));
    const delOther = await api('DELETE', `/v1/callouts/${theirs.json?.callout?.id}`, { key: me.key });
    check(delOther.status === 404, "can't delete someone else's callout", brief(delOther));
    if (theirs.json?.callout?.id) await api('DELETE', `/v1/callouts/${theirs.json.callout.id}`, { key: other.agent.key });
    const unfollow = await api('DELETE', `/v1/follows/${other.agent.handle}`, { key: me.key });
    check(unfollow.status === 200 && unfollow.json?.following === false, 'unfollow');
  }

  // ---- 5. Trade ----
  section('5 trade');
  const from = me.account.address.toLowerCase();
  const tradeOf = (body: Record<string, unknown>, mode: 'quote' | 'build') => api('POST', `/v1/trade/${mode}`, { key: me.key, body });

  async function tradeCase(label: string, token: string) {
    if (!token) return record('skip', `${label}: trade`, 'no token');
    const buyIn = parseEther('0.001').toString();
    const q = await tradeOf({ token, side: 'buy', amountIn: buyIn }, 'quote');
    if (!check(q.status === 200 && q.json?.quote, `${label}: buy quote`, q.status === 200 ? `${q.json.quote.pool?.venue} out=${q.json.quote.amountOut} fee=${q.json.quote.fee?.feeAmount} (${q.json.quote.fee?.feeBps}bps) ${q.ms}ms` : brief(q))) return;
    const quote = q.json.quote;
    check(quote.fee?.feeBps === Number(BETA_FEE_BPS), `${label}: quoted fee is the 0.25% beta rate`, `${quote.fee?.feeBps} bps`);
    check(BigInt(quote.fee.feeAmount) === (BigInt(buyIn) * BETA_FEE_BPS) / 10_000n, `${label}: buy fee = amountIn × 0.25%`, `${quote.fee.feeAmount}`);
    if (label.startsWith('curve')) check(quote.pool?.venue === 'pons-curve', `${label}: a token still on its curve is quoted on the curve`, `venue=${quote.pool?.venue} pool=${quote.pool?.address ?? quote.pool?.id}`);
    const b = await tradeOf({ token, side: 'buy', amountIn: buyIn, acceptRisk: 'high' }, 'build');
    if (!check(b.status === 200 && b.json?.tx?.data, `${label}: build unsigned buy tx`, b.status === 200 ? `to=${b.json.tx.to} value=${b.json.tx.value} approvals=${b.json.approvals.length} deadline=${b.json.deadline}` : brief(b))) return;
    check(b.json.tx.chainId === 4663 && !('signature' in b.json.tx) && !b.json.tx.r, `${label}: tx is unsigned, chain 4663`);
    // llms.txt: `"simulate": true` has Rushr dry-run it. A new agent's wallet is usually unfunded.
    const bs = await tradeOf({ token, side: 'buy', amountIn: buyIn, acceptRisk: 'high', simulate: true }, 'build');
    const simOut = bs.json?.simulation;
    check(bs.status === 200 && simOut?.ok === true, `${label}: build with simulate=true dry-runs it (wallet unfunded)`, bs.status === 200 ? `ok=${simOut?.ok} error=${simOut?.error ?? '-'} received=${simOut?.received} feePaid=${simOut?.feePaid}` : brief(bs), 'warn');
    if (label === 'graduated') {
      const usdg = await tradeOf({ token, side: 'buy', amountIn: '1000000', quoteAsset: 'USDG' }, 'quote');
      check(usdg.status === 200 || errCode(usdg)?.startsWith('trade_'), `${label}: USDG-quoted buy (1 USDG) quotes or fails with a trade_* code`, usdg.status === 200 ? `${usdg.json.quote.pool?.venue} fee=${usdg.json.quote.fee?.feeAmount}` : brief(usdg));
    }
    if (!RPC) return record('skip', `${label}: simulation`, 'no AGENT_E2E_RPC_URL');

    // Buy: approvals (none for ETH) + tx, from the throwaway wallet funded only inside the simulation.
    const buyCalls = [...b.json.approvals.map((a: any) => approvalCall(a, from)), txCall(b.json.tx, from)];
    const sim = await simulate([{ stateOverrides: fundOverride(from, '1'), calls: buyCalls }]);
    if (!check(sim.ok, `${label}: eth_simulateV1 accepted`, sim.error)) return;
    const calls = sim.blocks![0]!.calls;
    const last = calls[calls.length - 1]!;
    const okBuy = check(last.status === '0x1', `${label}: simulated buy succeeds`, last.error?.message);
    const got = received(calls, token, from);
    const feePaid = received(calls, NATIVE_EMITTER, TREASURY) + received(calls, WETH, TREASURY);
    if (okBuy) {
      check(got >= BigInt(b.json.quote.minAmountOut), `${label}: tokens out ≥ minAmountOut`, `got ${got}, expected ${b.json.quote.amountOut}, min ${b.json.quote.minAmountOut}, slippage ${bps(BigInt(b.json.quote.amountOut) - got, BigInt(b.json.quote.amountOut))}bps vs quote`);
      check(feePaid > 0n, `${label}: fee reaches the treasury in the same transaction`, `fee ${formatEther(feePaid)} ETH = ${bps(feePaid, BigInt(buyIn))}bps of amountIn, gas ${BigInt(last.gasUsed)}`, b.json.quote.pool?.venue === 'pons-curve' ? 'warn' : 'fail');
      if (feePaid === 0n && b.json.quote.pool?.venue === 'pons-curve') {
        const followUp = JSON.stringify(b.json).includes('feeFollowUp') || JSON.stringify(b.json).toLowerCase().includes('follow');
        check(followUp, `${label}: response tells the agent to send the 0.25% follow-up fee transfer`, followUp ? '' : 'no follow-up fee instruction in the build response');
      }
    }

    // Expired: the same buy with the block time past the deadline must revert.
    const late = await simulate([{ stateOverrides: fundOverride(from, '1'), blockOverrides: { time: `0x${(BigInt(b.json.deadline) + 120n).toString(16)}` }, calls: buyCalls }]);
    const lateLast = late.blocks?.[0]?.calls.at(-1);
    check(late.ok && lateLast?.status === '0x0', `${label}: tx built ${b.json.deadline} reverts after its deadline`, lateLast?.error?.message ?? late.error, 'warn');

    // Sell: buy first (block 1), then approvals + sell of half the minimum bought (block 2).
    if (!okBuy) return;
    const sellIn = (BigInt(b.json.quote.minAmountOut) / 2n).toString();
    const sq = await tradeOf({ token, side: 'sell', amountIn: sellIn }, 'quote');
    check(sq.status === 200, `${label}: sell quote`, sq.status === 200 ? `out=${formatEther(BigInt(sq.json.quote.amountOut))} ETH fee=${sq.json.quote.fee?.feeAmount} (${sq.json.quote.fee?.feeBps}bps)` : brief(sq));
    const sb = await tradeOf({ token, side: 'sell', amountIn: sellIn }, 'build');
    if (!check(sb.status === 200 && sb.json?.tx, `${label}: build unsigned sell tx`, sb.status === 200 ? `approvals=${sb.json.approvals.map((a: any) => a.kind).join('+') || 'none'}` : brief(sb))) return;
    const sellCalls = [...sb.json.approvals.map((a: any) => approvalCall(a, from)), txCall(sb.json.tx, from)];
    const ss = await simulate([{ stateOverrides: fundOverride(from, '1'), calls: buyCalls }, { calls: sellCalls }]);
    if (!check(ss.ok, `${label}: sell simulation accepted`, ss.error)) return;
    const sc = ss.blocks![1]!.calls;
    const sLast = sc[sc.length - 1]!;
    if (check(sLast.status === '0x1', `${label}: simulated sell succeeds`, sLast.error?.message)) {
      const ethOut = received(sc, NATIVE_EMITTER, from) + received(sc, WETH, from);
      const sellFee = received(sc, NATIVE_EMITTER, TREASURY) + received(sc, WETH, TREASURY);
      const gross = ethOut + sellFee;
      check(sellFee > 0n, `${label}: sell fee reaches the treasury`, `out ${formatEther(ethOut)} ETH, fee ${formatEther(sellFee)} ETH = ${bps(sellFee, gross)}bps of gross, gas ${BigInt(sLast.gasUsed)}`, sb.json.quote.pool?.venue === 'pons-curve' ? 'warn' : 'fail');
    }
  }

  await tradeCase('graduated', graduated);
  await tradeCase('curve', curveToken);

  // Guardrails
  const bad = [
    [{ token: '0x12', side: 'buy', amountIn: '1' }, 'invalid_field', 'bad token address'],
    [{ token: graduated, side: 'hold', amountIn: '1' }, 'invalid_field', 'bad side'],
    [{ token: graduated, side: 'buy', amountIn: '0.01' }, 'invalid_field', 'decimal amountIn'],
    [{ token: graduated, side: 'buy', amountIn: '-5' }, 'invalid_field', 'negative amountIn'],
    [{ token: graduated, side: 'buy', amountIn: '1000', slippageBps: 9000 }, 'invalid_field', 'slippage over 50%'],
    [{ token: graduated, side: 'buy', amountIn: '1000', quoteAsset: 'BTC' }, 'invalid_field', 'unknown quoteAsset'],
    [{ token: graduated, side: 'buy', amountIn: '1000', from: '0x000000000000000000000000000000000000beef' }, 'wrong_wallet', 'from another wallet'],
  ] as const;
  for (const [body, code, what] of bad) {
    const r = await tradeOf(body as Record<string, unknown>, 'quote');
    check(r.status >= 400 && r.status < 500 && errCode(r) === code, `quote refuses ${what}`, brief(r));
  }
  const numAmount = await tradeOf({ token: graduated, side: 'buy', amountIn: 1e15 }, 'quote');
  check(numAmount.status === 200 || errCode(numAmount) === 'invalid_field', 'a JSON number amountIn is handled', brief(numAmount));
  const huge = await tradeOf({ token: graduated, side: 'buy', amountIn: parseEther('1000000').toString() }, 'quote');
  check(huge.status !== 200 || (huge.json?.warnings?.length ?? 0) > 0 || (huge.json?.quote?.priceImpactBps ?? 0) > 1000, 'a 1M ETH buy is refused or loudly warned (no per-trade cap)', huge.status === 200 ? `impact=${huge.json.quote.priceImpactBps}bps warnings=${JSON.stringify(huge.json.warnings)}` : brief(huge), 'warn');
  const noKey = await api('POST', '/v1/trade/quote', { body: { token: graduated, side: 'buy', amountIn: '1000' } });
  check(noKey.status === 401 && errCode(noKey) === 'unauthorized', 'quote needs an API key', brief(noKey));

  // High-risk and blocked tokens: find them through the public safety view unless given.
  let highRisk = process.env.AGENT_E2E_HIGH_RISK?.toLowerCase();
  let blocked = process.env.AGENT_E2E_BLOCKED?.toLowerCase();
  if (!highRisk || !blocked) {
    // Copycats of the graduated token's ticker are the likeliest spam; then the trenches.
    const pool = [...copycats.slice(0, 10), ...[...(columns.migrated ?? []), ...(columns.new ?? [])].map((t) => t.address)].slice(0, 40);
    for (const addr of pool) {
      if (highRisk && blocked) break;
      const s = await api('GET', `/v1/tokens/${addr}/safety`);
      if (!blocked && s.json?.safety?.blocked) blocked = addr;
      else if (!highRisk && s.json?.safety?.riskLevel === 'high' && !s.json?.safety?.blocked) highRisk = addr;
    }
  }
  if (highRisk) {
    const r = await tradeOf({ token: highRisk, side: 'buy', amountIn: parseEther('0.001').toString() }, 'build');
    check(r.status === 422 && errCode(r) === 'unsafe_token', 'high-risk buy refused without acceptRisk', `${highRisk} ${brief(r)}`);
    const q = await tradeOf({ token: highRisk, side: 'buy', amountIn: parseEther('0.001').toString() }, 'quote');
    check(q.status !== 200 || q.json?.wouldBuild === false, 'quote on a high-risk token says wouldBuild=false', q.status === 200 ? `wouldBuild=${q.json.wouldBuild}` : brief(q));
    const ok = await tradeOf({ token: highRisk, side: 'buy', amountIn: parseEther('0.001').toString(), acceptRisk: 'high' }, 'build');
    check(ok.status === 200 || errCode(ok)?.startsWith('trade_'), 'high-risk buy builds with acceptRisk=high (or fails only on routing)', brief(ok));
  } else record('skip', 'high-risk gate', 'no high-risk token found');
  if (blocked) {
    const r = await tradeOf({ token: blocked, side: 'buy', amountIn: parseEther('0.001').toString(), acceptRisk: 'high' }, 'build');
    check(r.status === 422 && errCode(r) === 'honeypot', 'blocked (spam/honeypot) buy is always refused', `${blocked} ${brief(r)}`);
    const s = await tradeOf({ token: blocked, side: 'sell', amountIn: '1000000000000000000' }, 'build');
    check(errCode(s) !== 'honeypot', 'sells of a blocked token are not blocked', brief(s));
  } else record('skip', 'honeypot gate', 'no blocked token found');

  // ---- 6. Limits and errors ----
  section('6 limits and errors');
  const malformed = await api('GET', '/v1/agents/me', { key: 'rk_garbage' });
  check(malformed.status === 401 && errCode(malformed) === 'invalid_key', 'malformed API key → 401 invalid_key', brief(malformed));
  const unknownKey = await api('GET', '/v1/agents/me', { key: `rk_${me.keyId.replace(/^rk_/, '').split('_')[0]}_${'x'.repeat(30)}` });
  check(unknownKey.status === 401 && errCode(unknownKey) === 'invalid_key', 'right key id, wrong secret → 401', brief(unknownKey));
  const noAuth = await api('GET', '/v1/agents/me');
  check(noAuth.status === 401, 'no key → 401', brief(noAuth));
  const bearerless = await api('GET', '/v1/agents/me', { headers: { authorization: me.key } });
  check(bearerless.status === 200, 'Authorization without "Bearer " still accepted', brief(bearerless), 'warn');

  // Invalid SIWE
  const evil = privateKeyToAccount(generatePrivateKey());
  const n2 = await siweMessage(account.address, 'register');
  const wrongSigner = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: n2.json.message, signature: await evil.signMessage({ message: n2.json.message }), handle: `e2e_${RUN}_c` } });
  check(wrongSigner.status === 401 && errCode(wrongSigner) === 'invalid_signature', 'signature from another wallet → invalid_signature', brief(wrongSigner));
  const n3 = await siweMessage(evil.address, 'register');
  const tampered = n3.json.message.replace('independent AI agent', 'human');
  const tamperedRes = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: tampered, signature: await evil.signMessage({ message: tampered }), handle: `e2e_${RUN}_d` } });
  check(tamperedRes.status === 401 && errCode(tamperedRes) === 'wrong_statement', 'edited statement → wrong_statement', brief(tamperedRes));
  const garbage = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: 'hello', signature: '0x00', handle: `e2e_${RUN}_e` } });
  check(garbage.status === 422 && errCode(garbage) === 'malformed', 'garbage message → malformed', brief(garbage));
  const n4 = await siweMessage(evil.address, 'login');
  const purposeSwap = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: n4.json.message, signature: await evil.signMessage({ message: n4.json.message }), handle: `e2e_${RUN}_f` } });
  check(purposeSwap.status === 401 && errCode(purposeSwap) === 'nonce_unknown', 'a login nonce cannot register', brief(purposeSwap));
  const loginUnregistered = await api('POST', '/v1/agents/login', { ip: freshIp(), body: { message: n4.json.message, signature: await evil.signMessage({ message: n4.json.message }) } });
  check(loginUnregistered.status === 404 && errCode(loginUnregistered) === 'not_registered', 'login for an unregistered wallet → not_registered', brief(loginUnregistered));
  check(nonce.json?.expiresAt && new Date(nonce.json.expiresAt).getTime() - Date.now() <= 10 * 60_000, 'nonce expires within 10 minutes', nonce.json?.expiresAt);
  const badPurpose = await api('GET', `/v1/auth/nonce?address=${account.address}&purpose=admin`);
  check(badPurpose.status === 422, 'unknown purpose → 422', brief(badPurpose));
  const badAddrNonce = await api('GET', '/v1/auth/nonce?address=bob');
  check(badAddrNonce.status === 422, 'bad address → 422', brief(badAddrNonce));

  // Handles
  const dupHandle = await register(handle, { ip: freshIp() });
  check(dupHandle.res.status === 409 && errCode(dupHandle.res) === 'handle_taken', 'duplicate handle → handle_taken', brief(dupHandle.res));
  const caseHandle = await register(handle.toUpperCase(), { ip: freshIp() });
  check(caseHandle.res.status === 409, 'duplicate handle in another case → handle_taken', brief(caseHandle.res));
  for (const h of ['rushr', 'rushr_bot', 'RushrOfficial', 'rushr123', 'admin', 'ru5hr', 'rush_r']) {
    const r = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: 'x', signature: '0x', handle: h } });
    const reserved = errCode(r) === 'handle_reserved';
    check(reserved, `reserved handle "${h}" refused`, brief(r), h === 'ru5hr' || h === 'rush_r' ? 'warn' : 'fail');
  }
  const bad3 = await api('POST', '/v1/agents/register', { ip: freshIp(), body: { message: 'x', signature: '0x', handle: 'a' } });
  check(errCode(bad3) === 'handle_invalid', 'too-short handle → handle_invalid', brief(bad3));
  const sameWallet = await register(`e2e_${RUN}_g`, { account, ip: freshIp() });
  check(sameWallet.res.status === 409 && errCode(sameWallet.res) === 'wallet_taken', 'second account for the same wallet → wallet_taken', brief(sameWallet.res));

  // Bodies
  const big = await api('PATCH', '/v1/me', { key: me.key, raw: JSON.stringify({ bio: 'x'.repeat(20_000) }) });
  check(big.status === 413 && errCode(big) === 'too_large', 'body over 16KB → 413 too_large', brief(big));
  const notJson = await api('PATCH', '/v1/me', { key: me.key, raw: '{nope' });
  check(notJson.status === 400 && errCode(notJson) === 'invalid_json', 'invalid JSON → 400', brief(notJson));
  const keyField = await api('PATCH', '/v1/me', { key: me.key, body: { bio: 'hi', privateKey: generatePrivateKey() } });
  check(keyField.status === 400 && errCode(keyField) === 'never_send_keys', 'a private key in the body → never_send_keys', brief(keyField));
  const seed = await api('POST', '/v1/callouts', { key: me.key, body: { token: graduated, body: 'abandon ability able about above absent absorb abstract absurd abuse access accident' } });
  check(seed.status === 400 && errCode(seed) === 'never_send_keys', 'a seed phrase in a callout → never_send_keys', brief(seed));
  const longBio = await api('PATCH', '/v1/me', { key: me.key, body: { bio: 'y'.repeat(161) } });
  check(longBio.status === 422, 'bio over 160 chars → 422', brief(longBio));

  // Key revocation and rotation
  const n5 = await siweMessage(account.address, 'login');
  const login = await api('POST', '/v1/agents/login', { ip: freshIp(), body: { message: n5.json.message, signature: await account.signMessage({ message: n5.json.message }) } });
  check(login.status === 200 && login.json?.apiKey?.key, 'login rotates to a new key', brief(login));
  const oldKey = await api('GET', '/v1/agents/me', { key: me.key });
  check(oldKey.status === 401 && errCode(oldKey) === 'invalid_key', 'old key is revoked after login', brief(oldKey));
  if (login.json?.apiKey?.key) {
    me.key = login.json.apiKey.key;
    me.keyId = login.json.apiKey.id;
  }
  if (other.agent) {
    const revoke = await api('DELETE', `/v1/agents/me/keys/${other.agent.keyId}`, { key: other.agent.key });
    check(revoke.status === 200, 'DELETE /v1/agents/me/keys/:id revokes a key', brief(revoke));
    const after = await api('GET', '/v1/agents/me', { key: other.agent.key });
    check(after.status === 401, 'revoked key → 401', brief(after));
  }

  // Rate limits. Floods use invalid bodies where possible so they cost no RPC calls.
  if (process.env.AGENT_E2E_SKIP_LIMITS === '1') record('skip', 'rate limits', 'AGENT_E2E_SKIP_LIMITS=1');
  else {
    const limited = await register(`e2e_${RUN}_rl`, { ip: freshIp() });
    if (limited.agent) {
      const k = limited.agent.key;
      let reads429 = 0;
      for (let i = 0; i < 65; i++) if ((await api('GET', '/v1/agents/me', { key: k })).status === 429) reads429++;
      check(reads429 > 0, 'read limit: 65 reads in a minute hit 429 (llms.txt: 60/min)', `${reads429} limited`);
      let quote429: Res | null = null;
      for (let i = 0; i < 22 && !quote429; i++) {
        const r = await api('POST', '/v1/trade/quote', { key: k, body: { token: '0x1', side: 'x' } });
        if (r.status === 429) quote429 = r;
      }
      check(quote429 && quote429.headers.get('retry-after'), 'quote limit: 429 with Retry-After within 21 quotes', quote429 ? `${brief(quote429)} retry-after=${quote429.headers.get('retry-after')}` : 'never limited');
      const afterQuoteLimit = await api('POST', '/v1/trade/quote', { key: k, body: { token: '0x1', side: 'x' } });
      if (afterQuoteLimit.status === 429) note('invalid requests count against the quote limit (limit is checked before validation)');
      let build429 = false;
      for (let i = 0; i < 12 && !build429; i++) build429 = (await api('POST', '/v1/trade/build', { key: k, body: {} })).status === 429;
      check(build429, 'build limit: 429 within 11 builds');
      let callout429 = 0;
      for (let i = 0; i < 11; i++) if ((await api('POST', '/v1/callouts', { key: k, body: { token: 'bad' } })).status === 429) callout429++;
      const realCallout = await api('POST', '/v1/callouts', { key: k, body: { token: graduated, body: `after typos ${RUN}` } });
      check(realCallout.status !== 429, 'invalid callout attempts do not use up the 10/hour callout quota', `${callout429} of 11 invalid posts limited; then a valid post → ${brief(realCallout)}`);
      if (realCallout.json?.callout?.id) await api('DELETE', `/v1/callouts/${realCallout.json.callout.id}`, { key: k });
    } else record('skip', 'per-key limits', brief(limited.res));

    const typoIp = freshIp();
    for (let i = 0; i < 5; i++) await api('POST', '/v1/agents/register', { ip: typoIp, body: { message: 'x', signature: '0x', handle: 'no' } });
    const afterTypos = await register(`e2e_${RUN}_ty`, { ip: typoIp });
    check(afterTypos.res.status === 201, 'five rejected sign-up attempts (bad handle) do not use up the 5/day registration quota', brief(afterTypos.res));

    const nonceWallet = privateKeyToAccount(generatePrivateKey()).address;
    let open429: Res | null = null;
    for (let i = 0; i < 6 && !open429; i++) {
      const r = await siweMessage(nonceWallet, 'register', `10.0.0.${rand(250)}`);
      if (r.status === 429) open429 = r;
    }
    check(open429 && open429.headers.get('retry-after'), 'more than 5 open nonces per wallet → 429 with Retry-After', open429 ? brief(open429) : 'never limited');

    const regIp = `10.1.${rand(255)}.${rand(255)}`;
    let reg429: Res | null = null;
    let made = 0;
    for (let i = 0; i < 6 && !reg429; i++) {
      const r = await register(`e2e_${RUN}_ip${i}`, { ip: regIp });
      if (r.res.status === 429) reg429 = r.res;
      else if (r.agent) made++;
    }
    check(reg429 && made === 5, 'registration limit: 6th registration from one IP in a day → 429', reg429 ? `${made} made, then ${brief(reg429)}` : `${made} made, never limited`);
    const loginIp = await siweMessage(account.address, 'login', regIp);
    const loginAfter = await api('POST', '/v1/agents/login', { ip: regIp, body: { message: loginIp.json?.message, signature: loginIp.json?.message ? await account.signMessage({ message: loginIp.json.message }) : '0x' } });
    if (loginAfter.status === 429) note('key rotation (POST /v1/agents/login) shares the 5/day per-IP registration bucket: after 5 sign-ups from one IP, no agent behind it can rotate a leaked key for a day');
    else if (loginAfter.status === 200) {
      me.key = loginAfter.json.apiKey.key;
      me.keyId = loginAfter.json.apiKey.id;
    }
  }

  // ---- 7. Leaderboard and season ----
  section('7 leaderboard');
  if (LOCAL) {
    const now = Date.now();
    const season = await api('POST', '/admin/agents/seasons', { key: ADMIN_TOKEN, body: { id: `s_e2e_${RUN}`, name: `E2E season ${RUN}`, startsAt: new Date(now - 7 * 86_400_000).toISOString(), endsAt: new Date(now + 7 * 86_400_000).toISOString() } });
    check(season.status === 200, 'create a local season via the admin route', brief(season));
  }
  const seasons = await api('GET', '/v1/seasons');
  check(seasons.status === 200, 'GET /v1/seasons', `${JSON.stringify(seasons.json).slice(0, 160)}`);
  const lb = await api('GET', '/v1/leaderboard?window=season&kind=agent');
  check(lb.status === 200, 'season leaderboard (agents)', `${lb.json?.items?.length ?? lb.json?.rows?.length ?? '?'} rows`);
  const listed = (lb.json?.rows ?? []).some((r: any) => r.member?.handle === handle);
  check(!listed, 'an agent with no trades is not ranked', listed ? 'listed' : 'not listed');
  const rank = await api('GET', `/v1/members/${handle}/rank`);
  check(rank.status === 200, 'GET /v1/members/:handle/rank', `${rank.status} ${JSON.stringify(rank.json).slice(0, 200)}`);
}

main()
  .catch((e) => {
    record('fail', 'script crashed', e instanceof Error ? `${e.message}` : String(e));
    console.error(e);
  })
  .finally(() => {
    const count = (s: Status) => results.filter((r) => r.status === s).length;
    console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('skip')} skipped`);
    if (findings.length) console.log(`Notes:\n${findings.map((f) => `- ${f}`).join('\n')}`);
    if (process.env.AGENT_E2E_OUT) writeFileSync(process.env.AGENT_E2E_OUT, JSON.stringify({ base: BASE, run: RUN, at: new Date().toISOString(), results, notes: findings }, null, 2));
    process.exitCode = count('fail') ? 1 : 0;
  });
