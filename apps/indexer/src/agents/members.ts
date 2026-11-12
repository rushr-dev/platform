// Members: humans sign up with Privy (trading wallet = Privy embedded wallet); public profiles.
import { Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { checkHandle } from '@rushr/agents/guard';
import { newMemberId } from '@rushr/agents/crypto';
import { on } from './env';
import { fail, httpsUrl, isAddr, limit, memberColumns, privyProfile, publicCache, PRIVATE, requireMember, str, type Ctx, type MemberRow } from './http';

export function publicMember(m: MemberRow, owner?: { id: string; handle: string } | null) {
  return {
    id: m.id,
    handle: m.handle,
    kind: m.kind,
    origin: m.origin,
    displayName: m.display_name,
    bio: m.bio,
    avatarUrl: m.avatar_url,
    x: m.x_username ? { username: m.x_username, verified: m.x_verified } : null,
    wallet: m.wallet,
    owner: owner ?? null,
    followers: m.followers,
    following: m.following,
    createdAt: m.created_at,
  };
}

export async function memberByRef(sql: Sql, ref: string): Promise<MemberRow | null> {
  const r = ref.toLowerCase().replace(/^@/, '');
  const where = isAddr(r) ? 'wallet = $1' : r.startsWith('m_') ? 'id = $1' : 'lower(handle) = $1';
  const [m] = await sql.unsafe<MemberRow[]>(`select ${memberColumns} from members where ${where} and status = 'active'`, [r]);
  return m ?? null;
}

async function ownerOf(sql: Sql, m: MemberRow) {
  if (!m.owner_id) return null;
  const [o] = await sql<{ id: string; handle: string }[]>`select id, handle from members where id = ${m.owner_id} and status = 'active'`;
  return o ?? null;
}

async function handleFree(sql: Sql, handle: string, exceptId?: string) {
  const [row] = await sql<{ id: string }[]>`select id from members where lower(handle) = ${handle}`;
  return !row || row.id === exceptId;
}

/** Invite codes: A-Z, 0-9 and dash, 4-32 chars, matched case-insensitively (stored uppercase). */
export function normalizeInvite(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9-]{4,32}$/.test(code) ? code : null;
}

export type InviteStatus = 'valid' | 'used' | 'expired' | 'revoked' | 'unknown';

export async function inviteStatus(sql: Sql | TransactionSql, code: string): Promise<InviteStatus> {
  const [row] = await sql<{ used_at: Date | null; revoked_at: Date | null; expires_at: Date | null }[]>`
    select used_at, revoked_at, expires_at from invite_codes where code = ${code}`;
  if (!row) return 'unknown';
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return 'expired';
  return 'valid';
}

export const members = new Hono<Ctx>();

/** Check a code before sign-up (the landing passes ?invite=). Doesn't claim it. */
members.get('/invites/:code', async (c) => {
  await limit(c, 'nonce');
  const code = normalizeInvite(c.req.param('code'));
  const status: InviteStatus = code ? await inviteStatus(c.var.sql, code) : 'unknown';
  return c.json({ code, valid: status === 'valid', status, invitesRequired: on(c.env.INVITES_REQUIRED) }, 200, PRIVATE);
});

members.get('/me', async (c) => {
  const v = c.var.viewer;
  if (!v.member) {
    if (v.privyDid) {
      return c.json({ error: { code: 'not_registered', message: 'Finish sign-up with POST /v1/me.', invitesRequired: on(c.env.INVITES_REQUIRED) } }, 404, PRIVATE);
    }
    requireMember(c);
  }
  const m = v.member!;
  return c.json({ member: publicMember(m, await ownerOf(c.var.sql, m)) }, 200, PRIVATE);
});

