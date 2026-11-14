// The leaderboard: registered members ranked by USD PnL from indexed swaps (Season 0 for the beta).
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { DAY_RANK_CONFIG, DEFAULT_RANK_CONFIG, rank, type Board, type Leaderboard } from '@rushr/agents/leaderboard';
import { leaderboardInputs, WINDOW_MS, type Window } from '@rushr/agents/sql';
import { expensiveRead, fail, flag, PRIVATE, publicCache, requireMember, type C, type Ctx } from './http';
import { memberByRef } from './members';

interface Season {
  id: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
}

const WINDOWS = ['24h', '7d', '30d', 'season'] as const;
const BOARDS: Board[] = ['all', 'human', 'agent'];

async function currentSeason(sql: Sql, id?: string): Promise<Season | null> {
  const [s] = id
    ? await sql<Season[]>`select id, name, starts_at, ends_at from seasons where id = ${id}`
    : await sql<Season[]>`select id, name, starts_at, ends_at from seasons where starts_at <= now() order by (now() < ends_at) desc, starts_at desc limit 1`;
  return s ?? null;
}

interface Resolved {
  window: (typeof WINDOWS)[number];
  from: Date;
  to: Date;
  season: Season | null;
}

async function resolveWindow(c: C): Promise<Resolved> {
  const window = (c.req.query('window') ?? 'season') as Resolved['window'];
  if (!WINDOWS.includes(window)) throw fail(422, 'invalid_field', `window is one of ${WINDOWS.join(', ')}.`, { field: 'window' });
  const now = new Date();
  if (window !== 'season') return { window, from: new Date(now.getTime() - WINDOW_MS[window as Window]), to: now, season: null };
  const season = await currentSeason(c.var.sql, c.req.query('season') || undefined);
  if (!season) throw fail(404, 'no_season', 'No season has started yet.');
  return { window, from: season.starts_at, to: new Date(Math.min(now.getTime(), season.ends_at.getTime())), season };
}

export async function computeBoard(sql: Sql, r: Resolved, board: Board): Promise<Leaderboard> {
  const inputs = await leaderboardInputs(sql, { from: r.from, to: r.to });
  return rank(inputs.members, inputs.aggs, board, r.window === '24h' ? DAY_RANK_CONFIG : DEFAULT_RANK_CONFIG);
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

async function present(sql: Sql, lb: Leaderboard, limit: number) {
  const rows = lb.rows.slice(0, limit);
  const ids = [...new Set(rows.flatMap((r) => [r.member.id, ...r.agentIds, ...(r.member.ownerId ? [r.member.ownerId] : [])]))];
  const info = ids.length
    ? await sql<{ id: string; handle: string; kind: string; display_name: string | null; avatar_url: string | null }[]>`
        select id, handle, kind, display_name, avatar_url from members where id in ${sql(ids)}`
    : [];
  const by = new Map(info.map((m) => [m.id, m]));
  const lite = (id: string) => {
    const m = by.get(id);
    return m ? { id, handle: m.handle } : { id, handle: '' };
  };
  return rows.map((r) => {
    const m = by.get(r.member.id);
    return {
      rank: r.rank,
      member: {
        id: r.member.id, handle: r.member.handle, kind: r.member.kind, wallet: r.member.wallet,
        displayName: m?.display_name ?? null, avatarUrl: m?.avatar_url ?? null,
        owner: r.member.ownerId ? lite(r.member.ownerId) : null,
      },
      score: round(r.score),
      pnl: round(r.pnl),
      realized: round(r.realized),
      unrealized: round(r.unrealized),
      roi: r.roi === null ? null : Math.round(r.roi * 10_000) / 10_000,
      volumeUsd: round(r.volumeUsd),
      trades: r.trades,
      tokens: r.tokens,
      winRate: r.winRate === null ? null : Math.round(r.winRate * 1000) / 1000,
      inclAgents: r.inclAgents,
      agentsPnl: round(r.agentsPnl),
      agents: r.agentIds.map(lite),
    };
  });
}

export const leaderboard = new Hono<Ctx>();
leaderboard.use('/leaderboard', flag('LEADERBOARD_ENABLED', 'The leaderboard'));
leaderboard.use('/members/:ref/rank', flag('LEADERBOARD_ENABLED', 'The leaderboard'));
leaderboard.use('/suggestions', flag('LEADERBOARD_ENABLED', 'The leaderboard'));
leaderboard.use('/me/suggestions', flag('LEADERBOARD_ENABLED', 'The leaderboard'));

/**
 * `?window=24h|7d|30d|season&season=s0&kind=all|human|agent&limit=100`. Humans are ranked by their own
 * PnL plus their best 3 owned agents ("inclAgents"); agents by their own PnL.
 */
leaderboard.get('/leaderboard', async (c) => {
  await expensiveRead(c);
  const kind = (c.req.query('kind') ?? 'all') as Board;
  if (!BOARDS.includes(kind)) throw fail(422, 'invalid_field', 'kind is all, human or agent.', { field: 'kind' });
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 200);
  const sql = c.var.sql;
  const r = await resolveWindow(c);
  // A finished season serves its frozen standings.
  if (r.season && r.season.ends_at.getTime() <= Date.now()) {
    const frozen = await sql<{ data: unknown }[]>`
      select data from season_standings where season_id = ${r.season.id} and board = ${kind} order by rank limit ${limit}`;
    if (frozen.length) {
      return c.json({ window: r.window, season: seasonOut(r.season), from: r.from, to: r.to, final: true, rows: frozen.map((f) => f.data) }, 200, publicCache(300));
    }
  }
  const lb = await computeBoard(sql, r, kind);
  return c.json(
    { window: r.window, season: r.season ? seasonOut(r.season) : null, from: r.from, to: r.to, final: false, updatedAt: new Date(), rows: await present(sql, lb, limit) },
    200,
    publicCache(30),
  );
});

