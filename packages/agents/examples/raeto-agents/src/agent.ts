import { readFileSync, writeFileSync } from 'node:fs';
import { formatEther, parseEther } from 'viem';
import { askJson, listModels } from './ai';
import { config } from './config';
import { account, ApiError, chain, holdings, postCall, safety, trade, trenches, type TokenCard } from './rushr';

/**
 * A Rushr trading agent whose AI runs on Raeto. Each round it:
 *   1. checks open positions against the take-profit / stop-loss rules (plain code, no AI call);
 *   2. asks the model for at most one new idea, from a short list the strategy pre-filters;
 *   3. trades it (scout, graduate) or posts it as a public call (caller), always disclosing what it holds.
 * DRY_RUN=true (the default) logs every decision and signs nothing.
 */

const STATE_FILE = 'state.json';
type State = { day: string; spentEth: number; called: Record<string, string> };
const today = () => new Date().toISOString().slice(0, 10);

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
    return s.day === today() ? s : { day: today(), spentEth: 0, called: s.called ?? {} };
  } catch {
    return { day: today(), spentEth: 0, called: {} };
  }
}
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** What the model sees about a token: the numbers a trench trader looks at, nothing else. */
const brief = (t: TokenCard) => ({
  address: t.address,
  symbol: t.symbol,
  ageMinutes: Math.round((Date.now() - new Date(t.created_at).getTime()) / 60_000),
  marketCapUsd: Math.round(t.market_cap_usd ?? 0),
  volume24hUsd: Math.round(t.volume_24h_usd ?? 0),
  holders: t.holders,
  bondingProgressPct: t.bonding_progress == null ? null : Math.round(t.bonding_progress * 100),
  risk: t.risk,
  verdict: t.verdict,
  top10Pct: t.top10_pct,
  devPct: t.dev_pct,
  snipersPct: t.snipers_pct,
  bundledPct: t.bundled_pct,
  buys24h: t.buys_24h ?? null,
  sells24h: t.sells_24h ?? null,
});

const SYSTEM = `You are a disciplined trading agent on Rushr, in the Robinhood Chain trenches. You trade small, you skip anything
that looks manipulated (high bundled, sniper or top-10 share, dev still holding a lot), and skipping is always allowed.`;

/** Strategy filters: what each one is allowed to look at before the model picks. */
const STRATEGIES = {
  scout: {
    column: 'new' as const,
    filter: (t: TokenCard) => t.risk !== 'high' && t.holders >= 15 && (t.top10_pct ?? 100) < 45 && (t.snipers_pct ?? 100) < 30,
    ask: 'These are fresh launches. Pick at most one with real early demand (holders and buys growing, healthy distribution) worth a small buy.',
  },
  graduate: {
    column: 'almost' as const,
    filter: (t: TokenCard) => t.risk !== 'high' && (t.bonding_progress ?? 0) >= 0.6 && t.holders >= 30,
    ask: 'These tokens are close to completing their bonding curve and migrating. Pick at most one likely to complete soon on organic demand.',
  },
  caller: {
    column: 'migrated' as const,
    filter: (t: TokenCard) => t.risk !== 'high' && (t.volume_24h_usd ?? 0) >= 1_000 && (t.market_cap_usd ?? 0) >= 10_000,
    ask: 'These tokens have graduated to Uniswap. Pick at most one you have a clear, specific view on, bullish or bearish.',
  },
};

type Pick = { address: string | null; stance?: 'bullish' | 'bearish'; reason: string };

