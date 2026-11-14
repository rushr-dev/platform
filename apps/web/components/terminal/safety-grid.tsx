'use client';

import {
  ChefHat,
  CheckCircle,
  Copy,
  Crosshair,
  Crown,
  Detective,
  Fire,
  Key,
  Package,
  Percent,
  Plant,
  SealCheck,
  ShieldCheck,
  Users,
  XCircle,
  type Icon,
} from '@phosphor-icons/react';
import type { TokenDetail } from '@/lib/api';
import { countFmt } from '@/lib/format';

/**
 * Compact grid of safety indicators for the token page (label on top, value below), in the
 * style of other memecoin terminals. Colours follow the levels the signal engine uses for its
 * reasons (packages/core/src/signals/compute.ts): green when fine, amber at "medium", red at
 * "high". A value the API doesn't send shows "–", never a misleading 0.
 */

type Tone = 'good' | 'warn' | 'bad' | 'plain' | 'unknown';

interface Cell {
  key: string;
  label: string;
  icon: Icon;
  value: string;
  tone: Tone;
  /** Plain-words explanation, shown on hover. */
  help: string;
  /** Show a ✓ / ✗ next to the value. */
  mark?: 'ok' | 'no';
}

const NONE = '–';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pc = (n: number | null, digits = 1) => (n == null ? NONE : `${Number(n.toFixed(digits))}%`);
/** Green below `warn`, amber from `warn`, red from `bad`; unknown when there is no value. */
const level = (n: number | null, warn: number, bad = Infinity): Tone => (n == null ? 'unknown' : n >= bad ? 'bad' : n >= warn ? 'warn' : 'good');

/** Fields the API is adding; read loosely so the grid picks them up as soon as they ship. */
type Extra = {
  no_sells?: boolean | null;
  farm?: boolean | null;
  burnt_pct?: number | null;
  verified?: boolean | null;
  renounced?: boolean | null;
  bundled_still_held_pct?: number | null;
};
type ExtraSignals = {
  noSells?: boolean;
  burntPct?: number | null;
  verified?: boolean | null;
  renounced?: boolean | null;
  bundledStillHeldPct?: number | null;
  dev?: { farm?: boolean };
};

function yesNo(v: boolean | null | undefined, goodWhen: boolean): Pick<Cell, 'value' | 'tone' | 'mark'> {
  if (v == null) return { value: NONE, tone: 'unknown' };
  const ok = v === goodWhen;
  return { value: ok ? 'Yes' : 'No', tone: ok ? 'good' : 'bad', mark: ok ? 'ok' : 'no' };
}

