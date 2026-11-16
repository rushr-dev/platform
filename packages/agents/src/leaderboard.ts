// Ranking: the team cap and owner rows "incl. agents". Every active member is listed; traders first.
// Pure: takes members and per-token aggregates (from leaderboardRows in sql.ts) and returns boards.
import { DEFAULT_PNL_CONFIG, tokenPnl, type Flows, type PnlConfig } from './pnl';

export type Kind = 'human' | 'agent';
export type Board = 'all' | 'human' | 'agent';

export interface MemberInfo {
  id: string;
  kind: Kind;
  handle: string;
  wallet: string;
  ownerId: string | null;
  /** wallets.first_funder of the member's wallet, if known. */
  firstFunder: string | null;
}

export interface TokenAgg extends Flows {
  memberId: string;
  token: string;
  trades: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** Same flows, but only trades made while linked to the current owner (agents with an owner). */
  linked?: Flows & { trades: number };
}

export interface RankConfig extends PnlConfig {
  minTrades: number;
  minTokens: number;
  /** Agents per owner that are ranked and count toward the owner's row. */
  teamCap: number;
}

/** Open board: every active member is listed, including those with no trades yet (after the traders). */
export const DEFAULT_RANK_CONFIG: RankConfig = { ...DEFAULT_PNL_CONFIG, minTrades: 0, minTokens: 0, teamCap: 3 };
/** The 24h window uses the same rules. */
export const DAY_RANK_CONFIG: RankConfig = { ...DEFAULT_RANK_CONFIG };

/** `linked_by_funding` is no longer produced (funding clusters don't unrank anyone); kept for old clients. */
export type Unranked = 'ineligible' | 'team_cap' | 'linked_by_funding';

export interface MemberStats {
  member: MemberInfo;
  pnl: number;
  realized: number;
  unrealized: number;
  volumeUsd: number;
  investedUsd: number;
  roi: number | null;
  trades: number;
  tokens: number;
  winRate: number | null;
  /** Agent only: PnL from trades while linked to its current owner. */
  linkedPnl: number;
}

export interface Row extends MemberStats {
  rank: number;
  /** What the row is ranked by: own PnL for agents, own + best agents for humans. */
  score: number;
  /** Human rows that include agents' PnL are labelled "incl. agents". */
  inclAgents: boolean;
  agentsPnl: number;
  agentIds: string[];
}

export interface Leaderboard {
  rows: Row[];
  unranked: { member: MemberInfo; reason: Unranked; pnl: number }[];
}

function memberStats(member: MemberInfo, aggs: TokenAgg[], cfg: PnlConfig): MemberStats {
  let realized = 0, unrealized = 0, volumeUsd = 0, investedUsd = 0, trades = 0, tokens = 0, wins = 0, linkedPnl = 0;
  for (const a of aggs) {
    const p = tokenPnl(a, a, cfg);
    realized += p.realized;
    unrealized += p.unrealized;
    volumeUsd += a.boughtUsd + a.soldUsd;
    investedUsd += a.boughtTokens > 0 ? a.boughtUsd : 0;
    trades += a.trades;
    if (a.trades > 0) tokens++;
    if (a.boughtTokens > 0) {
      if (p.pnl > 0) wins++;
    }
    if (a.linked) linkedPnl += tokenPnl(a.linked, a, cfg).pnl;
  }
  const pnl = realized + unrealized;
  const positions = aggs.filter((a) => a.boughtTokens > 0).length;
  return {
    member,
    pnl,
    realized,
    unrealized,
    volumeUsd,
    investedUsd,
    roi: investedUsd > 0 ? pnl / investedUsd : null,
    trades,
    tokens,
    winRate: positions > 0 ? wins / positions : null,
    linkedPnl,
  };
}

/** A member's team: the owner for owned agents, otherwise the member itself. */
export const teamOf = (m: MemberInfo) => m.ownerId ?? m.id;

/**
 * Funding clusters that are NOT declared teams: members of different teams linked by a shared first
 * funder, or one having funded the other. Returns member id → cluster id.
 */
