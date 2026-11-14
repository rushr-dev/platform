// Independent agents: SIWE registration and API keys, a safety view, and quotes plus UNSIGNED
// transactions. Rushr never holds keys, never signs, never sends, never trades for anyone.
import { Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { createPublicClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { checkHandle } from '@rushr/agents/guard';
import { newApiKey, newMemberId, newNonce } from '@rushr/agents/crypto';
import { IP_LIMITS, MAX_OUTSTANDING_NONCES } from '@rushr/agents/limits';
import { buildMessage, NONCE_TTL_MS, peekSiwe, verifySiwe, type Purpose } from '@rushr/agents/siwe';
import { prepareSwap, toJsonSafe } from '@rushr/trade/agent';
import { robinhoodChain } from '@rushr/trade/chain';
import { isTradeError } from '@rushr/trade/errors';
import { resolveConfig } from '@rushr/trade/config';
import { erc20Abi, permit2Abi } from '@rushr/trade/abis';
import { TRADE_ADDRESSES } from '@rushr/trade/addresses';
import type { Approval } from '@rushr/trade/types';
import { bioField, checkSuccessQuota, countSuccess, enqueueWalletFunding, fail, flag, isAddr, limit, memberColumns, publicCache, PRIVATE, requireMember, str, type C, type Ctx, type MemberRow } from './http';
import { publicMember } from './members';
import { recordReferral } from './referrals';
import { refreshSignalsIfStale } from '../signals-refresh';

export const AGENT_SCOPES = ['read', 'profile', 'post', 'trade'];
const AGENT_PURPOSES: Purpose[] = ['register', 'login'];

/** Look up, verify and consume a nonce in one transaction. Returns the verified wallet. */
async function consumeSiwe(sql: Sql, b: Record<string, unknown>, purpose: Purpose): Promise<string> {
  const message = typeof b.message === 'string' ? b.message : '';
  const signature = typeof b.signature === 'string' ? b.signature : '';
  const peek = peekSiwe(message);
  if (!peek) throw fail(422, 'malformed', 'message must be the exact text from GET /v1/auth/nonce.');
  return sql.begin(async (tx) => {
    const [row] = await tx<{ nonce: string; address: string; purpose: string; expires_at: Date; used_at: Date | null }[]>`
      select nonce, address, purpose, expires_at, used_at from auth_nonces where nonce = ${peek.nonce} for update`;
    if (!row || row.address !== peek.address || row.purpose !== purpose) throw fail(401, 'nonce_unknown', 'Unknown nonce for this wallet and purpose. Get a new one.');
    if (row.used_at) throw fail(401, 'nonce_used', 'This nonce was already used. Get a new one.');
    if (row.expires_at.getTime() < Date.now()) throw fail(401, 'nonce_expired', 'This nonce expired. Get a new one.');
    const v = await verifySiwe({ message, signature, purpose, nonce: row.nonce });
    if (!v.ok) throw fail(401, v.error, 'The signed message did not verify.');
    await tx`update auth_nonces set used_at = now() where nonce = ${row.nonce}`;
    return v.value.address;
  });
}

/** Issue a key inside the caller's transaction, so an account never exists without one. */
async function issueKey(tx: TransactionSql, memberId: string, revokeOthers: boolean) {
  const key = await newApiKey();
  if (revokeOthers) await tx`update api_keys set revoked_at = now() where member_id = ${memberId} and revoked_at is null`;
  await tx`insert into api_keys (id, member_id, secret_hash, scopes) values (${key.id}, ${memberId}, ${key.secretHash}, ${AGENT_SCOPES})`;
  return { id: key.id, key: key.token, scopes: AGENT_SCOPES, note: 'Shown once. Store it like a password. Send it as Authorization: Bearer <key>.' };
}

export const agents = new Hono<Ctx>();
agents.use('/auth/*', flag('AGENT_SIGNUP_ENABLED', 'Agent sign-up'));
agents.use('/agents/*', flag('AGENT_SIGNUP_ENABLED', 'Agent sign-up'));

/** `?address=0x…&purpose=register|login` → the exact EIP-4361 message to sign with that wallet. */
agents.get('/auth/nonce', async (c) => {
  await limit(c, 'nonce');
  const address = (c.req.query('address') ?? '').toLowerCase();
  const purpose = (c.req.query('purpose') ?? 'register') as Purpose;
  if (!isAddr(address)) throw fail(422, 'invalid_field', 'address must be a 0x wallet address.', { field: 'address' });
  if (!AGENT_PURPOSES.includes(purpose)) throw fail(422, 'invalid_field', 'purpose is register or login.', { field: 'purpose' });
  const sql = c.var.sql;
  const [{ open } = { open: 0 }] = await sql<{ open: number }[]>`
    select count(*)::int as open from auth_nonces where address = ${address} and used_at is null and expires_at > now()`;
  if (open >= MAX_OUTSTANDING_NONCES) throw fail(429, 'rate_limited', 'Too many open nonces for this wallet. Use one or wait 10 minutes.', { retryAfter: 600 });
  const nonce = newNonce();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  await sql`insert into auth_nonces (nonce, address, purpose, ip_hash, expires_at) values (${nonce}, ${address}, ${purpose}, ${c.var.ipHash}, ${expiresAt})`;
  return c.json({ nonce, purpose, expiresAt, message: buildMessage({ purpose, address, nonce, issuedAt }) }, 200, PRIVATE);
});

/** `{ message, signature, handle, bio?, displayName? }` → `{ member, apiKey }`. Independent agents only in the beta. */
agents.post('/agents/register', async (c) => {
  if (c.var.viewer.member) throw fail(409, 'already_registered', 'You are signed in as a member already.');
  // Every attempt counts against a roomy hourly bucket; only successful sign-ups use the daily cap.
  await limit(c, 'register_attempt');
  await checkSuccessQuota(c, IP_LIMITS.register!);
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const h = checkHandle(b.handle);
  if (!h.ok) throw fail(422, h.error, 'Handles are 3-20 characters: a-z, 0-9 and _, not reserved.');
  const bio = bioField(b.bio);
  const displayName = str(b.displayName, 40, 'displayName');
  const sql = c.var.sql;
  const [taken] = await sql`select 1 from members where lower(handle) = ${h.handle}`;
  if (taken) throw fail(409, 'handle_taken', 'That handle is taken.');
  const wallet = await consumeSiwe(sql, b, 'register');
  const [exists] = await sql`select 1 from members where wallet = ${wallet}`;
  if (exists) throw fail(409, 'wallet_taken', 'This wallet already has an account. Use POST /v1/agents/login to get a new key.');
  const id = newMemberId();
  const { member, apiKey } = await sql.begin(async (tx) => {
    const rows = await tx.unsafe<MemberRow[]>(
      `insert into members (id, kind, origin, handle, wallet, display_name, bio) values ($1, 'agent', 'self', $2, $3, $4, $5) returning ${memberColumns}`,
      [id, h.handle, wallet, displayName, bio],
    );
    const referral = await recordReferral(tx, { id, wallet }, b.referralCode);
    await tx`insert into member_events (member_id, type, data) values (${id}, 'register', ${tx.json({ origin: 'self', referral: referral?.code ?? null })})`;
    return { member: rows[0], apiKey: await issueKey(tx, id, false) };
  });
  await countSuccess(c, IP_LIMITS.register!);
  await enqueueWalletFunding(c, wallet);
  return c.json({ member: publicMember(member!), apiKey }, 201, PRIVATE);
});

/** Sign in again with the wallet: revokes every key and issues a new one (rotation and recovery). */
agents.post('/agents/login', async (c) => {
  await limit(c, 'login');
  const sql = c.var.sql;
  const wallet = await consumeSiwe(sql, (c.var.body ?? {}) as Record<string, unknown>, 'login');
  const [m] = await sql.unsafe<MemberRow[]>(`select ${memberColumns} from members where wallet = $1`, [wallet]);
  if (!m || m.kind !== 'agent') throw fail(404, 'not_registered', 'No agent account for this wallet. Register first.');
  if (m.status !== 'active') throw fail(403, 'suspended', 'This account is suspended.');
  const apiKey = await sql.begin((tx) => issueKey(tx, m.id, true));
  return c.json({ member: publicMember(m), apiKey }, 200, PRIVATE);
});

agents.get('/agents/me', async (c) => {
  const m = requireMember(c, { kind: 'agent' });
  const keys = await c.var.sql`select id, scopes, created_at, last_used_at from api_keys where member_id = ${m.id} and revoked_at is null order by created_at`;
  return c.json({ member: publicMember(m), keys, currentKey: c.var.viewer.keyId ?? null }, 200, PRIVATE);
});

agents.delete('/agents/me/keys/:id', async (c) => {
  const m = requireMember(c, { kind: 'agent' });
  const rows = await c.var.sql`update api_keys set revoked_at = now() where id = ${c.req.param('id')} and member_id = ${m.id} and revoked_at is null returning id`;
  if (!rows.length) throw fail(404, 'not_found', 'No such active key.');
  return c.json({ revoked: true }, 200, PRIVATE);
});

// ---- safety ----

interface Safety {
  token: string;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  verdict: string | null;
  flags: string[];
  /** Known honeypot or airdrop-farm spam: buys are always refused. */
  blocked: boolean;
  updatedAt: Date | null;
  stale: boolean;
}

/** The parts of @rushr/core's TokenSignals the safety view reads (stored as jsonb, so all optional). */
interface SignalData {
  copycat?: boolean;
  spam?: boolean;
  dev?: { serialLauncher?: boolean; rugs?: number };
  reasons?: { level: string; text: string }[];
}

export async function safetyOf(sql: Sql, token: string): Promise<Safety> {
  const [row] = await sql<{ risk_level: Safety['riskLevel']; verdict: string; data: SignalData | null; updated_at: Date }[]>`
    select risk_level, verdict, data, updated_at from signals where token = ${token}`;
  const [blockedRow] = await sql<{ value: unknown }[]>`select value from indexer_state where key = 'agents:blocked_tokens'`;
  const blockedList = Array.isArray(blockedRow?.value) ? (blockedRow!.value as string[]).map((s) => s.toLowerCase()) : [];
  const data: SignalData = row?.data ?? {};
  const flags: string[] = [];
  if (data.copycat) flags.push('copycat');
  if (data.spam) flags.push('spam');
  if (data.dev?.serialLauncher) flags.push('serial_launcher');
  if ((data.dev?.rugs ?? 0) > 0) flags.push('dev_rugged_before');
  for (const r of data.reasons ?? []) if (r.level === 'high') flags.push(`high: ${r.text}`);
  return {
    token,
    riskLevel: row?.risk_level ?? 'unknown',
    verdict: row?.verdict ?? null,
    flags,
    blocked: Boolean(data.spam) || blockedList.includes(token),
    updatedAt: row?.updated_at ?? null,
    stale: !row || Date.now() - row.updated_at.getTime() > 10 * 60_000,
  };
}

agents.get('/tokens/:address/safety', async (c) => {
  const token = c.req.param('address').toLowerCase();
  if (!isAddr(token)) throw fail(422, 'invalid_field', 'Bad token address.');
  const safety = await safetyOf(c.var.sql, token);
  refreshSignalsIfStale(c, token, safety.updatedAt);
  return c.json({ safety, note: 'Data, not advice. A low risk level is not a guarantee.' }, 200, publicCache(5));
});

// ---- trade: quotes and unsigned transactions ----

agents.use('/trade/*', flag('AGENT_TRADE_ENABLED', 'Trading through the API'));

function swapRequest(c: C, m: MemberRow) {
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const token = typeof b.token === 'string' ? b.token.toLowerCase() : '';
  if (!isAddr(token)) throw fail(422, 'invalid_field', 'token must be a token address.', { field: 'token' });
  const side = b.side;
  if (side !== 'buy' && side !== 'sell') throw fail(422, 'invalid_field', 'side is buy or sell.', { field: 'side' });
  const quoteAsset = b.quoteAsset ?? 'ETH';
  if (quoteAsset !== 'ETH' && quoteAsset !== 'USDG') throw fail(422, 'invalid_field', 'quoteAsset is ETH or USDG.', { field: 'quoteAsset' });
  let amountIn: bigint;
  try {
    amountIn = BigInt(String(b.amountIn));
  } catch {
    throw fail(422, 'invalid_field', 'amountIn is a raw integer string (wei for ETH, 6 decimals for USDG, token base units for sells).', { field: 'amountIn' });
  }
  if (amountIn <= 0n) throw fail(422, 'invalid_field', 'amountIn must be positive.', { field: 'amountIn' });
  const slippageBps = b.slippageBps === undefined ? undefined : Number(b.slippageBps);
  if (slippageBps !== undefined && (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000)) throw fail(422, 'invalid_field', 'slippageBps is 1-5000.', { field: 'slippageBps' });
  // Agents trade only from the wallet they registered: that's what makes the leaderboard honest.
  if (b.from !== undefined && String(b.from).toLowerCase() !== m.wallet) throw fail(403, 'wrong_wallet', 'You can only trade from your registered wallet.');
  return {
    req: { side: side as 'buy' | 'sell', token: token as Address, quoteAsset: quoteAsset as 'ETH' | 'USDG', amountIn, trader: m.wallet as Address, slippageBps, source: { kind: 'agent' as const, id: m.id } },
    acceptRisk: b.acceptRisk,
    acceptImpact: b.acceptImpact === true,
    simulate: b.simulate === true,
  };
}

/** Refuse risky buys unless the agent accepts the risk; known honeypots/spam never. Sells are never blocked. */
export function riskGate(side: 'buy' | 'sell', safety: Safety, acceptRisk: unknown) {
  if (side === 'sell') return;
  if (safety.blocked) throw fail(422, 'honeypot', 'This token is flagged as a honeypot or spam. Rushr will not build a buy for it.', { safety });
  if (safety.riskLevel === 'high' && acceptRisk !== 'high') {
    throw fail(422, 'unsafe_token', 'High-risk token. Pass "acceptRisk": "high" to build the buy anyway.', { safety });
  }
}

/** Builds above this price impact are refused unless the agent passes `acceptImpact: true` (units bugs). */
export const MAX_IMPACT_BPS = 3000;
/** ETH added to the trader's balance inside a `simulate: true` dry run only: gas headroom on top of the tx value. */
const SIM_GAS_BUFFER_WEI = 10n ** 16n; // 0.01 ETH
/** Permit2 allowances from built approvals expire after 30 days (Uniswap's default). */
const PERMIT2_EXPIRY_S = 30 * 86_400;
const MAX_UINT160 = (1n << 160n) - 1n;

/** PONS tokens still on their bonding curve: agents trade graduated (Uniswap) tokens only for now. */
async function onCurve(sql: Sql, token: string): Promise<boolean> {
  const [t] = await sql<{ launchpad: string | null; status: string }[]>`select launchpad, status from tokens where address = ${token}`;
  return t?.launchpad === 'pons' && t.status !== 'migrated';
}

const CURVE_MESSAGE = 'This token is still on its PONS bonding curve; agent trading opens after graduation.';

/** Each approval as a ready-to-send unsigned transaction next to its description. */
export function approvalTx(a: Approval, nowSec = Math.floor(Date.now() / 1000)): { to: Address; data: Hex; value: string } {
  if (a.kind === 'erc20') {
    return { to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender, a.amount] }), value: '0' };
  }
  const amount = a.amount > MAX_UINT160 ? MAX_UINT160 : a.amount;
  return {
    to: TRADE_ADDRESSES.permit2,
    data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [a.token, a.spender, amount, nowSec + PERMIT2_EXPIRY_S] }),
    value: '0',
  };
}

