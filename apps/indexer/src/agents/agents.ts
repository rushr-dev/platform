// Independent agents: SIWE registration and API keys, a safety view, and quotes plus UNSIGNED
// transactions. Rushr never holds keys, never signs, never sends, never trades for anyone.
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { createPublicClient, http, type Address } from 'viem';
import { checkHandle } from '@rushr/agents/guard';
import { newApiKey, newMemberId, newNonce } from '@rushr/agents/crypto';
import { MAX_OUTSTANDING_NONCES } from '@rushr/agents/limits';
import { buildMessage, NONCE_TTL_MS, peekSiwe, verifySiwe, type Purpose } from '@rushr/agents/siwe';
import { prepareSwap, toJsonSafe } from '@rushr/trade/agent';
import { robinhoodChain } from '@rushr/trade/chain';
import { isTradeError } from '@rushr/trade/errors';
import { bioField, enqueueWalletFunding, fail, flag, isAddr, limit, memberColumns, publicCache, PRIVATE, requireMember, str, type C, type Ctx, type MemberRow } from './http';
import { publicMember } from './members';
import { recordReferral } from './referrals';

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

async function issueKey(sql: Sql, memberId: string, revokeOthers: boolean) {
  const key = await newApiKey();
  await sql.begin(async (tx) => {
    if (revokeOthers) await tx`update api_keys set revoked_at = now() where member_id = ${memberId} and revoked_at is null`;
    await tx`insert into api_keys (id, member_id, secret_hash, scopes) values (${key.id}, ${memberId}, ${key.secretHash}, ${AGENT_SCOPES})`;
  });
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
  await limit(c, 'register');
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
  const [member] = await sql.begin(async (tx) => {
    const rows = await tx.unsafe<MemberRow[]>(
      `insert into members (id, kind, origin, handle, wallet, display_name, bio) values ($1, 'agent', 'self', $2, $3, $4, $5) returning ${memberColumns}`,
      [id, h.handle, wallet, displayName, bio],
    );
    const referral = await recordReferral(tx, { id, wallet }, b.referralCode);
    await tx`insert into member_events (member_id, type, data) values (${id}, 'register', ${tx.json({ origin: 'self', referral: referral?.code ?? null })})`;
    return rows;
  });
  const apiKey = await issueKey(sql, id, false);
  await enqueueWalletFunding(c, wallet);
  return c.json({ member: publicMember(member!), apiKey }, 201, PRIVATE);
});

/** Sign in again with the wallet: revokes every key and issues a new one (rotation and recovery). */
agents.post('/agents/login', async (c) => {
  await limit(c, 'register');
  const sql = c.var.sql;
  const wallet = await consumeSiwe(sql, (c.var.body ?? {}) as Record<string, unknown>, 'login');
  const [m] = await sql.unsafe<MemberRow[]>(`select ${memberColumns} from members where wallet = $1`, [wallet]);
  if (!m || m.kind !== 'agent') throw fail(404, 'not_registered', 'No agent account for this wallet. Register first.');
  if (m.status !== 'active') throw fail(403, 'suspended', 'This account is suspended.');
  return c.json({ member: publicMember(m), apiKey: await issueKey(sql, m.id, true) }, 200, PRIVATE);
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
  return c.json({ safety: await safetyOf(c.var.sql, token), note: 'Data, not advice. A low risk level is not a guarantee.' }, 200, publicCache(5));
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

async function prepare(c: C, mode: 'quote' | 'build') {
  const m = requireMember(c, { kind: 'agent', scope: 'trade' });
  await limit(c, mode);
  const { req, acceptRisk, simulate } = swapRequest(c, m);
  const safety = await safetyOf(c.var.sql, req.token);
  if (mode === 'build') riskGate(req.side, safety, acceptRisk);
  const client = createPublicClient({ chain: robinhoodChain, transport: http(c.env.RPC_URL) });
  try {
    const p = await prepareSwap(client as never, req, { forSigning: mode === 'build', simulate: mode === 'build' && simulate });
    const quote = toJsonSafe(p.quote) as Record<string, unknown>;
    if (mode === 'quote') {
      return c.json({ quote, alternatives: toJsonSafe(p.alternatives), safety, warnings: p.warnings, wouldBuild: safetyAllows(req.side, safety, acceptRisk) }, 200, PRIVATE);
    }
    return c.json(
      {
        tx: toJsonSafe(p.tx),
        approvals: toJsonSafe(p.approvals),
        deadline: p.deadline.toString(),
        quote,
        simulation: p.simulation ? toJsonSafe(p.simulation) : null,
        safety,
        warnings: p.warnings,
        note: 'Unsigned. Send the approvals first (in order), then tx, from your own wallet. Simulate before sending. Rushr never signs or sends for you.',
      },
      200,
      PRIVATE,
    );
  } catch (e) {
    if (isTradeError(e)) throw fail(422, `trade_${e.code}`, e.message);
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
/** Same body plus `acceptRisk?: "high"`, `simulate?: true` → unsigned tx and approvals. */
agents.post('/trade/build', (c) => prepare(c, 'build'));
