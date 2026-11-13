import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, setup } from './harness';

const pg = await pgAvailable();
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe.skipIf(!pg)('beta gate: one shared code, N seats', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let n = 0;
  /** A fresh Privy user trying to sign up with `code`. */
  const attempt = async (code: string) => {
    n++;
    const tok = await t.human(`did:privy:u${n}`, w(1000 + n));
    return t.call('POST', '/me', { auth: tok, body: { handle: `user_${n}`, inviteCode: code } });
  };

  beforeAll(async () => {
    t = await setup('gate', { INVITES_REQUIRED: '1' });
  });
  afterAll(async () => t?.teardown());

  it('shows a closed counter until a public code exists', async () => {
    expect((await t.call('GET', '/beta')).json).toMatchObject({ open: false, seats: 0, taken: 0, left: 0, invitesRequired: true });
  });

  it('creates one named shared public code', async () => {
    const r = await t.admin('POST', '/invites', { code: 'testcode', maxUses: 50, batch: 'x-drop-1', note: 'shared code', public: true });
    expect(r.status).toBe(201);
    expect(r.json.invite).toMatchObject({ code: 'TESTCODE', max_uses: 50, uses: 0, public: true });
    expect((await t.admin('POST', '/invites', { code: 'TESTCODE', maxUses: 5, batch: 'dup' })).json.error.code).toBe('code_taken');
    const beta = await t.call('GET', '/beta');
    expect(beta.json).toMatchObject({ open: true, seats: 50, taken: 0, left: 50 });
    expect(JSON.stringify(beta.json)).not.toContain('TESTCODE');
    expect(beta.headers.get('cache-control')).toContain('s-maxage=10');
  });

  it('seats 50 sign-ups, gives the last seat to exactly one of two concurrent claims, and refuses the 51st', async () => {
    for (let i = 0; i < 48; i++) expect((await attempt(i % 2 ? 'testcode' : 'TESTCODE')).status).toBe(201);
    expect((await t.call('GET', '/beta')).json).toMatchObject({ taken: 48, left: 2 });
    expect((await attempt('TESTCODE')).status).toBe(201); // 49
    // Two sign-ups race for seat 50.
    const [a, b] = await Promise.all([attempt('TESTCODE'), attempt('TESTCODE')]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect([a, b].find((r) => r.status === 403)!.json.error).toMatchObject({
      code: 'invite_full',
      message: 'All beta seats are taken. Follow @rushrtrade for the next drop.',
      inviteStatus: 'full',
    });
    const late = await attempt('TESTCODE');
    expect(late.json.error.code).toBe('invite_full');
    const [{ uses, members } = { uses: 0, members: 0 }] = await t.sql<{ uses: number; members: number }[]>`
      select (select uses from invite_codes where code = 'TESTCODE') as uses,
             (select count(*)::int from members where invite_code = 'TESTCODE') as members`;
    expect({ uses, members }).toEqual({ uses: 50, members: 50 });
    const [first] = await t.sql`select m.handle from invite_codes i join members m on m.id = i.used_by where i.code = 'TESTCODE'`;
    expect(first!.handle).toBe('user_1');
  });

  it('reports the full status and a closed counter', async () => {
    expect((await t.call('GET', '/invites/testcode')).json).toMatchObject({ valid: false, status: 'full', message: 'All beta seats are taken. Follow @rushrtrade for the next drop.' });
    expect((await t.call('GET', '/beta')).json).toMatchObject({ open: false, seats: 50, taken: 50, left: 0 });
  });

  it('a failed sign-up gives its seat back', async () => {
    await t.admin('PATCH', '/invites/TESTCODE', { maxUses: 51 });
    expect((await t.admin('PATCH', '/invites/TESTCODE', { maxUses: 10 })).json.error.code).toBe('invalid_field');
    const tok = await t.human('did:privy:dupwallet', w(1001)); // wallet already used by user_1
    expect((await t.call('POST', '/me', { auth: tok, body: { handle: 'dupwallet', inviteCode: 'TESTCODE' } })).json.error.code).toBe('wallet_taken');
    expect((await t.call('GET', '/beta')).json).toMatchObject({ open: true, left: 1 });
    expect((await attempt('TESTCODE')).status).toBe(201);
    expect((await t.call('GET', '/beta')).json).toMatchObject({ open: false, left: 0, seats: 51 });
  });

  it('keeps single-use personal codes working unchanged', async () => {
    const batch = await t.admin('POST', '/invites', { batch: 'personal', count: 1 });
    const code = batch.json.codes[0]!;
    expect((await attempt(code)).status).toBe(201);
    const again = await attempt(code);
    expect(again.json.error).toMatchObject({ code: 'invite_used', inviteStatus: 'used' });
    expect((await t.call('GET', `/invites/${code}`)).json.status).toBe('used');
    const list = await t.admin('GET', '/invites');
    expect(list.json.invites.find((i) => i.code === 'TESTCODE')).toMatchObject({ uses: 51, max_uses: 51, public: true });
  });

  it('revoking the shared code closes the counter', async () => {
    await t.admin('PATCH', '/invites/TESTCODE', { maxUses: 60 });
    expect((await t.call('GET', '/beta')).json.left).toBe(9);
    expect((await t.admin('POST', '/invites/TESTCODE/revoke')).json.revoked).toBe(true);
    expect((await t.call('GET', '/beta')).json).toMatchObject({ open: false, left: 0 });
    expect((await attempt('TESTCODE')).json.error).toMatchObject({ code: 'invite_invalid', inviteStatus: 'revoked' });
  });
});