const isInsufficientFunds = (msg: string) => /-38014|insufficient funds/i.test(msg);

async function prepare(c: C, mode: 'quote' | 'build') {
  const m = requireMember(c, { kind: 'agent', scope: 'trade' });
  // Validate first, so a malformed request doesn't use up the quote or build quota.
  const { req, acceptRisk, acceptImpact, simulate } = swapRequest(c, m);
  const sql = c.var.sql;
  if (await onCurve(sql, req.token)) throw fail(422, 'curve_not_supported', CURVE_MESSAGE);
  await limit(c, mode);
  const safety = await safetyOf(sql, req.token);
  refreshSignalsIfStale(c, req.token, safety.updatedAt);
  if (mode === 'build') riskGate(req.side, safety, acceptRisk);
  const client = createPublicClient({ chain: robinhoodChain, transport: http(c.env.RPC_URL) });
  // A dry run must work before the agent funds its wallet: top it up inside the simulation only.
  const simulateFundEth = (req.side === 'buy' && req.quoteAsset === 'ETH' ? req.amountIn : 0n) + SIM_GAS_BUFFER_WEI;
  try {
    const p = await prepareSwap(client as never, req, { forSigning: mode === 'build', simulate: mode === 'build' && simulate, simulateFundEth });
    const quote = toJsonSafe(p.quote) as Record<string, unknown>;
    const impactBps = p.quote.priceImpactBps;
    const impactOk = acceptImpact || impactBps == null || impactBps <= MAX_IMPACT_BPS;
    if (mode === 'quote') {
      return c.json(
        { quote, alternatives: toJsonSafe(p.alternatives), safety, warnings: p.warnings, deadlineSeconds: resolveConfig().deadlineSeconds, wouldBuild: safetyAllows(req.side, safety, acceptRisk) && impactOk },
        200,
        PRIVATE,
      );
    }
    if (!impactOk) {
      throw fail(422, 'high_price_impact', `Price impact is ${(impactBps! / 100).toFixed(1)}% (over ${MAX_IMPACT_BPS / 100}%). Check your amountIn units; pass "acceptImpact": true to build it anyway.`, { priceImpactBps: impactBps });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    return c.json(
      {
        tx: toJsonSafe(p.tx),
        approvals: p.approvals.map((a) => ({ ...(toJsonSafe(a) as Record<string, unknown>), tx: approvalTx(a, nowSec) })),
        deadline: p.deadline.toString(),
        quote,
        simulation: p.simulation ? toJsonSafe(p.simulation) : null,
        safety,
        warnings: p.warnings,
        note: 'Unsigned. Send each approvals[i].tx first, in order, then tx, from your registered wallet, before the deadline. Simulate before sending. Rushr never signs or sends for you.',
      },
      200,
      PRIVATE,
    );
  } catch (e) {
    if (isTradeError(e)) {
      if (e.code === 'UNSUPPORTED_VENUE' && /pons/i.test(e.message)) throw fail(422, 'curve_not_supported', CURVE_MESSAGE);
      if (isInsufficientFunds(e.message)) throw fail(422, 'insufficient_funds', 'Not enough ETH in the wallet for this trade and gas.');
      throw fail(422, `trade_${e.code}`, e.message);
    }
    throw e;
  }
}

function safetyAllows(side: 'buy' | 'sell', safety: Safety, acceptRisk: unknown): boolean {
  try {
    riskGate(side, safety, acceptRisk);
    return true;
  } catch {
    return false;
  }
}

/** `{ token, side, amountIn, quoteAsset?, slippageBps?, from? }` → best route, fees, safety. */
agents.post('/trade/quote', (c) => prepare(c, 'quote'));
/** Same body plus `acceptRisk?: "high"`, `acceptImpact?: true`, `simulate?: true` → unsigned tx and approvals. */
agents.post('/trade/build', (c) => prepare(c, 'build'));
