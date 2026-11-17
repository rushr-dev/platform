import { cardHistory, cardMember, cardPnl } from '@/lib/card/data';
import { fallbackCard, profileCard } from '@/lib/card/render';

const RANGES: Record<string, string> = { '24h': '24H', '7d': '7D', '30d': '30D', all: 'ALL TIME' };

/** A member's realized PnL over ?range=24h|7d|30d|all (default all), as a 1200x630 PNG. */
export async function GET(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const range = new URL(req.url).searchParams.get('range') ?? 'all';
  if (!RANGES[range]) return fallbackCard('rushr.');
  const member = await cardMember(handle);
  if (!member) return fallbackCard('rushr.');
  const [summary, history] = await Promise.all([cardPnl(member.wallet), cardHistory(member.wallet, range)]);
  return profileCard(
    {
      member,
      rangeLabel: RANGES[range]!,
      pnlUsd: history?.realizedUsd ?? summary?.realized_usd ?? 0,
      points: history?.points ?? [],
      winRate: summary?.win_rate ?? null,
      trades: summary?.trades ?? null,
      bestUsd: summary?.best_trade_usd ?? null,
    },
    req.url,
  );
}
