import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, setup } from './harness';

const pg = await pgAvailable();
const TOKEN = '0x00000000000000000000000000000000000000aa';
const w = (n: number) => `0x${String(n).padStart(40, '0')}`;

describe.skipIf(!pg)('social', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let alice: { token: string; member: { id: string } }, bob: typeof alice, carol: typeof alice, dave: typeof alice;
  beforeAll(async () => {
    t = await setup('social');
    alice = await t.signup('alice', w(1));
    bob = await t.signup('bob', w(2));
    carol = await t.signup('carol', w(3));
    dave = await t.signup('dave', w(4));
    await t.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, market_cap_usd)
      values (${TOKEN}, 'Pons', 'PONS', 18, '1000', '0xdev', 1, now() - interval '2 days', 2, 2000000)`;
    // alice bought 1h ago at $1; then a later price peak of $3.
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, price_usd, usd)
      values ('0xentry', 0, ${TOKEN}, 'p', 1, now() - interval '1 hour', ${w(1)}, 'buy', '100', '0x0', '1', 1, 100)`;
  });
  afterAll(async () => t?.teardown());

  it('follows and unfollows, keeping counters', async () => {
    expect((await t.call('POST', '/follows/alice', { auth: bob.token })).json).toEqual({ following: true });
    await t.call('POST', '/follows/alice', { auth: bob.token }); // idempotent
    await t.call('POST', '/follows/alice', { auth: carol.token });
    expect((await t.call('POST', '/follows/bob', { auth: bob.token })).json.error.code).toBe('cannot_follow_self');
    expect((await t.call('GET', '/members/alice')).json.member.followers).toBe(2);
    expect((await t.call('GET', '/members/alice/followers')).json.items.map((i) => i.handle).sort()).toEqual(['bob', 'carol']);
    expect((await t.call('GET', `/me/following?ids=${alice.member.id},${dave.member.id}`, { auth: bob.token })).json.following).toEqual([alice.member.id]);
    await t.call('DELETE', '/follows/alice', { auth: carol.token });
    expect((await t.call('GET', '/members/alice')).json.member.followers).toBe(1);
    expect((await t.call('GET', '/members/carol')).json.member.following).toBe(0);
  });

  it('posts a callout linked to the author entry trade, with the result since', async () => {
    const r = await t.call('POST', '/callouts', { auth: alice.token, body: { token: TOKEN.toUpperCase().replace('0X', '0x'), stance: 'bullish', body: 'aping $PONS, dev is based' } });
    expect(r.status).toBe(201);
    const c = r.json.callout;
    expect(c).toMatchObject({ stance: 'bullish', body: 'aping $PONS, dev is based', author: { handle: 'alice' }, token: { symbol: 'PONS' }, atPost: { priceUsd: 2, marketCapUsd: 2000000 } });
    expect(c.entry).toMatchObject({ tx: '0xentry', priceUsd: 1, usd: 100, when: 'before_post' });
    expect(c.result).toMatchObject({ priceUsd: 2, sincePostPct: 0, sinceEntryPct: 100 });
    await t.sql`update tokens set price_usd = 3 where address = ${TOKEN}`;
    const again = (await t.call('GET', `/callouts/${c.id}`)).json.callout;
    expect(again.result.sincePostPct).toBeCloseTo(50);
    expect(again.result.sinceEntryPct).toBeCloseTo(200);
  });

  it('links a buy made right after posting', async () => {
    const r = await t.call('POST', '/callouts', { auth: bob.token, body: { token: TOKEN, stance: 'bullish', body: 'calling it, buying now' } });
    expect(r.json.callout.entry).toBeNull();
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, price_usd, usd)
      values ('0xlate', 0, ${TOKEN}, 'p', 2, now() + interval '1 minute', ${w(2)}, 'buy', '10', '0x0', '1', 3, 30)`;
    const c = (await t.call('GET', `/callouts/${r.json.callout.id}`)).json.callout;
    expect(c.entry).toMatchObject({ tx: '0xlate', when: 'after_post' });
  });

  it('guards against spam', async () => {
    expect((await t.call('POST', '/callouts', { auth: alice.token, body: { token: TOKEN, body: 'aping $PONS, dev is based' } })).json.error.code).toBe('duplicate');
    expect((await t.call('POST', '/callouts', { auth: alice.token, body: { token: TOKEN, body: 'join https://scam.example now' } })).json.error.code).toBe('links_not_allowed');
    expect((await t.call('POST', '/callouts', { auth: alice.token, body: { token: TOKEN, body: 'free money at pons-airdrop.xyz' } })).json.error.code).toBe('links_not_allowed');
    expect((await t.call('POST', '/callouts', { auth: alice.token, body: { token: '0x' + 'b'.repeat(40), body: 'hm' } })).json.error.code).toBe('unknown_token');
    expect((await t.call('POST', '/callouts', { auth: alice.token, body: { token: TOKEN, body: '' } })).json.error.code).toBe('invalid_field');
    expect((await t.call('POST', '/callouts', { body: { token: TOKEN, body: 'anon' } })).status).toBe(401);
    // 10 callouts an hour.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await t.call('POST', '/callouts', { auth: dave.token, body: { token: TOKEN, body: `take ${i}` } })).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect((await t.call('POST', '/callouts', { auth: dave.token, body: { token: TOKEN, body: 'one more' } })).json.error.code).toBe('rate_limited');
  });

  it('serves the global and following feeds with cursors', async () => {
    const global = await t.call('GET', '/feed?limit=5');
    expect(global.json.items).toHaveLength(5);
    expect(global.json.next).toBeTruthy();
    const page2 = await t.call('GET', `/feed?limit=50&before=${encodeURIComponent(global.json.next)}`);
    expect(page2.json.items.length).toBe(12 - 5);
    expect(new Set([...global.json.items, ...page2.json.items].map((i) => i.id)).size).toBe(12);
    // bob follows alice: sees alice's and his own callouts, none of dave's.
    const mine = await t.call('GET', '/me/feed', { auth: bob.token });
    expect(new Set(mine.json.items.map((i) => i.author.handle))).toEqual(new Set(['alice', 'bob']));
    expect(mine.headers.get('cache-control')).toBe('private, no-store');
    expect((await t.call('GET', '/members/alice/callouts')).json.items).toHaveLength(1);
    expect((await t.call('GET', `/tokens/${TOKEN}/callouts?limit=3`)).json.items).toHaveLength(3);
  });

  it('likes and comments', async () => {
    const [first] = (await t.call('GET', '/members/alice/callouts')).json.items;
    expect((await t.call('POST', `/callouts/${first.id}/like`, { auth: bob.token })).json).toEqual({ liked: true, likes: 1 });
    expect((await t.call('POST', `/callouts/${first.id}/like`, { auth: bob.token })).json.likes).toBe(1);
    await t.call('POST', `/callouts/${first.id}/like`, { auth: carol.token });
    expect((await t.call('GET', `/me/likes?ids=${first.id}`, { auth: bob.token })).json.liked).toEqual([first.id]);
    expect((await t.call('GET', '/me/feed', { auth: bob.token })).json.items.find((i) => i.id === first.id).likedByMe).toBe(true);
    expect((await t.call('DELETE', `/callouts/${first.id}/like`, { auth: carol.token })).json.likes).toBe(1);

    const k1 = await t.call('POST', `/callouts/${first.id}/comments`, { auth: bob.token, body: { body: 'what was your entry?' } });
    expect(k1.status).toBe(201);
    await t.call('POST', `/callouts/${first.id}/comments`, { auth: carol.token, body: { body: 'ser' } });
    const list = await t.call('GET', `/callouts/${first.id}/comments`);
    expect(list.json.items.map((k) => k.author.handle)).toEqual(['bob', 'carol']);
    expect((await t.call('GET', `/callouts/${first.id}`)).json.callout.comments).toBe(2);
    // carol can't delete bob's comment; alice (thread owner) can.
    expect((await t.call('DELETE', `/comments/${k1.json.comment.id}`, { auth: carol.token })).status).toBe(404);
    expect((await t.call('DELETE', `/comments/${k1.json.comment.id}`, { auth: alice.token })).json.deleted).toBe(true);
    expect((await t.call('GET', `/callouts/${first.id}`)).json.callout.comments).toBe(1);
  });

  it('hides a callout after 3 reports and lets a moderator restore it', async () => {
    const r = await t.call('POST', '/callouts', { auth: dave.token, body: { token: TOKEN, body: 'rug incoming' }, headers: {} });
    // dave is rate limited for callouts in this test run; post as carol instead.
    const target = r.status === 201 ? r.json.callout.id : (await t.call('POST', '/callouts', { auth: carol.token, body: { token: TOKEN, body: 'rug incoming' } })).json.callout.id;
    for (const who of [alice, bob]) expect((await t.call('POST', '/reports', { auth: who.token, body: { targetType: 'callout', targetId: target, reason: 'spam' } })).json.reported).toBe(true);
    await t.call('POST', '/reports', { auth: bob.token, body: { targetType: 'callout', targetId: target, reason: 'spam' } }); // duplicate: no effect
    expect((await t.call('GET', `/callouts/${target}`)).status).toBe(200);
    await t.call('POST', '/reports', { auth: dave.token, body: { targetType: 'callout', targetId: target, reason: 'scam' } });
    expect((await t.call('GET', `/callouts/${target}`)).status).toBe(404);
    expect((await t.call('POST', '/reports', { auth: dave.token, body: { targetType: 'callout', targetId: target, reason: 'meh' } })).json.error.code).toBe('invalid_field');

    const reports = await t.admin('GET', '/reports');
    expect(reports.json.reports.filter((x) => x.target_id === target)).toHaveLength(3);
    expect((await t.admin('POST', `/callouts/${target}/unhide`)).json.hidden).toBe(false);
    expect((await t.call('GET', `/callouts/${target}`)).status).toBe(200);
  });

  it('suspends a member: their posts disappear and they can no longer act', async () => {
    expect((await t.admin('POST', `/members/${dave.member.id}/suspend`)).json.status).toBe('suspended');
    expect((await t.call('GET', '/members/dave')).status).toBe(404);
    expect((await t.call('GET', '/feed?limit=50')).json.items.some((i) => i.author.handle === 'dave')).toBe(false);
    expect((await t.call('GET', '/me', { auth: dave.token })).json.error.code).toBe('suspended');
    await t.admin('POST', `/members/${dave.member.id}/unsuspend`);
    expect((await t.call('GET', '/members/dave')).status).toBe(200);
  });
});