async function manageExits(): Promise<number> {
  const open = (await holdings()).filter((h) => (h.value_usd ?? 0) >= 0.5 && (h.cost_basis_usd ?? 0) > 0);
  for (const h of open) {
    const pnlPct = ((h.value_usd! - h.cost_basis_usd!) / h.cost_basis_usd!) * 100;
    const exit = pnlPct >= config.takeProfitPct ? 'take profit' : pnlPct <= -config.stopLossPct ? 'stop loss' : null;
    if (!exit) continue;
    try {
      log(`${exit} on $${h.symbol} (${pnlPct.toFixed(1)}%):`, await trade(h.token, 'sell', BigInt(h.amount)));
    } catch (e) {
      log(`sell $${h.symbol} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return open.length;
}

async function round(state: State) {
  const s = STRATEGIES[config.strategy];
  const openPositions = config.strategy === 'caller' ? 0 : await manageExits();

  if (config.strategy !== 'caller') {
    if (openPositions >= config.maxPositions) return log(`holding ${openPositions} positions: no new buys`);
    if (state.spentEth + config.buyEth > config.dailyBuyEth) return log(`daily buy budget used (${state.spentEth} ETH)`);
  }

  const candidates = (await trenches(s.column)).filter(s.filter).filter((t) => !state.called[t.address]).slice(0, 8);
  if (!candidates.length) return log('no candidates this round');

  const pick = await askJson<Pick>(
    SYSTEM,
    `${s.ask}\nReply as {"address": "<one of the addresses or null>", ${config.strategy === 'caller' ? '"stance": "bullish" | "bearish", ' : ''}"reason": "<one or two sentences, specific to the numbers>"}.\n\n${JSON.stringify(candidates.map(brief))}`,
  );
  const token = candidates.find((t) => t.address === pick.address?.toLowerCase());
  if (!token) return log('model skipped:', pick.reason);

  // A second, fresh look at safety right before acting (the list can be minutes old).
  const check = await safety(token.address);
  if (check.blocked || check.riskLevel === 'high') return log(`$${token.symbol} is now ${check.riskLevel}: skipping`);

  const reason = pick.reason.replace(/https?:\/\/\S+/g, '').slice(0, 300);
  if (config.strategy === 'caller') {
    const stance = pick.stance === 'bearish' ? 'bearish' : 'bullish';
    const body = `${stance === 'bullish' ? 'Bullish' : 'Bearish'} $${token.symbol}: ${reason} I don't hold it. AI agent running on Raeto. Not advice.`;
    if (config.dryRun) log(`[dry run] would call ${stance} $${token.symbol}: ${body}`);
    else log(`called $${token.symbol}:`, (await postCall(token.address, stance, body)).callout.id);
  } else {
    const result = await trade(token.address, 'buy', parseEther(String(config.buyEth)));
    log(`buy $${token.symbol}:`, result);
    if (!config.dryRun) {
      state.spentEth += config.buyEth;
      // Disclosed call: the entry links to the buy once the indexer has it, so wait a little first.
      await new Promise((r) => setTimeout(r, 20_000));
      await postCall(token.address, 'bullish', `Bullish $${token.symbol}: ${reason} I hold a small position (bought ${config.buyEth} ETH). AI agent running on Raeto. Not advice.`).catch((e) =>
        log('call failed:', e instanceof Error ? e.message : e),
      );
    }
  }
  state.called[token.address] = new Date().toISOString();
}

async function main() {
  if (!config.ai.apiKey) throw new Error('Set AI_API_KEY (the agent\'s Raeto key) in .env');
  if (!config.ai.model) {
    console.log('Set AI_MODEL in .env to one of:\n' + (await listModels()).join('\n'));
    return;
  }
  if (!config.apiKey) throw new Error('No RUSHR_API_KEY: run `npm run register` first');
  const balance = await chain.getBalance({ address: account.address });
  log(`agent ${account.address} · ${config.strategy} · ${formatEther(balance)} ETH · ${config.dryRun ? 'DRY RUN' : 'LIVE'} · AI ${config.ai.model} via ${config.ai.baseUrl}`);

  const once = process.argv.includes('--once');
  for (;;) {
    const state = loadState();
    try {
      await round(state);
    } catch (e) {
      log('round failed:', e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : e);
    }
    saveState(state);
    if (once) break;
    await new Promise((r) => setTimeout(r, config.intervalSeconds * 1000));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
