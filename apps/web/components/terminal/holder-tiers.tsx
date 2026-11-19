'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_TRADE_CONFIG, effectiveFeeBps, holderDiscountBps } from '@rushr/trade';
import { erc20Abi, type Address } from 'viem';
import { SealPercent } from '@phosphor-icons/react';
import { publicClient } from '@/lib/balances';
import { useAuth } from '@/lib/auth';
import { compact } from '@/lib/format';

const cfg = DEFAULT_TRADE_CONFIG;
const WEI = 10n ** 18n;
/** Tier sizes as written in the docs: 1M, 10M, 50M. */
const millions = (wei: bigint) => `${Number(wei / WEI / 1_000n) / 1_000}M`;
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/0$/, '')}%`;

/**
 * "Hold $RUSHR, pay less", on the $RUSHR token page: the holder tiers (packages/trade HOLDER_TIERS) with the fee
 * each one pays, and the signed-in wallet's own tier, read from the chain. Re-reads after a confirmed trade.
 */
export function HolderTiers() {
  const wallet = (useAuth().user?.wallet ?? null) as Address | null;
  const [held, setHeld] = useState<bigint | null>(null);

  useEffect(() => {
    if (!wallet) return setHeld(null);
    let live = true;
    const read = () =>
      publicClient()
        .readContract({ address: cfg.rushrToken, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
        .then((b) => live && setHeld(b))
        .catch(() => undefined);
    read();
    const onTrade = (e: Event) => (e as CustomEvent<{ phase: string }>).detail?.phase === 'confirmed' && read();
    window.addEventListener('rushr:trade', onTrade);
    return () => {
      live = false;
      window.removeEventListener('rushr:trade', onTrade);
    };
  }, [wallet]);

  const mine = held != null ? holderDiscountBps(cfg, held) : 0;
  const tiers = [...cfg.holderTiers].reverse(); // smallest first
  const next = held != null ? tiers.find((t) => held < t.min) : null;

  return (
    <div className="rounded-2xl border border-brand/25 bg-brand/[0.05] p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <SealPercent size={16} weight="fill" className="text-brand" /> Hold $RUSHR, pay less
      </div>
      <p className="mb-3 text-xs text-muted">Your wallet&apos;s $RUSHR lowers the Rushr fee on every trade, on any token. Stacks with referral discounts.</p>
      <div className="space-y-1.5">
        <Tier label="No $RUSHR" fee={cfg.feeBps} active={held != null && mine === 0} />
        {tiers.map((t) => (
          <Tier key={String(t.min)} label={`${millions(t.min)}+ $RUSHR`} off={t.discountBps} fee={effectiveFeeBps(cfg, null, t.discountBps)} active={mine === t.discountBps && mine > 0} />
        ))}
      </div>
      {held != null && (
        <p className="mt-3 text-xs text-muted">
          You hold <span className="font-mono text-ink">{compact(Number(held / WEI))}</span> $RUSHR
          {next ? (
            <>
              {' '}
              · <span className="font-mono text-ink">{compact(Number((next.min - held) / WEI) || 1)}</span> more for {next.discountBps / 100}% off
            </>
          ) : (
            ' · top tier'
          )}
        </p>
      )}
    </div>
  );
}

function Tier({ label, off, fee, active }: { label: string; off?: number; fee: number; active: boolean }) {
  return (
    <div className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs ${active ? 'bg-brand/15 ring-1 ring-brand/40' : 'bg-white/[0.03]'}`}>
      <span className={active ? 'font-semibold text-ink' : 'text-muted'}>
        {label}
        {active && <span className="ml-1.5 text-brand">· you</span>}
      </span>
      <span className="font-mono">
        {off ? <span className="mr-2 text-brand">−{off / 100}%</span> : null}
        <span className="text-ink">{pct(fee)}</span>
      </span>
    </div>
  );
}
