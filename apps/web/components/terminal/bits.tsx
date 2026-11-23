'use client';

import { stockLogo } from '@/lib/stock-logos';
import { useState } from 'react';
import { CircleNotch, Globe, MagnifyingGlass, TelegramLogo, XLogo } from '@phosphor-icons/react';
import type { RiskLevel, TokenCard } from '@/lib/api';
import { LAUNCHPAD_LABEL, LAUNCHPAD_LOGO } from '@/lib/format';
import { GeneratedAvatar } from './avatar';
import { SHOW_RISK } from '@/lib/risk-labels';

/** Icons go through our cached proxy (IPFS gateways are slow and flaky). */
export const iconSrc = (url: string) => `/api/img?u=${encodeURIComponent(url)}`;

/**
 * Token icon. The generated avatar (see ./avatar) is always drawn first, at the final size, and the
 * real icon is laid over it once it loads, so there is no empty circle while loading, no layout
 * shift when an icon arrives later over the live feed, and a clean avatar if it never does.
 */
export function TokenAvatar({
  t,
  size = 40,
  badge = false,
  migrated = false,
  shape = 'circle',
}: {
  t: Pick<TokenCard, 'address' | 'symbol' | 'launchpad'> & { image_url?: string | null };
  size?: number;
  badge?: boolean;
  /** Badge rim: silver while on the launchpad's curve (or a plain pool), gold once migrated. */
  migrated?: boolean;
  /** Rounded squares or circles (the default). */
  shape?: 'circle' | 'square';
}) {
  const round = shape === 'square' ? 'rounded-[22%]' : 'rounded-full';
  // Load state is keyed by URL, so a new image_url starts fresh.
  const [img, setImg] = useState<{ url: string; status: 'ok' | 'failed' } | null>(null);
  // Verified Robinhood stock tokens show our hosted company logo (lib/stock-logos.ts) first: their own token
  // image, where one exists, is Robinhood's generic token icon rather than the company's.
  const url = stockLogo(t.address) || t.image_url || null;
  const status = url && img?.url === url ? img.status : 'loading';
  const loaded = status === 'ok';
  return (
    <span className="relative block shrink-0" style={{ width: size, height: size }}>
      <span className={`absolute inset-0 overflow-hidden ${round}`}>
        <span
          className={`absolute inset-0 transition-opacity duration-200 ${loaded ? 'opacity-0' : 'opacity-100'}`}
        >
          <GeneratedAvatar address={t.address} symbol={t.symbol} size={size} />
        </span>
        {url && status !== 'failed' && (
          <img
            key={url}
            src={url.startsWith('/') ? url : iconSrc(url)}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            // Already in cache (or loaded before hydration): onLoad won't fire again, so check here.
            ref={(el) => {
              if (el?.complete && el.naturalWidth > 0 && !loaded) setImg({ url, status: 'ok' });
            }}
            onLoad={() => setImg({ url, status: 'ok' })}
            onError={() => setImg({ url, status: 'failed' })}
            // Opaque backing once loaded hides the avatar behind transparent PNGs.
            className={`absolute inset-0 size-full ${round} object-cover transition-opacity duration-200 ${loaded ? 'bg-surface-2 opacity-100' : 'opacity-0'}`}
          />
        )}
      </span>
      {badge && t.launchpad && (
        <span className="absolute -bottom-1 -right-1">
          <LaunchpadBadge launchpad={t.launchpad} migrated={migrated} size={size >= 44 ? 18 : 16} />
        </span>
      )}
    </span>
  );
}

const SILVER = '#c9ced6';

/**
 * A launchpad's logo in a small round badge (GMGN-style): silver rim while the token is on the launchpad's
 * curve or a plain pool, gold once it has migrated. Falls back to the name's first letter without a logo.
 */
export function LaunchpadBadge({ launchpad, migrated = false, size = 16 }: { launchpad: string; migrated?: boolean; size?: number }) {
  const label = LAUNCHPAD_LABEL[launchpad] ?? launchpad;
  const logo = LAUNCHPAD_LOGO[launchpad];
  return (
    <span
      title={`${label}${migrated ? ' · migrated' : ''}`}
      className="grid place-items-center overflow-hidden rounded-full bg-surface"
      style={{ width: size, height: size, boxShadow: `0 0 0 1.5px ${migrated ? GOLD : SILVER}, 0 0 0 3px var(--color-surface)` }}
    >
      {logo ? (
        <img src={logo} alt={label} width={size} height={size} className="size-full object-cover" />
      ) : (
        <span className="text-[8px] font-black text-ink">{label.slice(0, 1)}</span>
      )}
    </span>
  );
}

