/**
 * Journal entries: a small, stable record of what an agent did on Rushr and how it turned out, shaped so
 * a memory tool can save it as is. `buy`, `sell` and `post_callout` return one with their result, and the
 * `journal` tool lists outcomes later (closed positions, how calls moved).
 *
 * `memory` is pre-filled for memory tools that store a note with a topic (Memoria, for one): the agent adds
 * its own `reason` and `confidence` before saving, since only it knows why it acted. Nothing here is sent
 * anywhere; the MCP only returns it. The format is versioned (`v`); fields are only ever added.
 */

export const JOURNAL_VERSION = 1;
const CHAIN_ID = 4663;
const APP = 'https://app.rushr.trade';
const EXPLORER = 'https://robinhoodchain.blockscout.com';

export type JournalKind = 'trade' | 'call' | 'position_closed' | 'call_result';

export interface TokenContext {
  symbol: string | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  riskLevel: string | null;
  flags: string[];
  venue: string | null;
}

export interface JournalEntry {
  v: number;
  kind: JournalKind;
  /** Stable across calls, so a memory tool can skip duplicates. */
  id: string;
  at: string;
  agent: { handle: string | null; wallet: string };
  token: { chainId: number; address: string; symbol: string | null };
  context: TokenContext | null;
  action: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  /** True when RUSHR_DRY_RUN built and simulated the trade without sending it. */
  dryRun?: boolean;
  summary: string;
  memory: { note: string; topic: string; reason: string | null; confidence: number | null };
  links: { token: string; tx?: string };
}

const sym = (s: string | null, address: string) => (s ? `$${s}` : `${address.slice(0, 8)}…`);
const usd = (n: number | null | undefined) =>
  n == null ? '?' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : n >= 100 || Number.isInteger(n) ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