/** Human sign-up: `{ handle, inviteCode?, displayName?, bio? }` with a Privy token. */
members.post('/me', async (c) => {
  const v = c.var.viewer;
  if (v.member) throw fail(409, 'already_registered', 'You already have an account.');
  if (!v.privyDid || v.keyId) throw fail(401, 'unauthorized', 'Sign in with Privy first.');
  await limit(c, 'register');
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const h = checkHandle(b.handle);
  if (!h.ok) throw fail(422, h.error, h.error === 'handle_reserved' ? 'That handle is reserved.' : 'Handles are 3-20 characters: a-z, 0-9 and _.');
  const displayName = str(b.displayName, 40, 'displayName');
  const bio = str(b.bio, 280, 'bio');
  const sql = c.var.sql;
  if (!(await handleFree(sql, h.handle))) throw fail(409, 'handle_taken', 'That handle is taken.');

  const profile = await privyProfile(c, v.privyDid);
  if (!profile.wallet) throw fail(422, 'no_embedded_wallet', 'Your Privy account has no embedded wallet yet. Create one, then try again.');
  const id = newMemberId();
  const inviteRequired = on(c.env.INVITES_REQUIRED);
  const code = normalizeInvite(b.inviteCode);
  if (inviteRequired && !code) {
    throw fail(403, b.inviteCode ? 'invite_invalid' : 'invite_required', b.inviteCode ? 'That invite code is not valid.' : 'Rushr is invite-only during the beta. Enter an invite code.');
  }

  const member = await sql.begin(async (tx) => {
    let claimedCode: string | null = null;
    if (code) {
      // One code, one human sign-up: claim it in the same transaction as the account.
      const [claimed] = await tx<{ code: string }[]>`
        update invite_codes set used_at = now()
        where code = ${code} and used_at is null and revoked_at is null and (expires_at is null or expires_at > now())
        returning code`;
      if (claimed) claimedCode = claimed.code;
      else if (inviteRequired) {
        const status = await inviteStatus(tx, code);
        throw fail(403, status === 'used' ? 'invite_used' : 'invite_invalid', status === 'used' ? 'That invite code has already been used.' : 'That invite code is not valid.', { inviteStatus: status });
      }
    }
    const [taken] = await tx<{ id: string }[]>`select id from members where wallet = ${profile.wallet}`;
    if (taken) throw fail(409, 'wallet_taken', 'This wallet already belongs to another account.');
    const [row] = await tx.unsafe<MemberRow[]>(
      `insert into members (id, kind, handle, wallet, privy_did, display_name, bio, avatar_url, x_username, x_verified, invite_code)
       values ($1, 'human', $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${memberColumns}`,
      [id, h.handle, profile.wallet, v.privyDid!, displayName, bio, profile.xAvatarUrl, profile.xUsername, Boolean(profile.xUsername), claimedCode],
    );
    if (claimedCode) await tx`update invite_codes set used_by = ${id} where code = ${claimedCode}`;
    await tx`insert into member_events (member_id, type, data) values (${id}, 'signup', ${tx.json({ invite: claimedCode })})`;
    return row!;
  });
  return c.json({ member: publicMember(member) }, 201, PRIVATE);
});

/** Edit your profile: `{ handle?, displayName?, bio?, avatarUrl? }`. */
members.patch('/me', async (c) => {
  const m = requireMember(c, { scope: 'profile' });
  await limit(c, 'write');
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const sql = c.var.sql;
  const set: Record<string, unknown> = {};
  if ('handle' in b) {
    const h = checkHandle(b.handle);
    if (!h.ok) throw fail(422, h.error, 'Handles are 3-20 characters: a-z, 0-9 and _.');
    if (!(await handleFree(sql, h.handle, m.id))) throw fail(409, 'handle_taken', 'That handle is taken.');
    set.handle = h.handle;
  }
  if ('displayName' in b) set.display_name = str(b.displayName, 40, 'displayName');
  if ('bio' in b) set.bio = str(b.bio, 280, 'bio');
  if ('avatarUrl' in b) set.avatar_url = httpsUrl(b.avatarUrl, 'avatarUrl');
  if (Object.keys(set).length === 0) throw fail(422, 'nothing_to_update', 'Send at least one field.');
  const [row] = await sql.unsafe<MemberRow[]>(
    `update members set ${Object.keys(set).map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning ${memberColumns}`,
    [m.id, ...Object.values(set)] as never[],
  );
  return c.json({ member: publicMember(row!, await ownerOf(sql, row!)) }, 200, PRIVATE);
});

/** Re-read the X account linked in Privy (link or unlink it in the Privy modal first). */
members.post('/me/x/sync', async (c) => {
  const m = requireMember(c, { kind: 'human' });
  await limit(c, 'write');
  const p = await privyProfile(c, m.privy_did!);
  const [row] = await c.var.sql.unsafe<MemberRow[]>(
    `update members set x_username = $2, x_verified = $3, avatar_url = coalesce(avatar_url, $4), updated_at = now() where id = $1 returning ${memberColumns}`,
    [m.id, p.xUsername, Boolean(p.xUsername), p.xAvatarUrl],
  );
  return c.json({ member: publicMember(row!) }, 200, PRIVATE);
});

members.get('/handles/:handle', async (c) => {
  const h = checkHandle(c.req.param('handle'));
  if (!h.ok) return c.json({ handle: c.req.param('handle'), available: false, reason: h.error }, 200, PRIVATE);
  return c.json({ handle: h.handle, available: await handleFree(c.var.sql, h.handle) }, 200, PRIVATE);
});

/** Public profile by handle, member id or wallet address. */
members.get('/members/:ref', async (c) => {
  const m = await memberByRef(c.var.sql, c.req.param('ref'));
  if (!m) throw fail(404, 'not_found', 'No such member.');
  const sql = c.var.sql;
  const agents = m.kind === 'human'
    ? await sql<{ id: string; handle: string }[]>`select id, handle from members where owner_id = ${m.id} and status = 'active' order by created_at`
    : [];
  const [{ callouts } = { callouts: 0 }] = await sql<{ callouts: number }[]>`
    select count(*)::int as callouts from callouts where author_id = ${m.id} and deleted_at is null and hidden_at is null`;
  return c.json({ member: { ...publicMember(m, await ownerOf(sql, m)), agents, callouts } }, 200, publicCache(10));
});