export function safetyCells(t: TokenDetail): Cell[] {
  const x = t as TokenDetail & Extra;
  const s = (t.signals ?? {}) as NonNullable<TokenDetail['signals']> & ExtraSignals;

  const top10 = num(t.top10_pct);
  const dev = num(t.dev_pct);
  const snipersPct = num(t.snipers_pct);
  const sniperCount = num(s.sniperCount);
  const insiders = num(t.insiders_pct);
  const bundled = num(t.bundled_pct);
  const bundledHeld = num(x.bundled_still_held_pct ?? s.bundledStillHeldPct);
  const fresh = num(t.fresh_pct);
  const buyTax = num(x.buy_tax_bps) != null ? x.buy_tax_bps! / 100 : num(t.buy_tax_pct);
  const sellTax = num(x.sell_tax_bps) != null ? x.sell_tax_bps! / 100 : num(t.sell_tax_pct);
  const noSells = x.no_sells ?? s.noSells ?? null;
  const farm = x.farm ?? s.dev?.farm ?? null;
  const burnt = num(x.burnt_pct ?? s.burntPct);

  const cells: Cell[] = [
    {
      key: 'top10',
      label: 'Top 10',
      icon: Crown,
      value: pc(top10),
      tone: level(top10, 30, 50),
      mark: top10 != null && top10 < 30 ? 'ok' : undefined,
      help: 'Share of the supply held by the 10 biggest wallets. Above 30% a few wallets can move the price a lot.',
    },
    {
      key: 'dev',
      label: 'DEV',
      icon: ChefHat,
      value: pc(dev),
      tone: level(dev, 10),
      help: 'Share of the supply the creator still holds. A big dev bag can be dumped on buyers.',
    },
    {
      key: 'holders',
      label: 'Holders',
      icon: Users,
      value: num(t.holders) == null ? NONE : countFmt(t.holders),
      tone: num(t.holders) == null ? 'unknown' : 'plain',
      help: 'Wallets holding the token right now.',
    },
    {
      key: 'snipers',
      label: 'Snipers',
      icon: Crosshair,
      // The count, coloured by the share they bought (the share is in the hover text).
      value: sniperCount == null ? pc(snipersPct) : String(sniperCount),
      tone: level(snipersPct, 15),
      help: `Wallets that bought in the first seconds after launch, usually bots${
        sniperCount != null && snipersPct != null ? `: ${sniperCount} wallets bought ${pc(snipersPct)} of the supply` : ''
      }.`,
    },
    {
      key: 'insiders',
      label: 'Insiders',
      icon: Detective,
      value: pc(insiders),
      tone: level(insiders, 5, 15),
      help: 'Share held by wallets linked to the creator, for example funded from the same wallet.',
    },
    {
      key: 'bundler',
      label: 'Bundler',
      icon: Package,
      value: pc(bundled),
      tone: bundledHeld != null && bundledHeld >= 20 ? 'bad' : level(bundled, 10),
      help: 'Share bought in the launch block by wallets acting together. Bundles often sell together.',
    },
    farm || t.copycat
      ? {
          key: 'clone',
          label: farm ? 'Farm' : 'Copycat',
          icon: Copy,
          value: 'Yes',
          tone: 'bad',
          mark: 'no',
          help: farm
            ? 'Part of a launch farm: many copies of this token were made by fresh wallets.'
            : 'A copy of another token with the same ticker that has more real holders.',
        }
      : {
          key: 'fresh',
          label: 'Fresh',
          icon: Plant,
          value: pc(fresh),
          tone: level(fresh, 50),
          help: 'Share of the top holders that are brand-new wallets. Lots of fresh wallets can mean one person spread their buys.',
        },
    {
      key: 'tax',
      label: 'Tax',
      icon: Percent,
      value: buyTax == null && sellTax == null ? NONE : `${buyTax == null ? NONE : Number(buyTax.toFixed(1))} / ${pc(sellTax)}`,
      tone: buyTax == null && sellTax == null ? 'unknown' : (sellTax ?? 0) >= 50 ? 'bad' : (sellTax ?? 0) >= 10 || (buyTax ?? 0) >= 10 ? 'warn' : 'good',
      help: 'Fee the token takes on every buy / sell. High sell tax traps buyers.',
    },
    {
      key: 'honeypot',
      label: 'No honeypot',
      icon: ShieldCheck,
      ...yesNo(noSells == null ? null : !noSells, true),
      help: noSells ? 'Plenty of buys and no sells yet: the token may not be sellable.' : 'Sells are going through, so the token looks sellable.',
    },
    {
      key: 'verified',
      label: 'Verified',
      icon: SealCheck,
      ...yesNo(x.verified ?? s.verified, true),
      help: 'Whether the contract source code is published and verified on the explorer.',
    },
    {
      key: 'renounced',
      label: 'Renounced',
      icon: Key,
      ...yesNo(x.renounced ?? s.renounced, true),
      help: 'Whether the creator gave up control of the contract, so they can no longer change it.',
    },
  ];
  // Burn share ships with the next API update; the cell stays hidden until the field arrives.
  if (burnt != null) {
    cells.push({
      key: 'burnt',
      label: 'Burnt',
      icon: Fire,
      value: pc(burnt),
      tone: 'plain',
      help: 'Share of the supply sent to burn addresses, gone for good.',
    });
  }
  return cells;
}

const TONE: Record<Tone, string> = {
  good: 'text-go',
  warn: 'text-risk-medium',
  bad: 'text-risk-high',
  plain: 'text-ink',
  unknown: 'text-muted',
};

export function SafetyGrid({ t, className = '' }: { t: TokenDetail; className?: string }) {
  const cells = safetyCells(t);
  return (
    <dl className={`grid grid-cols-3 gap-1 sm:grid-cols-4 ${className}`} aria-label="Safety indicators">
      {cells.map((c) => {
        const Mark = c.mark === 'ok' ? CheckCircle : XCircle;
        return (
          <div key={c.key} title={c.help} className="min-w-0 cursor-help rounded-lg bg-white/[0.03] px-1.5 py-1.5">
            {/* Label gets the full width; the icon sits with the value, as on other terminals. */}
            <dt className="truncate text-[10px] text-muted">{c.label}</dt>
            <dd className={`mt-0.5 flex items-center gap-1 font-mono text-xs font-semibold ${TONE[c.tone]}`}>
              {/* A ✓ / ✗ already says it all; leaving the icon out keeps narrow cells from clipping. */}
              {!c.mark && <c.icon size={12} weight="bold" className="shrink-0 opacity-80" aria-hidden />}
              <span className="truncate">{c.value}</span>
              {c.mark && <Mark size={12} weight="fill" className="shrink-0" aria-label={c.mark === 'ok' ? 'fine' : 'flagged'} />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
