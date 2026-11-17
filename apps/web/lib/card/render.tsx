// Share cards (PnL per position, per profile) as 1200x630 PNGs, rendered on the server with next/og.
// One size serves the share popup, downloads and X / Telegram link previews. The look is the landing's:
// warm paper on the left with the numbers, a pencil sketch on the right.
//
// next/og (satori) draws flexbox only, reads TTF/OTF fonts and PNG/JPEG images: fonts come from Google
// Fonts as TTF, art and the logo from this worker's own assets, token icons through the same IPFS
// gateways as /api/img (only PNG/JPEG are used; anything else falls back to a lettered circle).
import { ImageResponse } from 'next/og';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { httpCandidates } from '@rushr/core';

export const CARD = { width: 1200, height: 630 };

const PAPER = '#f7f5f2';
const INK = '#18201a';
const MUTED = '#5c645b';
const GREEN = '#2a8a22';
const RED = '#c2412d';

/* ------------------------------------------------------------------ loading */

let fonts: Promise<{ name: string; data: ArrayBuffer; weight: 400 | 500 | 600; style: 'normal' }[]> | null = null;

/** Geist (400, 600) and Geist Mono (500) as TTF: Google Fonts serves TTF to clients that don't ask for woff2. */
function loadFonts() {
  fonts ??= (async () => {
    const css = await (await fetch('https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono:wght@500')).text();
    const faces = [...css.matchAll(/font-family: '([^']+)';[\s\S]*?font-weight: (\d+);[\s\S]*?src: url\((https:[^)]+\.ttf)\)/g)];
    if (!faces.length) throw new Error('no fonts');
    return Promise.all(
      faces.map(async ([, family, weight, url]) => ({
        name: family!,
        data: await (await fetch(url!)).arrayBuffer(),
        weight: Number(weight) as 400 | 500 | 600,
        style: 'normal' as const,
      })),
    );
  })().catch((e) => {
    fonts = null; // try again on the next card
    throw e;
  });
  return fonts;
}

const toDataUrl = (buf: ArrayBuffer, type: string) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
};

/** A file from this worker's public/ folder (via the ASSETS binding), as a data URL. */
async function asset(path: string, type: string, base: string): Promise<string | null> {
  try {
    const { env } = getCloudflareContext() as unknown as { env: { ASSETS?: { fetch: (r: Request) => Promise<Response> } } };
    const res = env.ASSETS ? await env.ASSETS.fetch(new Request(new URL(path, base))) : await fetch(new URL(path, base));
    return res.ok ? toDataUrl(await res.arrayBuffer(), type) : null;
  } catch {
    return null;
  }
}

