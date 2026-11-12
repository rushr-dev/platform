import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, setup } from './harness';

const pg = await pgAvailable();
const w = (n: number) => `0x${String(n).padStart(40, '0')}`;

describe.skipIf(!pg)('beta: invites and feedback', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    t = await setup('beta', { INVITES_REQUIRED: '1' });
  });
  afterAll(async () => t?.teardown());

  it('creates batches, checks codes case-insensitively and uses each once', async () => {
    const batch = await t.admin('POST', '/invites', { batch: 'kols-1', count: 3, prefix: 'kol' });
    expect(batch.status).toBe(201);
    expect(batch.json.codes).toHaveLength(3);
    for (const code of batch.json.codes) expect(code).toMatch(/^KOL-[A-Z2-9]{8}$/);
    const [a, b, cc] = batch.json.codes as string[];

    expect((await t.call('GET', `/invites/${a!.toLowerCase()}`)).json).toMatchObject({ code: a, valid: true, status: 'valid', invitesRequired: true });
    expect((await t.call('GET', '/invites/NOPE-NOPE')).json).toMatchObject({ valid: false, status: 'unknown' });
    expect((await t.call('GET', '/invites/bad!code')).json).toMatchObject({ valid: false, code: null });

    const alice = await t.human('did:privy:alice', w(1));
    expect((await t.call('POST', '/me', { auth: alice, body: { handle: 'alice', inviteCode: 'bad!code' } })).json.error.code).toBe('invite_invalid');
    expect((await t.call('POST', '/me', { auth: alice, body: { handle: 'alice', inviteCode: ` ${a!.toLowerCase()} ` } })).status).toBe(201);
    expect((await t.call('GET', `/invites/${a}`)).json.status).toBe('used');

    const bob = await t.human('did:privy:bob', w(2));
    const used = await t.call('POST', '/me', { auth: bob, body: { handle: 'bob', inviteCode: a } });
    expect(used.json.error).toMatchObject({ code: 'invite_used', inviteStatus: 'used' });
    expect((await t.admin('POST', `/invites/${b}/revoke`)).json.revoked).toBe(true);
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'bob', inviteCode: b } })).json.error).toMatchObject({ code: 'invite_invalid', inviteStatus: 'revoked' });
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'bob', inviteCode: cc } })).status).toBe(201);

    const list = await t.admin('GET', '/invites?batch=kols-1');
    expect(list.json).toMatchObject({ total: 3, used: 2 });
    expect(list.json.invites.find((i) => i.code === a).used_by).toBe('alice');
  });

  it('records first-touch referrals by the referrer handle, once', async () => {
    const batch = await t.admin('POST', '/invites', { batch: 'ref', count: 2 });
    expect((await t.call('GET', '/referrals/ALICE')).json).toMatchObject({ valid: true, referrer: { handle: 'alice' } });
    expect((await t.call('GET', '/referrals/nobody_here')).json.valid).toBe(false);
    const carol = await t.human('did:privy:carol', w(3));
    const r = await t.call('POST', '/me', { auth: carol, body: { handle: 'carol', inviteCode: batch.json.codes[0], referralCode: '@Alice' } });
    expect(r.status).toBe(201);
    expect(r.json.referral).toMatchObject({ referrer: { handle: 'alice' }, code: 'alice' });
    const [row] = await t.sql`select referee, referrer, code from referrals where referee = ${w(3)}`;
    expect(row).toMatchObject({ referee: w(3), referrer: w(1), code: 'alice' });
    const { referralFor } = await import('../src/agents/referrals');
    expect(await referralFor(t.sql, w(3).toUpperCase().replace('0X', '0x'))).toEqual({ referrer: w(1), code: 'alice' });
    expect(await referralFor(t.sql, w(1))).toBeNull();
    // Unknown codes don't block sign-up.
    const dan = await t.human('did:privy:dan', w(4));
    const d = await t.call('POST', '/me', { auth: dan, body: { handle: 'dan', inviteCode: batch.json.codes[1], referralCode: 'ghost' } });
    expect(d.status).toBe(201);
    expect(d.json.referral).toBeNull();
  });

  it('expires codes', async () => {
    const batch = await t.admin('POST', '/invites', { batch: 'old', count: 1, expiresAt: '2020-01-01T00:00:00Z' });
    expect((await t.call('GET', `/invites/${batch.json.codes[0]}`)).json.status).toBe('expired');
  });

  it('stores feedback from members and anonymous visitors', async () => {
    const tok = await t.token('did:privy:alice');
    expect((await t.call('POST', '/feedback', { auth: tok, body: { message: 'the chart is slow', page: '/token/0xabc' } })).status).toBe(201);
    expect((await t.call('POST', '/feedback', { body: { message: 'love it' } })).status).toBe(201);
    expect((await t.call('POST', '/feedback', { body: { message: '' } })).json.error.code).toBe('invalid_field');
    const fb = await t.admin('GET', '/feedback');
    expect(fb.json.feedback.map((f) => [f.message, f.handle, f.page])).toEqual([['love it', null, null], ['the chart is slow', 'alice', '/token/0xabc']]);
  });
});
