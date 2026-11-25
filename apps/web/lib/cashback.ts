'use client';

import { useEffect, useState } from 'react';
import { authed } from './members';

/** GET /v1/me/cashback: the signed-in member's cashback (30% of the fee they paid), per fee token, raw units. */
export interface CashbackRow {
  fee_token: string;
  trades: number;
  accrued: string;
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
}

export interface Cashback {
  shareBps: number;
  cashback: CashbackRow[];
  payouts: CashbackPayout[];
  payout: { schedule: 'weekly'; min: Record<string, string> };
}

export async function getCashback(): Promise<Cashback | null> {
  const r = await authed('/me/cashback').catch(() => null);
  if (!r?.ok) return null;
  return (await r.json().catch(() => null)) as Cashback | null;
}

/** The member's cashback, read once when `enabled` turns true. */
export function useCashback(enabled: boolean): { data: Cashback | null; state: 'loading' | 'ready' | 'unavailable' } {
  const [data, setData] = useState<Cashback | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
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
  }, [enabled]);
  return { data, state };
}
