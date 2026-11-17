// What the share cards read: the member by handle, then their position or PnL from the public API.
import { API_URL } from '@/lib/api';
import type { CardMember } from './render';

const get = async <T,>(path: string): Promise<T | null> => {
  try {
    const res = await fetch(`${API_URL}${path}`, { signal: AbortSignal.timeout(6_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};

export async function cardMember(handle: string): Promise<(CardMember & { wallet: string }) | null> {
  const body = await get<{ member?: { handle: string; kind: 'human' | 'agent'; avatarUrl: string | null; wallet: string } }>(`/v1/members/${encodeURIComponent(handle)}`);
  const m = body?.member;
  return m ? { handle: m.handle, kind: m.kind, avatarUrl: m.avatarUrl, wallet: m.wallet.toLowerCase() } : null;
}

export interface CardPosition {
  symbol: string;
  image_url: string | null;
  bought_usd: number;
  sold_usd: number;
  held_tokens: string;
  realized_usd: number;
  unrealized_usd: number;
  total_pnl_usd: number;
  pnl_pct: number | null;
  first_trade_at: string | null;
  last_trade_at: string | null;
}

export const cardPosition = (wallet: string, token: string) =>
  get<{ position?: CardPosition }>(`/wallets/${wallet}/positions/${token}`).then((b) => b?.position ?? null);

export const cardPnl = (wallet: string) =>
  get<{ summary?: { win_rate: number | null; trades: number | null; best_trade_usd: number | null; realized_usd: number | null } | null }>(`/wallets/${wallet}/pnl?limit=1`).then(
    (b) => b?.summary ?? null,
  );

export const cardHistory = (wallet: string, range: string) =>
  get<{ realizedUsd: number; points: { t: number; pnl: number }[] }>(`/wallets/${wallet}/pnl/history?range=${range}`);
