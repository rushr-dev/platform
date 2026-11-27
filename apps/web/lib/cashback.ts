'use client';

import { useEffect, useState } from 'react';
import { authed } from './members';

/** GET /v1/me/cashback: the signed-in member's cashback (30% of the fee they paid), per fee token, raw units. */
export interface CashbackRow {
  fee_token: string;
  trades: number;
  /** Everything earned: cashback + referral share. */
  accrued: string;
  /** Cashback on the member's own trades. */
  cashback?: string;
  /** The member's referral share of the fees paid by people they referred. */
  referral?: string;
  paid: string;
  /** In a weekly batch waiting for the Safe's signers. */
  pending: string;
  /** Not paid or batched yet: goes in the next weekly payout (if above the minimum). */
  owed: string;
}

export interface CashbackPayout {
  batch: string;
  fee_token: string;
  amount: string;
  status: 'pending' | 'paid';
  tx_hash: string | null;
  created_at: string;
  paid_at: string | null;
  /** At today's ETH price. */
  usd: number | null;
}

export interface Cashback {
  shareBps: number;
  cashback: CashbackRow[];
  payouts: CashbackPayout[];
  /** USD totals at today's ETH price (null when the price is unknown). */
  usd: { ethUsd: number | null; earned: number | null; cashback?: number | null; referral?: number | null; paid: number | null; nextPayout: number | null };
  /** `next`: the next payout day, YYYY-MM-DD (UTC). */
  payout: { schedule: 'weekly'; next: string; weekday: string; min: Record<string, string> };
}

export async function getCashback(): Promise<Cashback | null> {
  const r = await authed('/me/cashback').catch(() => null);
  if (!r?.ok) return null;
  return (await r.json().catch(() => null)) as Cashback | null;
}

/** Ledger confirmation takes from a few seconds to a couple of minutes. */
const AFTER_TRADE_MS = [20_000, 60_000, 150_000];

/** The member's cashback: read when `enabled` turns true, and again after each of the member's trades. */
export function useCashback(enabled: boolean): { data: Cashback | null; state: 'loading' | 'ready' | 'unavailable' } {
  const [data, setData] = useState<Cashback | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [tick, setTick] = useState(0);
  // After the member's own trade (the `rushr:trade` event), read again once the ledger has had time to confirm it.
  useEffect(() => {
    const timers: number[] = [];
    const onTrade = () => AFTER_TRADE_MS.forEach((ms) => timers.push(window.setTimeout(() => setTick((n) => n + 1), ms)));
    window.addEventListener('rushr:trade', onTrade);
    return () => {
      window.removeEventListener('rushr:trade', onTrade);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void getCashback().then((c) => {
      if (!live) return;
      setData(c);
      setState(c ? 'ready' : 'unavailable');
    });
    return () => {
      live = false;
    };
  }, [enabled, tick]);
  return { data, state };
}