/** A token icon or avatar as a data URL, if a gateway serves it as PNG or JPEG within 4 s. */
async function remoteImage(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  for (const u of httpCandidates(url)) {
    if (!u.startsWith('https://')) continue;
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(4_000), headers: { accept: 'image/png,image/jpeg' } });
      const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!res.ok || !/^image\/(png|jpe?g)$/.test(type)) {
        await res.body?.cancel();
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0 && buf.byteLength < 2_000_000) return toDataUrl(buf, type);
    } catch {
      /* next gateway */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ formatting */

export const money = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${Number((a / 1e6).toFixed(2))}M`;
  if (a >= 1e5) return `$${Number((a / 1e3).toFixed(1))}K`;
  const digits = a >= 100 ? 0 : 2;
  return `$${a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
export const signedMoney = (n: number) => `${n >= 0 ? '+' : '-'}${money(n)}`;
export const signedPct = (n: number) => `${n >= 0 ? '+' : ''}${Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1)}%`;
export const duration = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/* ------------------------------------------------------------------ pieces */

function Letter({ text, size }: { text: string; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: '#e6e2da', color: MUTED, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.45, fontWeight: 600 }}>
      {text.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Pic({ src, size, fallback }: { src: string | null; size: number; fallback: string }) {
  return src ? <img src={src} width={size} height={size} style={{ borderRadius: size, objectFit: 'cover' }} /> : <Letter text={fallback} size={size} />;
}

export interface CardMember {
  handle: string;
  kind: 'human' | 'agent';
  avatarUrl: string | null;
}

/** Paper, art on the right fading into it, and the brand mark, around the card's own content. */
async function Frame({ art, base, member, children }: { art: 'win' | 'loss' | 'profile'; base: string; member: CardMember; children: React.ReactNode }) {
  const [artUrl, logo, avatar] = await Promise.all([asset(`/card/${art}.jpg`, 'image/jpeg', base), asset('/logo-mark.png', 'image/png', base), remoteImage(member.avatarUrl)]);
  return (
    <div style={{ width: CARD.width, height: CARD.height, display: 'flex', position: 'relative', background: PAPER, fontFamily: 'Geist', color: INK }}>
      {artUrl && <img src={artUrl} width={720} height={630} style={{ position: 'absolute', right: 0, top: 0, objectFit: 'cover', objectPosition: 'center' }} />}
      {/* satori draws gradients from backgroundImage only. */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: CARD.width, height: CARD.height, display: 'flex', backgroundImage: `linear-gradient(to right, ${PAPER} 0%, ${PAPER} 46%, rgba(247,245,242,0.9) 54%, rgba(247,245,242,0) 70%)` }} />
      <div style={{ position: 'absolute', left: 72, top: 56, bottom: 56, width: 600, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {logo && <img src={logo} width={34} height={35} />}
          <span style={{ fontSize: 36, fontWeight: 600, letterSpacing: -1.6 }}>rushr.</span>
        </div>
        {children}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Pic src={avatar} size={48} fallback={member.handle} />
            <span style={{ fontSize: 28, fontWeight: 600 }}>@{member.handle}</span>
            <span style={{ fontFamily: 'Geist Mono', fontSize: 15, color: MUTED, border: '2px solid #cfc9bd', borderRadius: 999, padding: '4px 12px' }}>
              {member.kind === 'agent' ? 'AI AGENT' : 'HUMAN'}
            </span>
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', right: 40, bottom: 34, display: 'flex', fontFamily: 'Geist Mono', fontSize: 18, color: INK, background: 'rgba(247,245,242,0.85)', borderRadius: 999, padding: '6px 14px' }}>
        app.rushr.trade
      </div>
    </div>
  );
}

const Stat = ({ k, v }: { k: string; v: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <span style={{ fontFamily: 'Geist Mono', fontSize: 15, color: MUTED, letterSpacing: 1.5 }}>{k.toUpperCase()}</span>
    <span style={{ fontFamily: 'Geist Mono', fontSize: 26, color: INK }}>{v}</span>
  </div>
);

/* ------------------------------------------------------------------ cards */

export interface PositionCardData {
  member: CardMember;
  symbol: string;
  imageUrl: string | null;
  open: boolean;
  pnlUsd: number;
  pnlPct: number | null;
  boughtUsd: number;
  soldUsd: number;
  heldMs: number | null;
}

export async function positionCard(d: PositionCardData, base: string) {
  const up = d.pnlUsd >= 0;
  const color = up ? GREEN : RED;
  const icon = await remoteImage(d.imageUrl);
  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Pic src={icon} size={56} fallback={d.symbol} />
        <span style={{ fontSize: 46, fontWeight: 600, letterSpacing: -1.5 }}>${d.symbol}</span>
        <span style={{ fontFamily: 'Geist Mono', fontSize: 16, color: MUTED, letterSpacing: 2, marginLeft: 6 }}>{d.open ? 'OPEN' : 'CLOSED'}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: d.pnlPct != null && Math.abs(d.pnlPct) >= 1000 ? 112 : 136, fontWeight: 600, letterSpacing: -6, lineHeight: 1, color }}>
          {d.pnlPct != null ? signedPct(d.pnlPct) : signedMoney(d.pnlUsd)}
        </span>
        {d.pnlPct != null && <span style={{ fontFamily: 'Geist Mono', fontSize: 38, color, marginTop: 10 }}>{signedMoney(d.pnlUsd)}</span>}
      </div>
      <div style={{ display: 'flex', gap: 44 }}>
        <Stat k="Bought" v={money(d.boughtUsd)} />
        <Stat k="Sold" v={money(d.soldUsd)} />
        {d.heldMs != null && <Stat k={d.open ? 'Holding' : 'Held'} v={duration(d.heldMs)} />}
      </div>
    </div>
  );
  return render(await Frame({ art: up ? 'win' : 'loss', base, member: d.member, children: body }));
}

export interface ProfileCardData {
  member: CardMember;
  rangeLabel: string;
  pnlUsd: number;
  points: { t: number; pnl: number }[];
  winRate: number | null;
  trades: number | null;
  bestUsd: number | null;
}

/** A step line of cumulative PnL, as an inline SVG (satori draws simple paths). */
function Spark({ points, color }: { points: { t: number; pnl: number }[]; color: string }) {
  const W = 520;
  const H = 110;
  if (points.length < 1) return <div style={{ display: 'flex', width: W, height: 2, background: '#d9d4ca', marginTop: 50, marginBottom: 68 }} />;
  const t0 = points[0]!.t - Math.max(600, Math.round((points.at(-1)!.t - points[0]!.t) * 0.1));
  const t1 = points.at(-1)!.t;
  const vals = [0, ...points.map((p) => p.pnl)];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12);
  let d = `M0 ${y(0)}`;
  for (const p of points) d += ` H${x(p.t).toFixed(1)} V${y(p.pnl).toFixed(1)}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <path d={`M0 ${y(0)} H${W}`} stroke="#cfc9bd" strokeWidth="2" strokeDasharray="6 6" />
      <path d={`${d} V${y(0)} H0 Z`} fill={color} fillOpacity="0.12" />
      <path d={d} stroke={color} strokeWidth="4" fill="none" />
    </svg>
  );
}

export async function profileCard(d: ProfileCardData, base: string) {
  const up = d.pnlUsd >= 0;
  const color = up ? GREEN : RED;
  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={{ fontFamily: 'Geist Mono', fontSize: 18, color: MUTED, letterSpacing: 2.5 }}>REALIZED PNL · {d.rangeLabel}</span>
      <span style={{ fontSize: 120, fontWeight: 600, letterSpacing: -5, lineHeight: 1, color }}>{signedMoney(d.pnlUsd)}</span>
      <Spark points={d.points} color={color} />
      <div style={{ display: 'flex', gap: 44 }}>
        {/* A flex card: the win rate shows when it flatters (half or more of closed trades in profit). */}
        {d.winRate != null && d.winRate >= 0.5 && <Stat k="Win rate" v={`${Math.round(d.winRate * 100)}%`} />}
        {d.trades != null && <Stat k="Trades" v={d.trades.toLocaleString('en-US')} />}
        {d.bestUsd != null && d.bestUsd > 0 && <Stat k="Best trade" v={signedMoney(d.bestUsd)} />}
      </div>
    </div>
  );
  return render(await Frame({ art: 'profile', base, member: d.member, children: body }));
}

async function render(node: React.ReactElement) {
  const font = await loadFonts().catch(() => undefined);
  return new ImageResponse(node, {
    ...CARD,
    fonts: font,
    // Numbers move: let X and Telegram re-fetch after a few minutes, browsers after one.
    headers: { 'cache-control': 'public, max-age=60, s-maxage=300' },
  });
}

/** A plain card for a missing member or position, so a shared link still previews as Rushr. */
export function fallbackCard(text: string) {
  return new ImageResponse(
    (
      <div style={{ width: CARD.width, height: CARD.height, display: 'flex', alignItems: 'center', justifyContent: 'center', background: PAPER, color: INK, fontSize: 56 }}>
        {text}
      </div>
    ),
    { ...CARD, headers: { 'cache-control': 'public, max-age=60, s-maxage=60' } },
  );
}
