import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryR2, pgAvailable, setup } from './harness';
import { sniffImage } from '../src/agents/media';
import { resetSuggestionMemo } from '../src/agents/board';

const pg = await pgAvailable();
const w = (n: number) => `0x${String(n).padStart(40, '0')}`;
const E18 = 10n ** 18n;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('sniffImage', () => {
  it('recognises raster formats and refuses everything else', () => {
    expect(sniffImage(PNG)?.type).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.type).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))?.type).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('GIF89a'))?.type).toBe('image/gif');
    expect(sniffImage(SVG)).toBeNull();
  });
});

describe.skipIf(!pg)('profiles', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const r2 = memoryR2();
  let alice: { token: string; member: { id: string } }, bob: typeof alice, carol: typeof alice;
  let n = 0;
  const swap = async (tok: string, trader: string, side: 'buy' | 'sell', usd: number) => {
    n++;
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, usd)
      values (${'0xs' + n}, ${n}, ${tok}, 'p', ${n}, now() - interval '1 hour', ${trader}, ${side}, ${(100n * E18).toString()}, '0x0', '0', ${usd})`;
  };

  beforeAll(async () => {
    t = await setup('profiles', { MEDIA_UPLOADS_ENABLED: '1', MEDIA: r2 });
    alice = await t.signup('alice', w(1));
    bob = await t.signup('bob', w(2));
    carol = await t.signup('carol', w(3));
    for (const tok of ['ta', 'tb', 'tc']) {
      await t.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, liquidity_usd)
        values (${tok}, ${tok}, ${tok}, 18, '1', '0xd', 1, now() - interval '9 days', 1, 1000000)`;
      for (let i = 0; i < 20; i++) await swap(tok, `0xcrowd${i}`, 'buy', 10);
      for (const [trader, sell] of [[w(1), 150], [w(2), 120], [w(3), 90]] as const) {
        await swap(tok, trader, 'buy', 100);
        await swap(tok, trader, 'sell', sell);
      }
    }
  });
  afterAll(async () => t?.teardown());

  it('edits banner, one-line bio and avatar URL, and shows the joined date', async () => {
    const r = await t.call('PATCH', '/me', { auth: alice.token, body: { bio: 'line one\nline two', bannerUrl: 'https://img.example/b.png', avatarUrl: 'https://img.example/a.png' } });
    expect(r.json.member).toMatchObject({ bio: 'line one line two', bannerUrl: 'https://img.example/b.png', avatarUrl: 'https://img.example/a.png' });
    expect(r.json.member.joinedAt).toBe(r.json.member.createdAt);
    expect((await t.call('PATCH', '/me', { auth: alice.token, body: { bio: 'x'.repeat(161) } })).json.error.code).toBe('invalid_field');
    expect((await t.call('PATCH', '/me', { auth: alice.token, body: { bannerUrl: 'http://img.example/b.png' } })).json.error.code).toBe('invalid_field');
    expect((await t.call('GET', '/members/alice')).json.member.bannerUrl).toBe('https://img.example/b.png');
  });

  it('uploads avatar and banner to R2, sniffing the type, and serves them', async () => {
    const up = await t.call('POST', '/me/avatar', { auth: alice.token, body: PNG, headers: { 'content-type': 'image/png' } });
    expect(up.status).toBe(201);
    expect(up.json.member.avatarUrl).toBe(up.json.url);
    const path = new URL(String(up.json.url)).pathname.replace(/^\/v1/, '');
    const { v1 } = await import('../src/agents/app');
    const res = await v1.request(path, {}, t.env);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // A second upload replaces the first object.
    await t.call('POST', '/me/avatar', { auth: alice.token, body: PNG, headers: { 'content-type': 'image/png' } });
    expect([...r2.objects.keys()].filter((k) => k.startsWith(`avatar/${alice.member.id}/`))).toHaveLength(1);

    expect((await t.call('POST', '/me/banner', { auth: alice.token, body: SVG, headers: { 'content-type': 'image/svg+xml' } })).json.error.code).toBe('unsupported_image');
    expect((await t.call('POST', '/me/avatar', { auth: alice.token, body: new Uint8Array(1_000_001), headers: { 'content-type': 'image/png' } })).json.error.code).toBe('too_large');
    expect((await t.call('POST', '/me/banner', { body: PNG, headers: { 'content-type': 'image/png' } })).status).toBe(401);
    const off = await v1.request('/me/avatar', { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'image/png' }, body: PNG }, { ...t.env, MEDIA_UPLOADS_ENABLED: '' });
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe('feature_disabled');
  });

  it('tells the viewer whether they follow a member and are followed back', async () => {
    await t.call('POST', '/follows/alice', { auth: bob.token });
    expect((await t.call('GET', '/me/relationship/alice', { auth: bob.token })).json).toMatchObject({ self: false, following: true, followedBy: false });
    expect((await t.call('GET', '/me/relationship/bob', { auth: alice.token })).json).toMatchObject({ following: false, followedBy: true });
    expect((await t.call('GET', '/me/relationship/alice', { auth: alice.token })).json.self).toBe(true);
  });

  it('suggests top traders by score, excluding me and who I follow', async () => {
    resetSuggestionMemo();
    const pub = await t.call('GET', '/suggestions');
    expect(pub.json.window).toBe('30d');
    expect(pub.json.items.map((i) => i.member.handle)).toEqual(['alice', 'bob']); // carol is negative
    expect(pub.json.items[0]).toMatchObject({ rank: 1, score: 150, followers: 1, member: { kind: 'human' } });
    const forBob = await t.call('GET', '/me/suggestions', { auth: bob.token });
    expect(forBob.json.items.map((i) => i.member.handle)).toEqual([]);
    const forCarol = await t.call('GET', '/me/suggestions?limit=1', { auth: carol.token });
    expect(forCarol.json.items.map((i) => i.member.handle)).toEqual(['alice']);
  });
});