export function fundingClusters(members: MemberInfo[]): Map<string, string> {
  const parent = new Map<string, string>(members.map((m) => [m.id, m.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const byFunder = new Map<string, MemberInfo[]>();
  const byWallet = new Map(members.map((m) => [m.wallet, m]));
  for (const m of members) {
    if (!m.firstFunder) continue;
    const list = byFunder.get(m.firstFunder) ?? [];
    list.push(m);
    byFunder.set(m.firstFunder, list);
    const funder = byWallet.get(m.firstFunder);
    if (funder && teamOf(funder) !== teamOf(m)) union(m.id, funder.id);
  }
  for (const list of byFunder.values()) {
    for (let i = 1; i < list.length; i++) if (teamOf(list[i]!) !== teamOf(list[0]!)) union(list[i]!.id, list[0]!.id);
    // Same-team pairs sharing a funder are expected (an owner funding their agents) and stay unlinked,
    // unless a third, outside member joins them, which the loop above handles via list[0].
  }
  return new Map(members.map((m) => [m.id, find(m.id)]));
}

export function rank(members: MemberInfo[], aggs: TokenAgg[], board: Board, cfg: RankConfig = DEFAULT_RANK_CONFIG): Leaderboard {
  const byMember = new Map<string, TokenAgg[]>();
  for (const a of aggs) {
    const list = byMember.get(a.memberId) ?? [];
    list.push(a);
    byMember.set(a.memberId, list);
  }
  const stats = new Map(members.map((m) => [m.id, memberStats(m, byMember.get(m.id) ?? [], cfg)]));
  const unranked: Leaderboard['unranked'] = [];
  const out = new Set<string>();
  const drop = (id: string, reason: Unranked) => {
    if (out.has(id)) return;
    out.add(id);
    const s = stats.get(id)!;
    unranked.push({ member: s.member, reason, pnl: s.pnl });
  };

  // 1. Thresholds on the member's own trading. A human with ranked agents may still rank via them (step 4).
  const selfEligible = new Set(members.filter((m) => {
    const s = stats.get(m.id)!;
    return s.trades >= cfg.minTrades && s.tokens >= cfg.minTokens;
  }).map((m) => m.id));
  for (const m of members) if (m.kind === 'agent' && !selfEligible.has(m.id)) drop(m.id, 'ineligible');

  // 2. Team cap: an owner's best `teamCap` remaining agents (by own PnL) are ranked.
  const agentsByOwner = new Map<string, MemberInfo[]>();
  for (const m of members) {
    if (m.kind !== 'agent' || !m.ownerId || out.has(m.id)) continue;
    agentsByOwner.set(m.ownerId, [...(agentsByOwner.get(m.ownerId) ?? []), m]);
  }
  const rankedAgents = new Map<string, MemberInfo[]>();
  for (const [owner, list] of agentsByOwner) {
    list.sort((a, b) => stats.get(b.id)!.pnl - stats.get(a.id)!.pnl);
    rankedAgents.set(owner, list.slice(0, cfg.teamCap));
    for (const m of list.slice(cfg.teamCap)) drop(m.id, 'team_cap');
  }

  // 3. Rows. Humans: own PnL + PnL their ranked agents made while linked to them ("incl. agents").
  const rows: Row[] = [];
  for (const m of members) {
    if (out.has(m.id)) continue;
    const s = stats.get(m.id)!;
    if (m.kind === 'agent') {
      if (board === 'human') continue;
      rows.push({ ...s, rank: 0, score: s.pnl, inclAgents: false, agentsPnl: 0, agentIds: [] });
      continue;
    }
    const agents = rankedAgents.get(m.id) ?? [];
    if (!selfEligible.has(m.id) && agents.length === 0) {
      drop(m.id, 'ineligible');
      continue;
    }
    if (board === 'agent') continue;
    const agentsPnl = agents.reduce((sum, a) => sum + stats.get(a.id)!.linkedPnl, 0);
    rows.push({ ...s, rank: 0, score: s.pnl + agentsPnl, inclAgents: agents.length > 0, agentsPnl, agentIds: agents.map((a) => a.id) });
  }
  // Members who traded come first (by score); members with no trades yet follow, by handle.
  // An owner row counts as active if the owner or one of its ranked agents traded.
  const active = (r: Row) => r.trades > 0 || r.agentIds.some((id) => stats.get(id)!.trades > 0);
  rows.sort((a, b) => Number(active(b)) - Number(active(a)) || b.score - a.score || a.member.handle.localeCompare(b.member.handle));
  rows.forEach((r, i) => (r.rank = i + 1));
  return { rows, unranked };
}
