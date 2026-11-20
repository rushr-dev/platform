// Independent agents: SIWE registration and API keys, a safety view, and quotes plus UNSIGNED
// transactions. Rushr never holds keys, never signs, never sends, never trades for anyone.
import { Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { createPublicClient, encodeFunctionData, http, maxUint256, type Address, type Hex } from 'viem';
import { checkHandle } from '@rushr/agents/guard';
import { newApiKey, newMemberId, newNonce } from '@rushr/agents/crypto';
import { IP_LIMITS, MAX_OUTSTANDING_NONCES } from '@rushr/agents/limits';
import { buildMessage, NONCE_TTL_MS, peekSiwe, verifySiwe, type Purpose } from '@rushr/agents/siwe';
import { prepareSwap, toJsonSafe } from '@rushr/trade/agent';
import { probeTokenSafety } from '@rushr/trade/simulate';
import { robinhoodChain } from '@rushr/trade/chain';
import { isTradeError } from '@rushr/trade/errors';
import { resolveConfig } from '@rushr/trade/config';
import { erc20Abi, permit2Abi } from '@rushr/trade/abis';
import { TRADE_ADDRESSES } from '@rushr/trade/addresses';
import type { Approval, PonsPool } from '@rushr/trade/types';
import { curveFeeCall } from '@rushr/trade/curve-fee';
import { parseApiPools } from '@rushr/trade/api-pools';
import type { QuickTrade } from '@rushr/trade/quick';
import { bioField, checkSuccessQuota, countSuccess, enqueueWalletFunding, fail, flag, isAddr, limit, memberColumns, publicCache, PRIVATE, requireMember, str, type C, type Ctx, type MemberRow } from './http';
import { publicMember } from './members';
import { recordReferral } from './referrals';
import { refreshSignalsIfStale } from '../signals-refresh';
import { tokenPools } from '../data';
import { checkBuy, type HoneypotCheck } from './honeypot';
import { referralFor } from './referrals';
import { assertFeesPaid, curveSimulation, settledFeeStatus, feeView, liveCurve, prepareCurve, recordCurveBuild, reportFeePayment, unsigned } from './curve';

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
/** Throwaway address the honeypot probe trades from (funded inside the simulation only; never signs). */
const PROBE_TRADER: Address = '0x0000000000000000000000000000000000000001';
/** ETH amount for the probe when the agent's buy is quoted in USDG. */
const PROBE_ETH_WEI = 10n ** 16n; // 0.01 ETH

/** PONS tokens our index still shows on their bonding curve (the chain has the final word: liveCurve). */
async function maybeOnCurve(sql: Sql, token: string): Promise<boolean> {
  const [t] = await sql<{ launchpad: string | null; status: string }[]>`select launchpad, status from tokens where address = ${token}`;
  return t?.launchpad === 'pons' && t.status !== 'migrated';
}

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
  await limit(c, mode);
  // An overdue fee on an earlier curve trade blocks builds (quotes stay open), before any other work.
  if (mode === 'build') await assertFeesPaid(sql, c.env.RPC_URL, m);
  const safety = await safetyOf(sql, req.token);
  refreshSignalsIfStale(c, req.token, safety.updatedAt);
  if (mode === 'build') riskGate(req.side, safety, acceptRisk);
  const client = createPublicClient({ chain: robinhoodChain, transport: http(c.env.RPC_URL) });
  if (await maybeOnCurve(sql, req.token)) {
    const curve = await liveCurve(client as never, req.token, req.trader).catch(() => null);
    if (curve) return curveTrade(c, m, { req, curve, mode, safety, acceptRisk, acceptImpact, simulate, client });
  }
  // A dry run must work before the agent funds its wallet: top it up inside the simulation only.
  const simulateFundEth = (req.side === 'buy' && req.quoteAsset === 'ETH' ? req.amountIn : 0n) + SIM_GAS_BUFFER_WEI;
  try {
    // Pool keys come from our own index (what GET /tokens/:a/pools serves), not a fetch of our public URL
    // from inside the worker, so hooked v4 pools of every launchpad resolve.
    const pools = await tokenPools(sql, null, req.token);
    const poolsFetch = (async () => new Response(JSON.stringify({ pools: pools ?? [] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const p = await prepareSwap(client as never, req, { forSigning: mode === 'build', simulate: mode === 'build' && simulate, simulateFundEth, fetch: poolsFetch });
    // Every buy: simulated buy→sell round trip first (honeypot.ts). Fails closed; sells are never checked.
    let honeypotCheck: HoneypotCheck | null = null;
    if (req.side === 'buy') {
      honeypotCheck = await checkBuy(req.token, p.quote.pool.venue, async () => {
        const cfg = resolveConfig();
        // The probe funds a throwaway address with ETH inside the simulation, so it needs an ETH-quoted buy:
        // the agent's own quote when it pays in ETH, else a small ETH quote for the same token.
        const buy = req.quoteAsset === 'ETH'
          ? p.quote
          : (await prepareSwap(client as never, { ...req, quoteAsset: 'ETH', amountIn: PROBE_ETH_WEI, trader: PROBE_TRADER }, { fetch: poolsFetch })).quote;
        return probeTokenSafety(client as never, { ...buy, request: { ...buy.request, trader: PROBE_TRADER } }, cfg);
      });
    }
    const quote = toJsonSafe(p.quote) as Record<string, unknown>;
    const impactBps = p.quote.priceImpactBps;
    const impactOk = acceptImpact || impactBps == null || impactBps <= MAX_IMPACT_BPS;
    if (mode === 'quote') {
      return c.json(
        { quote, alternatives: toJsonSafe(p.alternatives), safety, honeypotCheck, warnings: p.warnings, deadlineSeconds: resolveConfig().deadlineSeconds, wouldBuild: safetyAllows(req.side, safety, acceptRisk) && impactOk },
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
        // Uniswap routes take the fee inside the swap: nothing to send after it.
        followUp: null,
        deadline: p.deadline.toString(),
        quote,
        simulation: p.simulation ? toJsonSafe(p.simulation) : null,
        safety,
        honeypotCheck,
        warnings: p.warnings,
        note: 'Unsigned. Send each approvals[i].tx first, in order, then tx, from your registered wallet, before the deadline. Simulate before sending. Rushr never signs or sends for you.',
      },
      200,
      PRIVATE,
    );
  } catch (e) {
    if (isTradeError(e)) {
      if (isInsufficientFunds(e.message)) throw fail(422, 'insufficient_funds', 'Not enough ETH in the wallet for this trade and gas.');
      throw fail(422, `trade_${e.code}`, e.message);
    }
    throw e;
  }
}

type SwapReq = ReturnType<typeof swapRequest>['req'];

/**
 * A token still on its PONS curve: trade the curve directly (the web app's path), with the Rushr fee
 * as a follow-up ETH transfer to the treasury after the trade confirms (curve.ts).
 */
async function curveTrade(
  c: C,
  m: MemberRow,
  x: { req: SwapReq; curve: PonsPool; mode: 'quote' | 'build'; safety: Safety; acceptRisk: unknown; acceptImpact: boolean; simulate: boolean; client: ReturnType<typeof createPublicClient> },
) {
  const { req, curve, mode, safety } = x;
  if (req.quoteAsset !== 'ETH') throw fail(422, 'invalid_field', 'Bonding-curve tokens trade in ETH: use quoteAsset "ETH".', { field: 'quoteAsset' });
  const sql = c.var.sql;
  const ref = await referralFor(sql, m.wallet);
  // Dry runs: the buy amount, the fee on top (≤ 1%) and gas headroom, inside the simulation only.
  const fundEthWei = (req.side === 'buy' ? req.amountIn + req.amountIn / 100n : 0n) + SIM_GAS_BUFFER_WEI;
  const client = x.client as never;
  try {
    const t = await prepareCurve(client, { side: req.side, token: req.token, amountIn: req.amountIn, trader: req.trader, slippageBps: req.slippageBps }, curve, {
      mode, simulate: x.simulate, acceptImpact: x.acceptImpact, referral: ref, fundEthWei,
      pairApiPools: async (token) => parseApiPools({ pools: (await tokenPools(sql, null, token.toLowerCase())) ?? [] }),
    });
    if (t.pairLegs) return pairCurveResponse(c, t, x);
    const q = t.quote!;
    // Curve quotes are exempt from the buy→sell probe, as on the web: sells go back to the same curve.
    const honeypotCheck: HoneypotCheck | null = req.side === 'buy' ? { checked: 'exempt', buyTaxBps: null, sellTaxBps: null, roundTripBps: null } : null;
    const impactBps = q.priceImpactBps;
    const impactOk = x.acceptImpact || impactBps == null || impactBps <= MAX_IMPACT_BPS;
    const fee = q.fee.feeAmount;
    const feeNote = req.side === 'buy'
      ? 'The Rushr fee is a separate transfer on top of amountIn, sent after the trade confirms.'
      : 'The Rushr fee is a separate transfer out of the ETH you receive, sent after the trade confirms.';
    // The web builder stamps its own source; this trade is the agent's.
    const quote = toJsonSafe({ ...q, request: { ...q.request, source: req.source } }) as Record<string, unknown>;
    if (mode === 'quote') {
      return c.json(
        { quote, alternatives: [], safety, honeypotCheck, warnings: [...t.warnings, feeNote], deadlineSeconds: null, followUpFee: fee.toString(), wouldBuild: safetyAllows(req.side, safety, x.acceptRisk) && impactOk },
        200,
        PRIVATE,
      );
    }
    if (!impactOk) {
      throw fail(422, 'high_price_impact', `Price impact is ${(impactBps! / 100).toFixed(1)}% (over ${MAX_IMPACT_BPS / 100}%). Check your amountIn units; pass "acceptImpact": true to build it anyway.`, { priceImpactBps: impactBps });
    }
    let calls = t.calls;
    // A dry run assumes no allowance; drop the curve approval when the wallet already has one.
    if (x.simulate && req.side === 'sell' && calls.length > 1) {
      const allowance = await (x.client as ReturnType<typeof createPublicClient>)
        .readContract({ address: req.token, abi: erc20Abi, functionName: 'allowance', args: [req.trader, curve.curve] })
        .catch(() => 0n);
      if (allowance >= req.amountIn) calls = calls.filter((k) => k.label !== 'approve token for the curve');
    }
    const swap = calls.find((k) => k.label === 'swap')!;
    const approvals = calls.filter((k) => k !== swap).map((k) => ({ kind: 'curve', token: req.token, spender: curve.curve, amount: maxUint256.toString(), tx: unsigned(k) }));
    await recordCurveBuild(sql, m, t, curve.curve);
    const feeCall = fee > 0n ? curveFeeCall(resolveConfig(), fee) : null;
    return c.json(
      {
        tx: unsigned(swap),
        approvals,
        followUp: feeCall ? { kind: 'rushr_fee', amount: fee.toString(), tx: unsigned(feeCall), after: 'tx', report: 'POST /v1/agents/me/fees' } : null,
        deadline: null,
        quote,
        simulation: curveSimulation(t, x.simulate),
        safety,
        honeypotCheck,
        warnings: [...t.warnings.filter((w) => !w.startsWith('Pre-send simulation unavailable')), feeNote],
        note: 'Unsigned. Send each approvals[i].tx, then tx, and wait for its receipt; then send followUp.tx (the Rushr fee) and report its hash with POST /v1/agents/me/fees. An unpaid fee blocks further builds. Rushr never signs or sends for you.',
      },
      200,
      PRIVATE,
    );
  } catch (e) {
    if (isTradeError(e)) {
      if (isInsufficientFunds(e.message)) throw fail(422, 'insufficient_funds', 'Not enough ETH in the wallet for this trade and gas.');
      throw fail(422, `trade_${e.code}`, e.message);
    }
    throw e;
  }
}

/**
 * A curve priced in another token (e.g. AMC priced in ANT): two trades from the agent's wallet, ETH ->
 * pair token on Uniswap (the Rushr fee inside that swap, in ETH) and pair token -> token on the curve, or
 * the reverse for sells. Returned as ordered `steps`; nothing follows them (no follow-up fee).
 */
function pairCurveResponse(
  c: C,
  t: QuickTrade,
  x: { req: SwapReq; mode: 'quote' | 'build'; safety: Safety; acceptRisk: unknown; acceptImpact: boolean; simulate: boolean },
) {
  const { req, mode, safety } = x;
  const q = t.quote!;
  const legs = t.pairLegs!;
  const honeypotCheck: HoneypotCheck | null = req.side === 'buy' ? { checked: 'exempt', buyTaxBps: null, sellTaxBps: null, roundTripBps: null } : null;
  const impactBps = q.priceImpactBps;
  const impactOk = x.acceptImpact || impactBps == null || impactBps <= MAX_IMPACT_BPS;
  const quote = toJsonSafe({ ...q, request: { ...q.request, source: req.source } }) as Record<string, unknown>;
  const kindOf = (i: number) => (i === legs.firstLeg || i === legs.secondLeg ? (t.calls[i]!.label === 'swap' ? 'swap' : 'curve') : 'approve');
  const route = {
    kind: 'pair-curve',
    pairToken: legs.pairToken,
    pairSymbol: legs.pairSymbol,
    pairDecimals: legs.pairDecimals,
    path: legs.path,
    curve: legs.curve.curve,
    /** Pair token expected between the two trades, and the minimum the second one spends as built. */
    pairAmount: legs.pairAmount.toString(),
    minPairAmount: legs.minPairAmount.toString(),
    swapStep: (t.calls[legs.firstLeg]!.label === 'swap' ? legs.firstLeg : legs.secondLeg) + 1,
    curveStep: (t.calls[legs.firstLeg]!.label === 'swap' ? legs.secondLeg : legs.firstLeg) + 1,
  };
  const twoTrades = req.side === 'buy'
    ? `Two trades: ETH → ${legs.pairSymbol} on Uniswap (Rushr fee inside that swap), then ${legs.pairSymbol} → token on the bonding curve.`
    : `Two trades: token → ${legs.pairSymbol} on the bonding curve, then ${legs.pairSymbol} → ETH on Uniswap (Rushr fee inside that swap).`;
  const warnings = [...t.warnings.filter((w) => !w.startsWith('Pre-send simulation unavailable') && !w.startsWith('Two trades:')), twoTrades];
  if (mode === 'quote') {
    return c.json({ quote, alternatives: [], route, safety, honeypotCheck, warnings, deadlineSeconds: resolveConfig().deadlineSeconds, followUpFee: null, wouldBuild: safetyAllows(req.side, safety, x.acceptRisk) && impactOk }, 200, PRIVATE);
  }
  if (!impactOk) {
    throw fail(422, 'high_price_impact', `Price impact is ${(impactBps! / 100).toFixed(1)}% (over ${MAX_IMPACT_BPS / 100}%). Check your amountIn units; pass "acceptImpact": true to build it anyway.`, { priceImpactBps: impactBps });
  }
  const steps = t.calls.map((k, i) => ({ step: i + 1, kind: kindOf(i), label: k.label, tx: unsigned(k) }));
  return c.json(
    {
      tx: null,
      steps,
      approvals: [],
      route,
      followUp: null,
      deadline: legs.deadline.toString(),
      quote,
      simulation: curveSimulation(t, x.simulate),
      safety,
      honeypotCheck,
      warnings,
      note:
        `Unsigned. Send steps[i].tx in order from your registered wallet, waiting for each receipt; the swap step must land before the deadline. ` +
        `The second trade spends the guaranteed minimum of ${legs.pairSymbol} (route.minPairAmount); anything above it stays in your wallet. ` +
        `If the second trade fails you hold the ${legs.pairSymbol}: retry that step or sell it. ` +
        `Record the trade with POST /v1/trades { txHash: <swap step hash>, curveTxHash: <curve step hash>, pairRoute: true }. Rushr never signs or sends for you.`,
    },
    200,
    PRIVATE,
  );
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

/** Curve-trade fees: what's owed, paid and overdue, with a ready-to-send transfer for the rest. */
agents.get('/agents/me/fees', async (c) => {
  const m = requireMember(c, { kind: 'agent' });
  return c.json({ fees: feeView(await settledFeeStatus(c.var.sql, c.env.RPC_URL, m)) }, 200, PRIVATE);
});

/** `{ txHash }` of a fee transfer to the treasury: checked on-chain, then counted toward what's owed. */
agents.post('/agents/me/fees', async (c) => {
  const m = requireMember(c, { kind: 'agent', scope: 'trade' });
  const b = (c.var.body ?? {}) as { txHash?: unknown };
  const txHash = typeof b.txHash === 'string' ? b.txHash.toLowerCase() : '';
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw fail(422, 'invalid_field', 'txHash must be a 32-byte hex hash.', { field: 'txHash' });
  await limit(c, 'write');
  const r = await reportFeePayment(c.var.sql, c.env.RPC_URL, m, txHash);
  // Already counted for you (an earlier report, or the treasury's SafeReceived log): nothing new to record.
  return c.json({ recorded: r.alreadyCounted ? '0' : r.value.toString(), alreadyCounted: r.alreadyCounted, fees: feeView(await settledFeeStatus(c.var.sql, c.env.RPC_URL, m)) }, r.alreadyCounted ? 200 : 201, PRIVATE);
});