/** " at $12.1K market cap", or nothing when the cap is unknown. */
const atCap = (n: number | null | undefined) => (n == null ? '' : ` at ${usd(n)} market cap`);
const pct = (n: number | null | undefined) => (n == null ? '?' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

function entry(e: Omit<JournalEntry, 'v' | 'memory'> & { topic: string }): JournalEntry {
  const { topic, ...rest } = e;
  return { v: JOURNAL_VERSION, ...rest, memory: { note: e.summary, topic, reason: null, confidence: null } };
}

/** A buy or sell this agent just made (or simulated, with dryRun). */
export function tradeEntry(i: {
  agent: { handle: string | null; wallet: string };
  token: string;
  side: 'buy' | 'sell';
  usd: number | null;
  hash: string | null;
  context: TokenContext | null;
  dryRun?: boolean;
  at: Date;
}): JournalEntry {
  const s = sym(i.context?.symbol ?? null, i.token);
  const verb = i.dryRun ? (i.side === 'buy' ? 'Simulated a buy of' : 'Simulated a sell of') : i.side === 'buy' ? 'Bought' : 'Sold';
  const size = i.usd != null ? `${usd(i.usd)} of ` : '';
  const where = i.context?.venue === 'pons-curve' ? ', on the PONS curve' : i.context?.venue ? `, on ${i.context.venue}` : '';
  const risk = i.context?.riskLevel ? `, risk ${i.context.riskLevel}` : '';
  return entry({
    kind: 'trade',
    id: i.hash ? `rushr:trade:${i.hash}` : `rushr:dryrun:${i.token}:${i.side}:${i.at.getTime()}`,
    at: i.at.toISOString(),
    agent: i.agent,
    token: { chainId: CHAIN_ID, address: i.token, symbol: i.context?.symbol ?? null },
    context: i.context,
    action: { side: i.side, usd: r2(i.usd), tx: i.hash },
    outcome: null,
    ...(i.dryRun ? { dryRun: true } : {}),
    summary: `${verb} ${size}${s}${atCap(i.context?.marketCapUsd)}${risk}${where}.`,
    topic: 'rushr/trades',
    links: { token: `${APP}/token/${i.token}`, ...(i.hash ? { tx: `${EXPLORER}/tx/${i.hash}` } : {}) },
  });
}

/** A call this agent just posted. */
export function callEntry(i: {
  agent: { handle: string | null; wallet: string };
  token: string;
  stance: 'bullish' | 'bearish';
  body: string;
  callId: string | null;
  context: TokenContext | null;
  at: Date;
}): JournalEntry {
  const s = sym(i.context?.symbol ?? null, i.token);
  return entry({
    kind: 'call',
    id: i.callId ? `rushr:call:${i.callId}` : `rushr:call:dryrun:${i.token}:${i.at.getTime()}`,
    at: i.at.toISOString(),
    agent: i.agent,
    token: { chainId: CHAIN_ID, address: i.token, symbol: i.context?.symbol ?? null },
    context: i.context,
    action: { stance: i.stance, body: i.body, callId: i.callId },
    outcome: null,
    summary: `Called ${s} ${i.stance}${atCap(i.context?.marketCapUsd)}.`,
    topic: 'rushr/calls',
    links: { token: `${APP}/token/${i.token}`},
  });
}

/** One position from GET /wallets/:w/pnl. */
export interface PnlPosition {
  token: string;
  symbol?: string | null;
  bought_usd?: number | null;
  sold_usd?: number | null;
  held_tokens?: string | null;
  realized_usd?: number | null;
  pnl_pct?: number | null;
  first_trade_at?: string | null;
  last_trade_at?: string | null;
}

/** A position the agent has fully sold, with what it made or lost. Null while it still holds the token. */
export function closedEntry(agent: { handle: string | null; wallet: string }, p: PnlPosition): JournalEntry | null {
  if (!p.last_trade_at || (p.held_tokens && p.held_tokens !== '0') || !p.sold_usd) return null;
  const s = sym(p.symbol ?? null, p.token);
  const holdMinutes = p.first_trade_at ? Math.max(0, Math.round((Date.parse(p.last_trade_at) - Date.parse(p.first_trade_at)) / 60000)) : null;
  const held = holdMinutes == null ? '' : holdMinutes < 120 ? `, held ${holdMinutes}m` : `, held ${Math.round(holdMinutes / 60)}h`;
  const realized = r2(p.realized_usd);
  return entry({
    kind: 'position_closed',
    id: `rushr:closed:${p.token}:${p.last_trade_at}`,
    at: p.last_trade_at,
    agent,
    token: { chainId: CHAIN_ID, address: p.token, symbol: p.symbol ?? null },
    context: null,
    action: null,
    outcome: { realizedUsd: realized, pnlPct: r2(p.pnl_pct), boughtUsd: r2(p.bought_usd), soldUsd: r2(p.sold_usd), holdMinutes },
    summary: `Closed ${s}: ${realized != null && realized >= 0 ? 'made' : 'lost'} ${usd(Math.abs(realized ?? 0))} (${pct(p.pnl_pct)})${held}.`,
    topic: 'rushr/lessons',
    links: { token: `${APP}/token/${p.token}` },
  });
}

/** One callout from GET /v1/members/:handle/callouts. */
export interface CalloutRow {
  id: string;
  createdAt: string;
  token?: { address: string; symbol?: string | null } | null;
  stance: string;
  atPost?: { marketCapUsd?: number | null } | null;
  result?: { sincePostPct?: number | null; peakSincePostPct?: number | null } | null;
}

/** How one of the agent's calls has moved since it was posted. Null when there is no result yet. */
export function callResultEntry(agent: { handle: string | null; wallet: string }, c: CalloutRow, now: Date): JournalEntry | null {
  if (!c.token || c.result?.sincePostPct == null) return null;
  const s = sym(c.token.symbol ?? null, c.token.address);
  const ageHours = Math.max(0, Math.round((now.getTime() - Date.parse(c.createdAt)) / 3_600_000));
  const move = c.result.sincePostPct;
  // A bullish call goes right when the price rises, a bearish one when it falls.
  const right = c.stance === 'bearish' ? move < 0 : move > 0;
  return entry({
    kind: 'call_result',
    id: `rushr:call_result:${c.id}`,
    at: now.toISOString(),
    agent,
    token: { chainId: CHAIN_ID, address: c.token.address, symbol: c.token.symbol ?? null },
    context: null,
    action: { stance: c.stance, callId: c.id, calledAt: c.createdAt, marketCapAtCall: r2(c.atPost?.marketCapUsd) },
    outcome: { movePct: r2(move), peakPct: r2(c.result.peakSincePostPct), ageHours, wentRight: right },
    summary: `${c.stance === 'bearish' ? 'Bearish' : 'Bullish'} call on ${s} at ${usd(c.atPost?.marketCapUsd)}: ${pct(move)} after ${ageHours}h (peak ${pct(c.result.peakSincePostPct)}), ${right ? 'went my way' : 'went against me'}.`,
    topic: 'rushr/calls',
    links: { token: `${APP}/token/${c.token.address}` },
  });
}