/** What the ring around a token's avatar shows. */
export type AvatarRing = { kind: 'progress'; value: number } | { kind: 'migrated' } | { kind: 'none' };

const CURVE_LAUNCHPADS = new Set(['pons', 'liftfun', 'lift.fun', 'qhooks']);
const GOLD = '#f5c542';

/**
 * Ring for a token: bonding-curve progress (0-1) while on a launchpad curve, a full gold ring once
 * it has migrated to a DEX pool, and a thin neutral ring for plain pools (no curve).
 */
export function ringOf(t: Pick<TokenCard, 'launchpad' | 'bonding_progress'> & { migrated_at?: string | null }, migrated = false): AvatarRing {
  if (migrated || t.migrated_at) return { kind: 'migrated' };
  if (t.bonding_progress != null && t.launchpad && CURVE_LAUNCHPADS.has(t.launchpad)) {
    if (t.bonding_progress >= 1) return { kind: 'migrated' };
    return { kind: 'progress', value: Math.max(0, t.bonding_progress) };
  }
  return { kind: 'none' };
}

/** A token avatar inside a bonding-progress ring, launchpad badge in the corner. */
export function RingedAvatar({
  t,
  size,
  ring,
  badge = false,
}: {
  t: Pick<TokenCard, 'address' | 'symbol' | 'launchpad'> & { image_url?: string | null };
  size: number;
  ring: AvatarRing;
  badge?: boolean;
}) {
  const stroke = ring.kind === 'none' ? 1.5 : 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const inner = size - 8;
  const title =
    ring.kind === 'migrated' ? 'Migrated to a DEX pool' : ring.kind === 'progress' ? `Bonding curve ${Math.round(ring.value * 100)}%` : 'Plain pool (no bonding curve)';
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} title={title}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        {ring.kind !== 'none' && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={ring.kind === 'migrated' ? GOLD : 'var(--color-brand)'}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={ring.kind === 'migrated' ? 0 : c * (1 - Math.min(1, ring.value))}
            className="transition-[stroke-dashoffset] duration-500"
          />
        )}
      </svg>
      <TokenAvatar t={t} size={inner} badge={badge} migrated={ring.kind === 'migrated'} />
    </span>
  );
}

const RISK_TEXT: Record<RiskLevel, string> = {
  high: 'text-risk-high',
  medium: 'text-risk-medium',
  low: 'text-brand',
  unknown: 'text-muted',
};
const RISK_BG: Record<RiskLevel, string> = {
  high: 'bg-risk-high/15 text-risk-high',
  medium: 'bg-risk-medium/15 text-risk-medium',
  low: 'bg-brand/15 text-brand',
  unknown: 'bg-white/[0.06] text-muted',
};

export const riskText = (r: RiskLevel | null) => RISK_TEXT[r ?? 'unknown'];

export function RiskDot({ risk }: { risk: RiskLevel | null }) {
  if (!SHOW_RISK) return null;
  const r = risk ?? 'unknown';
  const bg =
    r === 'high'
      ? 'bg-risk-high'
      : r === 'medium'
        ? 'bg-risk-medium'
        : r === 'low'
          ? 'bg-brand'
          : 'bg-muted/50';
  return <span title={`${r} risk`} className={`inline-block size-1.5 rounded-full ${bg}`} />;
}

export function RiskTag({ risk, className = '' }: { risk: RiskLevel | null; className?: string }) {
  if (!SHOW_RISK) return null;
  const r = risk ?? 'unknown';
  // Safety checks still running: a quiet spinner, not a word competing with real verdicts.
  if (r === 'unknown')
    return (
      <span title="Running safety checks" aria-label="Running safety checks" className={`inline-flex items-center rounded-md bg-white/[0.04] px-1.5 py-0.5 ${className}`}>
        <CircleNotch size={11} weight="bold" className="animate-spin text-muted" />
      </span>
    );
  return (
    <span
      className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${RISK_BG[r]} ${className}`}
    >
      {r === 'low' ? 'clean' : `${r} risk`}
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
  links.push({
    href: `https://x.com/search?q=${t.address}&f=live`,
    label: 'Search contract on X',
    Icon: MagnifyingGlass,
  });
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
