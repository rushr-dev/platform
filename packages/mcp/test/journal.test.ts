import { describe, expect, it } from 'vitest';
import { callEntry, callResultEntry, closedEntry, JOURNAL_VERSION, tradeEntry, type TokenContext } from '../src/journal.ts';

const agent = { handle: 'memo_scout', wallet: '0x1111111111111111111111111111111111111111' };
const TOKEN = '0x77770b77616fd7e8f2994a45d88cd0cd8d1cbf92';
const ctx: TokenContext = { symbol: 'NEARL', marketCapUsd: 12_100, priceUsd: 0.0000121, riskLevel: 'low', flags: [], venue: 'pons-curve' };
const at = new Date('2026-11-24T09:00:00Z');

describe('journal entries', () => {
  it('records a trade with a stable id, a readable summary and memory fields', () => {
    const e = tradeEntry({ agent, token: TOKEN, side: 'buy', usd: 25, hash: '0xabc', context: ctx, at });
    expect(e).toMatchObject({
      v: JOURNAL_VERSION,
      kind: 'trade',
      id: 'rushr:trade:0xabc',
      token: { chainId: 4663, address: TOKEN, symbol: 'NEARL' },
      action: { side: 'buy', usd: 25, tx: '0xabc' },
      memory: { topic: 'rushr/trades', reason: null, confidence: null },
      links: { token: `https://app.rushr.trade/token/${TOKEN}`, tx: 'https://robinhoodchain.blockscout.com/tx/0xabc' },
    });
    expect(e.summary).toBe('Bought $25 of $NEARL at $12.1K market cap, risk low, on the PONS curve.');
    expect(e.memory.note).toBe(e.summary);
    expect(e.dryRun).toBeUndefined();
  });

  it('marks a dry-run trade and words it as simulated', () => {
    const e = tradeEntry({ agent, token: TOKEN, side: 'sell', usd: null, hash: null, context: null, dryRun: true, at });
    expect(e.dryRun).toBe(true);
    expect(e.id).toBe(`rushr:dryrun:${TOKEN}:sell:${at.getTime()}`);
    expect(e.summary).toBe('Simulated a sell of 0x77770b….');
    expect(e.links.tx).toBeUndefined();
  });

  it('records a call', () => {
    const e = callEntry({ agent, token: TOKEN, stance: 'bullish', body: 'Undervalued.', callId: 'c_1', context: ctx, at });
    expect(e).toMatchObject({ kind: 'call', id: 'rushr:call:c_1', action: { stance: 'bullish', callId: 'c_1' }, memory: { topic: 'rushr/calls' } });
    expect(e.summary).toBe('Called $NEARL bullish at $12.1K market cap.');
  });

  it('turns a fully sold position into a lesson, and skips one still held', () => {
    const closed = closedEntry(agent, {
      token: TOKEN, symbol: 'NEARL', bought_usd: 20, sold_usd: 23.6, held_tokens: '0', realized_usd: 3.6, pnl_pct: 18,
      first_trade_at: '2026-11-24T06:00:00Z', last_trade_at: '2026-11-24T09:00:00Z',
    });
    expect(closed).toMatchObject({ kind: 'position_closed', id: `rushr:closed:${TOKEN}:2026-11-24T09:00:00Z`, outcome: { realizedUsd: 3.6, pnlPct: 18, holdMinutes: 180 }, memory: { topic: 'rushr/lessons' } });
    expect(closed!.summary).toBe('Closed $NEARL: made $3.60 (+18.0%), held 3h.');
    const loss = closedEntry(agent, { token: TOKEN, symbol: 'NEARL', sold_usd: 5, held_tokens: '0', realized_usd: -15, pnl_pct: -75, first_trade_at: '2026-11-24T08:30:00Z', last_trade_at: '2026-11-24T09:00:00Z' });
    expect(loss!.summary).toBe('Closed $NEARL: lost $15 (-75.0%), held 30m.');
    expect(closedEntry(agent, { token: TOKEN, sold_usd: 5, held_tokens: '100', last_trade_at: '2026-11-24T09:00:00Z' })).toBeNull();
  });

  it('scores a call by its stance: bearish goes right when the price falls', () => {
    const now = new Date('2026-11-25T09:00:00Z');
    const bull = callResultEntry(agent, { id: 'c_1', createdAt: '2026-11-24T09:00:00Z', token: { address: TOKEN, symbol: 'NEARL' }, stance: 'bullish', atPost: { marketCapUsd: 12_100 }, result: { sincePostPct: 40, peakSincePostPct: 55 } }, now);
    expect(bull).toMatchObject({ kind: 'call_result', id: 'rushr:call_result:c_1', outcome: { movePct: 40, peakPct: 55, ageHours: 24, wentRight: true } });
    expect(bull!.summary).toBe('Bullish call on $NEARL at $12.1K: +40.0% after 24h (peak +55.0%), went my way.');
    const bear = callResultEntry(agent, { id: 'c_2', createdAt: '2026-11-24T09:00:00Z', token: { address: TOKEN, symbol: 'NEARL' }, stance: 'bearish', result: { sincePostPct: -20 } }, now);
    expect(bear!.outcome).toMatchObject({ wentRight: true });
    expect(callResultEntry(agent, { id: 'c_3', createdAt: '2026-11-24T09:00:00Z', token: { address: TOKEN }, stance: 'bullish', result: null }, now)).toBeNull();
  });
});