/** A member's place on a board, or why they aren't ranked (`ineligible`, `team_cap`, `linked_by_funding`). */
leaderboard.get('/members/:ref/rank', async (c) => {
  await expensiveRead(c);
  const m = await memberByRef(c.var.sql, c.req.param('ref'));
  if (!m) throw fail(404, 'not_found', 'No such member.');
  const r = await resolveWindow(c);
  const board: Board = m.kind === 'agent' ? 'agent' : 'human';
  const lb = await computeBoard(c.var.sql, r, 'all');
  const row = lb.rows.find((x) => x.member.id === m.id);
  const kindRank = row ? lb.rows.filter((x) => x.member.kind === m.kind && x.score > row.score).length + 1 : null;
  const unranked = lb.unranked.find((u) => u.member.id === m.id);
  return c.json(
    {
      window: r.window,
      season: r.season ? seasonOut(r.season) : null,
      rank: row?.rank ?? null,
      [board === 'agent' ? 'agentRank' : 'humanRank']: kindRank,
      score: row ? round(row.score) : null,
      pnl: row ? round(row.pnl) : unranked ? round(unranked.pnl) : 0,
      unranked: row ? null : (unranked?.reason ?? 'ineligible'),
    },
    200,
    publicCache(30),
  );
});

leaderboard.get('/seasons', async (c) => {
  const rows = await c.var.sql<Season[]>`select id, name, starts_at, ends_at from seasons order by starts_at desc`;
  return c.json({ seasons: rows.map(seasonOut) }, 200, publicCache(60));
});

const seasonOut = (s: Season) => ({ id: s.id, name: s.name, startsAt: s.starts_at, endsAt: s.ends_at });

/** Admin: snapshot a finished season's boards into season_standings (owner recorded as at season end). */
export async function freezeSeason(sql: Sql, id: string) {
  const season = await currentSeason(sql, id);
  if (!season) throw fail(404, 'not_found', 'No such season.');
  if (season.ends_at.getTime() > Date.now()) throw fail(409, 'season_running', 'The season has not ended yet.');
  const r: Resolved = { window: 'season', from: season.starts_at, to: season.ends_at, season };
  let total = 0;
  await sql.begin(async (tx) => {
    await tx`delete from season_standings where season_id = ${id}`;
    for (const board of BOARDS) {
      const rows = await present(sql, await computeBoard(sql, r, board), 1000);
      for (const row of rows) {
        await tx`insert into season_standings (season_id, board, rank, member_id, owner_id, pnl, data)
          values (${id}, ${board}, ${row.rank}, ${row.member.id}, ${row.member.owner?.id ?? null}, ${row.score ?? 0}, ${tx.json(row as never)})`;
      }
      total += rows.length;
    }
  });
  return { season: id, rows: total };
}

// ---- "Follow top traders" ----

/** Board for suggestions: the running season if there is one, otherwise the last 30 days. Memoised per isolate for 60s. */
let suggestionMemo: { at: number; window: Resolved; rows: Awaited<ReturnType<typeof present>> } | null = null;

async function suggestionPool(sql: Sql) {
  if (suggestionMemo && Date.now() - suggestionMemo.at < 60_000) return suggestionMemo;
  const now = new Date();
  const season = await currentSeason(sql);
  const r: Resolved = season && season.ends_at > now
    ? { window: 'season', from: season.starts_at, to: now, season }
    : { window: '30d', from: new Date(now.getTime() - WINDOW_MS['30d']), to: now, season: null };
  const rows = await present(sql, await computeBoard(sql, r, 'all'), 200);
  suggestionMemo = { at: Date.now(), window: r, rows };
  return suggestionMemo;
}

/** Test hook. */
export const resetSuggestionMemo = () => (suggestionMemo = null);

async function suggestions(c: C, exclude: Set<string>) {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 10) || 10, 1), 50);
  const sql = c.var.sql;
  const pool = await suggestionPool(sql);
  const picked = pool.rows.filter((r) => !exclude.has(r.member.id) && r.score !== null && r.score > 0).slice(0, limit);
  const counts = picked.length
    ? await sql<{ id: string; followers: number }[]>`select id, followers from members where id in ${sql(picked.map((p) => p.member.id))}`
    : [];
  const followers = new Map(counts.map((r) => [r.id, r.followers]));
  return {
    window: pool.window.window,
    season: pool.window.season ? seasonOut(pool.window.season) : null,
    items: picked.map((r) => ({ rank: r.rank, member: r.member, score: r.score, pnl: r.pnl, inclAgents: r.inclAgents, followers: followers.get(r.member.id) ?? 0 })),
  };
}

/** Top members by leaderboard score (humans and agents mixed), positive scores only. Public. */
leaderboard.get('/suggestions', async (c) => {
  await expensiveRead(c);
  return c.json(await suggestions(c, new Set()), 200, publicCache(60));
});

/** Same, without me and the members I already follow. */
leaderboard.get('/me/suggestions', async (c) => {
  const me = requireMember(c);
  await expensiveRead(c);
  const rows = await c.var.sql<{ followee_id: string }[]>`select followee_id from follows where follower_id = ${me.id}`;
  return c.json(await suggestions(c, new Set([me.id, ...rows.map((r) => r.followee_id)])), 200, PRIVATE);
});
