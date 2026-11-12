import { describe, expect, it } from 'vitest';
import { tokenPnl } from '../src/pnl';
import { rank, fundingClusters, type MemberInfo, type TokenAgg } from '../src/leaderboard';

describe('tokenPnl', () => {
  const liquid = { priceUsd: 2, liquidityUsd: 1_000_000 };
  it('realizes sells at average cost and marks the rest to market', () => {
    // Bought 100 for $100, sold 50 for $150, 50 left worth $100.
    const p = tokenPnl({ boughtTokens: 100, boughtUsd: 100, soldTokens: 50, soldUsd: 150 }, liquid);
    expect(p.realized).toBeCloseTo(100);
    expect(p.unrealized).toBeCloseTo(50);
  });
  it('ignores sells of tokens not bought in the window', () => {
    const p = tokenPnl({ boughtTokens: 10, boughtUsd: 10, soldTokens: 100, soldUsd: 300 }, liquid);
    expect(p.realized).toBeCloseTo(30 - 10);
    expect(p.remainingTokens).toBe(0);
    expect(tokenPnl({ boughtTokens: 0, boughtUsd: 0, soldTokens: 5, soldUsd: 50 }, liquid).pnl).toBe(0);
  });
  it('needs liquidity for unrealized gains but always counts losses', () => {
    const f = { boughtTokens: 100, boughtUsd: 100, soldTokens: 0, soldUsd: 0 };
    expect(tokenPnl(f, { priceUsd: 10, liquidityUsd: null }).unrealized).toBe(0);
    expect(tokenPnl(f, { priceUsd: 10, liquidityUsd: 5_000 }).unrealized).toBe(0);
    expect(tokenPnl(f, { priceUsd: 100, liquidityUsd: 20_000 }).unrealized).toBe(5_000);
    expect(tokenPnl(f, { priceUsd: 10, liquidityUsd: 20_000 }).unrealized).toBe(900); // capped at 25% of liquidity
    expect(tokenPnl(f, { priceUsd: 0.5, liquidityUsd: null }).unrealized).toBe(-50);
    expect(tokenPnl(f, { priceUsd: null, liquidityUsd: null }).unrealized).toBe(-100);
  });
});

const m = (id: string, kind: 'human' | 'agent', extra: Partial<MemberInfo> = {}): MemberInfo => ({
  id, kind, handle: id, wallet: `0x${id}`, ownerId: null, firstFunder: null, ...extra,
});
/** `pnl` dollars of realized profit spread over `tokens` tokens and `trades` trades. */
const won = (memberId: string, pnl: number, tokens = 3, trades = 6, linked = false): TokenAgg[] =>
  Array.from({ length: tokens }, (_, i) => {
    const f = { boughtTokens: 100, boughtUsd: 100, soldTokens: 100, soldUsd: 100 + pnl / tokens };
    return { memberId, token: `t${i}`, trades: Math.ceil(trades / tokens), priceUsd: 1, liquidityUsd: 1e6, ...f, linked: linked ? { ...f, trades: 2 } : undefined };
  });

describe('rank', () => {
  it('ranks humans and agents on one board, with tabs', () => {
    const members = [m('alice', 'human'), m('bot', 'agent', { handle: 'bot' }), m('carol', 'human')];
    const aggs = [...won('alice', 50), ...won('bot', 80), ...won('carol', -10)];
    const all = rank(members, aggs, 'all');
    expect(all.rows.map((r) => [r.member.id, r.rank])).toEqual([['bot', 1], ['alice', 2], ['carol', 3]]);
    expect(rank(members, aggs, 'human').rows.map((r) => r.member.id)).toEqual(['alice', 'carol']);
    expect(rank(members, aggs, 'agent').rows.map((r) => r.member.id)).toEqual(['bot']);
  });
  it('drops members under the activity thresholds', () => {
    const members = [m('alice', 'human'), m('lucky', 'agent')];
    const aggs = [...won('alice', 10), ...won('lucky', 1000, 1, 1)];
    const lb = rank(members, aggs, 'all');
    expect(lb.rows.map((r) => r.member.id)).toEqual(['alice']);
    expect(lb.unranked).toEqual([expect.objectContaining({ reason: 'ineligible' })]);
  });
  it('adds the best 3 owned agents to the owner row, labelled incl. agents, and caps the rest', () => {
    const members = [m('owner', 'human'), ...[1, 2, 3, 4].map((i) => m(`a${i}`, 'agent', { ownerId: 'owner' }))];
    const aggs = [...won('owner', 10), ...won('a1', 40, 3, 6, true), ...won('a2', 30, 3, 6, true), ...won('a3', -5, 3, 6, true), ...won('a4', -50, 3, 6, true)];
    const lb = rank(members, aggs, 'all');
    const owner = lb.rows.find((r) => r.member.id === 'owner')!;
    expect(owner.inclAgents).toBe(true);
    expect(owner.agentIds).toEqual(['a1', 'a2', 'a3']);
    expect(owner.agentsPnl).toBeCloseTo(65);
    expect(owner.score).toBeCloseTo(75);
    expect(owner.pnl).toBeCloseTo(10);
    expect(lb.unranked).toEqual([expect.objectContaining({ reason: 'team_cap', member: expect.objectContaining({ id: 'a4' }) })]);
    // Agents keep their own rows.
    expect(lb.rows.find((r) => r.member.id === 'a1')!.score).toBeCloseTo(40);
  });
  it('only counts agent PnL made while linked to the owner', () => {
    const members = [m('owner', 'human'), m('late', 'agent', { ownerId: 'owner' })];
    const aggs = [...won('owner', 10), ...won('late', 100).map((a) => ({ ...a, linked: { boughtTokens: 0, boughtUsd: 0, soldTokens: 0, soldUsd: 0, trades: 0 } }))];
    expect(rank(members, aggs, 'human').rows[0]!.score).toBeCloseTo(10);
  });
  it('collapses undeclared funding clusters to their best team', () => {
    const members = [m('alice', 'human'), m('sock1', 'agent', { firstFunder: '0xalice' }), m('sock2', 'agent', { firstFunder: '0xalice' }), m('dana', 'human', { firstFunder: '0xbank' }), m('eve', 'human', { firstFunder: '0xbank' })];
    const clusters = fundingClusters(members);
    expect(clusters.get('sock1')).toBe(clusters.get('alice'));
    expect(clusters.get('dana')).toBe(clusters.get('eve'));
    const aggs = [...won('alice', 10), ...won('sock1', 90), ...won('sock2', 50), ...won('dana', 5), ...won('eve', 7)];
    const lb = rank(members, aggs, 'all');
    expect(lb.rows.map((r) => r.member.id)).toEqual(['sock1', 'eve']);
    expect(lb.unranked.map((u) => [u.member.id, u.reason]).sort()).toEqual([['alice', 'linked_by_funding'], ['dana', 'linked_by_funding'], ['sock2', 'linked_by_funding']]);
  });
  it('does not treat funding inside a declared team as a cluster', () => {
    const members = [m('owner', 'human'), m('a1', 'agent', { ownerId: 'owner', firstFunder: '0xowner' })];
    const lb = rank(members, [...won('owner', 10), ...won('a1', 20, 3, 6, true)], 'all');
    expect(lb.rows.map((r) => r.member.id)).toEqual(['owner', 'a1']);
    expect(lb.unranked).toEqual([]);
  });
});
