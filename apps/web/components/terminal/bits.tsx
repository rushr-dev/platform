'use client';

import { useState } from 'react';
import { Globe, MagnifyingGlass, TelegramLogo, XLogo } from '@phosphor-icons/react';
import type { RiskLevel, TokenCard } from '@/lib/api';
import { hue, LAUNCHPAD_LABEL } from '@/lib/format';

/** Icons go through our cached proxy (IPFS gateways are slow and flaky). */
export const iconSrc = (url: string) => `/api/img?u=${encodeURIComponent(url)}`;

/** Token icon from launchpad metadata; falls back to a coloured initial if there is none or it fails. */
export function TokenAvatar({
  t,
  size = 40,
  badge = false,
}: {
  t: Pick<TokenCard, 'address' | 'symbol' | 'launchpad'> & { image_url?: string | null };
  size?: number;
  badge?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = t.image_url && failed !== t.image_url;
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {showImage ? (
        <img
          src={iconSrc(t.image_url!)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(t.image_url ?? null)}
          className="size-full rounded-full bg-white/[0.06] object-cover"
        />
      ) : (
        <span
          className="grid size-full place-items-center rounded-full font-bold text-bg"
          style={{ background: hue(t.address), fontSize: size * 0.42 }}
        >
          {(t.symbol || '?').slice(0, 1).toUpperCase()}
        </span>
      )}
      {badge && t.launchpad && (
        <span
          title={LAUNCHPAD_LABEL[t.launchpad] ?? t.launchpad}
          className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border-2 border-surface bg-ink text-[7px] font-black text-bg"
        >
          {(LAUNCHPAD_LABEL[t.launchpad] ?? t.launchpad).slice(0, 1)}
        </span>
      )}
    </span>
  );
}

const RISK_TEXT: Record<RiskLevel, string> = { high: 'text-risk-high', medium: 'text-risk-medium', low: 'text-brand', unknown: 'text-muted' };
const RISK_BG: Record<RiskLevel, string> = {
  high: 'bg-risk-high/15 text-risk-high',
  medium: 'bg-risk-medium/15 text-risk-medium',
  low: 'bg-brand/15 text-brand',
  unknown: 'bg-white/[0.06] text-muted',
};

export const riskText = (r: RiskLevel | null) => RISK_TEXT[r ?? 'unknown'];

export function RiskDot({ risk }: { risk: RiskLevel | null }) {
  const r = risk ?? 'unknown';
  const bg = r === 'high' ? 'bg-risk-high' : r === 'medium' ? 'bg-risk-medium' : r === 'low' ? 'bg-brand' : 'bg-muted/50';
  return <span title={`${r} risk`} className={`inline-block size-1.5 rounded-full ${bg}`} />;
}

export function RiskTag({ risk, className = '' }: { risk: RiskLevel | null; className?: string }) {
  const r = risk ?? 'unknown';
  return (
    <span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${RISK_BG[r]} ${className}`}>
      {r === 'unknown' ? 'checking' : r === 'low' ? 'clean' : `${r} risk`}
    </span>
  );
}

/**
 * Website / X / Telegram links from launchpad metadata, plus a search of X for the contract
 * (catches launches promoted without a linked account). Clicks don't open the row underneath.
 */
export function SocialLinks({
  t,
  size = 13,
  className = '',
}: {
  t: Pick<TokenCard, 'address' | 'website' | 'twitter' | 'telegram'>;
  size?: number;
  className?: string;
}) {
  const links: { href: string; label: string; Icon: typeof Globe }[] = [];
  if (t.website) links.push({ href: t.website, label: 'Website', Icon: Globe });
  if (t.twitter) links.push({ href: t.twitter, label: 'X', Icon: XLogo });
  if (t.telegram) links.push({ href: t.telegram, label: 'Telegram', Icon: TelegramLogo });
  links.push({ href: `https://x.com/search?q=${t.address}&f=live`, label: 'Search contract on X', Icon: MagnifyingGlass });
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      {links.map(({ href, label, Icon }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title={label}
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className="text-muted transition-colors hover:text-ink"
        >
          <Icon size={size} weight="bold" />
        </a>
      ))}
    </span>
  );
}
