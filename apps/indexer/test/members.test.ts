import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, setup } from './harness';

const pg = await pgAvailable();
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';

describe.skipIf(!pg)('members (Privy)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    t = await setup('members', { INVITES_REQUIRED: '1' });
    await t.sql`insert into invite_codes (code, batch) values ('BETA-ONE', 'b1'), ('BETA-TWO', 'b1')`;
  });
  afterAll(async () => t?.teardown());

  it('rejects bad tokens', async () => {
    expect((await t.call('GET', '/me')).status).toBe(401);
    expect((await t.call('GET', '/me', { auth: 'a.b.c' })).json.error.code).toBe('token_malformed');
    expect((await t.call('GET', '/me', { auth: await t.token('did:privy:x', { expIn: -10 }) })).json.error.code).toBe('token_expired');
    expect((await t.call('GET', '/me', { auth: await t.token('did:privy:x', { aud: 'other' }) })).json.error.code).toBe('token_claims');
    const tok = await t.token('did:privy:x');
    expect((await t.call('GET', '/me', { auth: tok.slice(0, -4) + 'AAAA' })).json.error.code).toBe('token_signature');
    expect((await t.call('GET', '/me', { auth: tok, headers: { origin: 'https://evil.example' } })).json.error.code).toBe('bad_origin');
  });

  it('signs a human up with an invite, using the Privy embedded wallet and X account', async () => {
    const tok = await t.human('did:privy:alice', W1.toUpperCase().replace('0X', '0x'), 'alice_x');
    const before = await t.call('GET', '/me', { auth: tok });
    expect(before.status).toBe(404);
    expect(before.json.error).toMatchObject({ code: 'not_registered', invitesRequired: true });
    expect((await t.call('POST', '/me', { auth: tok, body: { handle: 'alice' } })).json.error.code).toBe('invite_required');
    expect((await t.call('POST', '/me', { auth: tok, body: { handle: 'alice', inviteCode: 'NOPE' } })).json.error.code).toBe('invite_invalid');
    const r = await t.call('POST', '/me', { auth: tok, body: { handle: 'Alice', inviteCode: 'beta-one', bio: 'gm' } });
    expect(r.status).toBe(201);
    expect(r.json.member).toMatchObject({ handle: 'alice', kind: 'human', wallet: W1, bio: 'gm', x: { username: 'alice_x', verified: true } });
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await t.call('GET', '/me', { auth: tok })).json.member.handle).toBe('alice');
    expect((await t.call('POST', '/me', { auth: tok, body: { handle: 'alice2', inviteCode: 'BETA-TWO' } })).json.error.code).toBe('already_registered');
    const [code] = await t.sql`select used_by from invite_codes where code = 'BETA-ONE'`;
    expect(code!.used_by).toBe(r.json.member.id);
  });

  it('enforces one code per sign-up, unique handles and wallets', async () => {
    const bob = await t.human('did:privy:bob', W2);
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'bob', inviteCode: 'BETA-ONE' } })).json.error.code).toBe('invite_used');
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'ALICE', inviteCode: 'BETA-TWO' } })).json.error.code).toBe('handle_taken');
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'admin', inviteCode: 'BETA-TWO' } })).json.error.code).toBe('handle_reserved');
    const dup = await t.human('did:privy:dup', W1);
    expect((await t.call('POST', '/me', { auth: dup, body: { handle: 'dupe', inviteCode: 'BETA-TWO' } })).json.error.code).toBe('wallet_taken');
    // The failed attempt must not have burned the code.
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'bob', inviteCode: 'BETA-TWO' } })).status).toBe(201);
  });

  it('edits the profile and serves it publicly', async () => {
    const tok = await t.token('did:privy:alice');
    const r = await t.call('PATCH', '/me', { auth: tok, body: { displayName: 'Alice', avatarUrl: 'https://img.example/a.png' } });
    expect(r.json.member).toMatchObject({ displayName: 'Alice', avatarUrl: 'https://img.example/a.png' });
    expect((await t.call('PATCH', '/me', { auth: tok, body: { avatarUrl: 'javascript:alert(1)' } })).json.error.code).toBe('invalid_field');
    expect((await t.call('PATCH', '/me', { auth: tok, body: { handle: 'bob' } })).json.error.code).toBe('handle_taken');
    const pub = await t.call('GET', '/members/alice');
    expect(pub.json.member).toMatchObject({ handle: 'alice', displayName: 'Alice', callouts: 0, agents: [] });
    expect(pub.headers.get('cache-control')).toContain('s-maxage');
    expect((await t.call('GET', `/members/${W1}`)).json.member.handle).toBe('alice');
    expect((await t.call('GET', '/handles/carol')).json).toEqual({ handle: 'carol', available: true });
  });

  it('refuses anything that looks like a key', async () => {
    const tok = await t.token('did:privy:alice');
    const r = await t.call('PATCH', '/me', { auth: tok, body: { bio: 'x', privateKey: '0x' + '1'.repeat(64) } });
    expect(r.json.error.code).toBe('never_send_keys');
  });

  it('limits sign-up attempts per IP', async () => {
    const tok = await t.human('did:privy:spam', '0x3333333333333333333333333333333333333333');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await t.call('POST', '/me', { auth: tok, body: { handle: 'x' }, headers: { 'cf-connecting-ip': '10.9.9.9' } })).status);
    }
    expect(codes.slice(0, 5).every((s) => s === 422)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it('is off without the flag', async () => {
    const { v1 } = await import('../src/agents/app');
    const res = await v1.request('/members/alice', {}, { ...t.env, AGENTS_ENABLED: '' });
    expect(res.status).toBe(404);
  });
});

describe('allowed origins', async () => {
  const { allowedOrigin } = await import('../src/agents/http');
  it('allows rushr.trade and www, local dev only on a local API', () => {
    const prod = 'https://api.rushr.trade/v1/me';
    expect(allowedOrigin('https://rushr.trade', prod)).toBe(true);
    expect(allowedOrigin('https://app.rushr.trade', prod)).toBe(true);
    expect(allowedOrigin('https://www.rushr.trade', prod)).toBe(true);
    expect(allowedOrigin(undefined, prod)).toBe(true);
    expect(allowedOrigin('http://localhost:3010', prod)).toBe(false);
    expect(allowedOrigin('https://evil.example', prod)).toBe(false);
    expect(allowedOrigin('https://rushr.trade.evil.example', prod)).toBe(false);
    expect(allowedOrigin('http://localhost:3010', 'http://localhost:8788/v1/me')).toBe(true);
    expect(allowedOrigin('http://evil.localhost:3010', 'http://localhost:8788/v1/me')).toBe(false);
    expect(allowedOrigin('https://staging.rushr.trade', prod, 'https://staging.rushr.trade')).toBe(true);
  });
});
