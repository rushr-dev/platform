'use client';

import { ChefHat, Crosshair, Crown, Fish, Gift, Package, Plant, Ranking, UserFocus } from '@phosphor-icons/react';
import type { MakerTag } from '@/lib/trades';

/** Wallet labels used across trades, holders and traders. */
export const TAG_META: Record<MakerTag, { label: string; title: string; cls: string; Icon: typeof Crown }> = {
  dev: { label: 'Dev', title: 'Token deployer', cls: 'bg-white/15 text-ink', Icon: ChefHat },
  whale: { label: 'Whale', title: 'Holds 1%+ of supply or made a $2.5K+ trade', cls: 'bg-[#5ec8ff]/15 text-[#5ec8ff]', Icon: Fish },
  top10: { label: 'Top 10', title: 'One of the ten largest holders', cls: 'bg-risk-medium/15 text-risk-medium', Icon: Ranking },
  sniper: { label: 'Sniper', title: 'Bought in the first blocks after launch', cls: 'bg-risk-medium/15 text-risk-medium', Icon: Crosshair },
  bundler: { label: 'Bundler', title: 'Bought in the launch bundle', cls: 'bg-risk-high/15 text-risk-high', Icon: Package },
  insider: { label: 'Insider', title: 'Funded by the dev or a linked wallet', cls: 'bg-risk-high/15 text-risk-high', Icon: UserFocus },
  fresh: { label: 'Fresh', title: 'New wallet with little history', cls: 'bg-brand/15 text-brand', Icon: Plant },
  airdrop: { label: 'Airdrop', title: 'Received tokens without buying', cls: 'bg-[#b58cff]/15 text-[#b58cff]', Icon: Gift },
};

export function TagChip({ tag, compact = false }: { tag: MakerTag; compact?: boolean }) {
  const m = TAG_META[tag];
  return (
    <span title={m.title} className={`inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold leading-tight ${m.cls}`}>
      <m.Icon size={10} weight="bold" />
      {!compact && m.label}
    </span>
  );
}

export function TagList({ tags, compact = false, max = 4 }: { tags: MakerTag[]; compact?: boolean; max?: number }) {
  if (!tags.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5">
      {tags.slice(0, max).map((t) => (
        <TagChip key={t} tag={t} compact={compact} />
      ))}
    </span>
  );
}
