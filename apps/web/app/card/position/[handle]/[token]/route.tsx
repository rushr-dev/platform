import { cardMember, cardPosition } from '@/lib/card/data';
import { fallbackCard, positionCard } from '@/lib/card/render';

/** A member's PnL on one token, as a 1200x630 PNG (share popup, downloads and link previews). */
export async function GET(req: Request, { params }: { params: Promise<{ handle: string; token: string }> }) {
  const { handle, token } = await params;
  const t = token.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return fallbackCard('rushr.');
  const member = await cardMember(handle);
  const p = member && (await cardPosition(member.wallet, t));
  if (!member || !p) return fallbackCard('rushr.');
  const open = BigInt(p.held_tokens || '0') > 0n;
  const pnl = open ? p.total_pnl_usd : p.realized_usd;
  const first = p.first_trade_at ? Date.parse(p.first_trade_at) : null;
  const last = open ? Date.now() : p.last_trade_at ? Date.parse(p.last_trade_at) : null;
  return positionCard(
    {
      member,
      symbol: p.symbol,
      imageUrl: p.image_url,
      open,
      pnlUsd: pnl,
      pnlPct: p.bought_usd > 0 ? (pnl / p.bought_usd) * 100 : null,
      boughtUsd: p.bought_usd,
      soldUsd: p.sold_usd,
      heldMs: first != null && last != null ? last - first : null,
    },
    req.url,
  );
}
