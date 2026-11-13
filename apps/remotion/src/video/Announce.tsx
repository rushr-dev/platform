import type { ReactNode } from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Loop,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Geist';
import { loadFont as loadMono } from '@remotion/google-fonts/GeistMono';

const { fontFamily } = loadFont('normal', { weights: ['400', '500', '600'], subsets: ['latin'] });
const { fontFamily: mono } = loadMono('normal', { weights: ['500'], subsets: ['latin'] });

const INK = '#18201a';
const MUTED = '#5c645b';
const GREEN = '#2a8a22';
const LIME = '#36d42a';
const PAPER = '247, 245, 242';

export type AnnounceProps = {
  /** A looping background clip in public/ (e.g. the Grok animation of the hero art). Without it, the still art drifts. */
  bgVideo?: string | null;
  /** Length of one background loop, in seconds. */
  bgSeconds?: number;
  /** A music file in public/ (mp3/wav/m4a). Faded in and out. */
  music?: string | null;
  /** Music level, 0-1. */
  musicVolume?: number;
};

export const ANNOUNCE_DEFAULTS: AnnounceProps = { bgVideo: null, bgSeconds: 6, music: null, musicVolume: 0.8 };

/* ------------------------------------------------------------------ motion helpers */

/** 0→1 spring starting at `at` (frames). */
function useIn(at: number, damping = 16, stiffness = 120) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: { damping, stiffness, mass: 0.8 } });
}

/** 1 until `at`, then eases to 0 over `len` frames. */
function useOut(at: number, len = 12) {
  const frame = useCurrentFrame();
  return interpolate(frame, [at, at + len], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
}

/** Words rise out of a mask one after another, then slide up and away together. */
function Words({ text, at, out, size, weight = 600, color = INK, stagger = 3, accent }: {
  text: string; at: number; out: number; size: number; weight?: number; color?: string; stagger?: number; accent?: string[];
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const leave = interpolate(frame, [out, out + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: size * 0.26, rowGap: size * 0.06, maxWidth: 1400 }}>
      {text.split(' ').map((w, i) => {
        const s = spring({ frame: frame - at - i * stagger, fps, config: { damping: 18, stiffness: 140, mass: 0.7 } });
        return (
          <span key={i} style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: size * 0.12, marginBottom: -size * 0.12 }}>
            <span
              style={{
                display: 'inline-block',
                fontFamily,
                fontWeight: weight,
                fontSize: size,
                letterSpacing: '-0.04em',
                lineHeight: 1.05,
                color: accent?.includes(w) ? GREEN : color,
                transform: `translateY(${(1 - s) * 105 - leave * 105}%)`,
                opacity: 1 - leave,
              }}
            >
              {w}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const Eyebrow = ({ children, at, out }: { children: ReactNode; at: number; out: number }) => {
  const s = useIn(at, 20, 90);
  const o = useOut(out);
  return (
    <div
      style={{
        fontFamily: mono,
        fontWeight: 500,
        fontSize: 24,
        letterSpacing: `${0.12 + s * 0.1}em`,
        textTransform: 'uppercase',
        color: MUTED,
        opacity: s * o,
      }}
    >
      {children}
    </div>
  );
};

/* ------------------------------------------------------------------ scenes */

/** The wordmark: the R mark springs in, then the letters cascade up. */
function Wordmark({ at, out }: { at: number; out: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mark = spring({ frame: frame - at, fps, config: { damping: 11, stiffness: 110, mass: 0.9 } });
  const o = useOut(out, 10);
  const lift = interpolate(frame, [out, out + 10], [0, -40], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 34, opacity: o, transform: `translateY(${lift}px)` }}>
      <Img
        src={staticFile('logo-mark.png')}
        style={{ width: 156, height: 156, transform: `scale(${0.4 + mark * 0.6}) rotate(${(1 - mark) * -30}deg)`, opacity: Math.min(1, mark * 1.4) }}
      />
      <div style={{ display: 'flex', fontFamily, fontWeight: 600, fontSize: 210, letterSpacing: '-0.05em', lineHeight: 1, color: INK, paddingBottom: 14 }}>
        {'rushr.'.split('').map((ch, i) => {
          const s = spring({ frame: frame - at - 6 - i * 3, fps, config: { damping: 14, stiffness: 150, mass: 0.6 } });
          return (
            <span key={i} style={{ display: 'inline-block', transform: `translateY(${(1 - s) * 60}px)`, opacity: s, filter: `blur(${(1 - s) * 8}px)` }}>
              {ch}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ label, at, out }: { label: string; at: number; out: number }) {
  const s = useIn(at, 11, 160);
  const o = useOut(out, 10);
  return (
    <div
      style={{
        transform: `scale(${0.6 + s * 0.4}) translateY(${(1 - s) * 30}px)`,
        opacity: Math.min(1, s * 1.5) * o,
        fontFamily,
        fontWeight: 500,
        fontSize: 48,
        letterSpacing: '-0.02em',
        color: INK,
        padding: '20px 38px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.9)',
        border: '1.5px solid rgba(24,32,26,0.12)',
        boxShadow: '0 18px 40px -24px rgba(24,32,26,0.35)',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
      }}
    >
      <span style={{ width: 16, height: 16, borderRadius: 99, background: LIME, transform: `scale(${s})` }} />
      {label}
    </div>
  );
}

function Finale({ at, out }: { at: number; out: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sweep = spring({ frame: frame - at - 16, fps, config: { damping: 20, stiffness: 80 } });
  const url = 'app.rushr.trade';
  const typed = Math.max(0, Math.min(url.length, Math.floor((frame - at - 22) / 1.4)));
  const o = useOut(out, 12);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30, opacity: o }}>
      <Eyebrow at={at} out={out + 100}>
        Built on Robinhood Chain
      </Eyebrow>
      <div style={{ position: 'relative' }}>
        <Words text="Beta now open." at={at + 4} out={out + 100} size={124} accent={['open.']} />
        <div
          style={{
            position: 'absolute',
            right: 10,
            bottom: -6,
            width: 300,
            height: 10,
            borderRadius: 99,
            background: LIME,
            transform: `scaleX(${sweep})`,
            transformOrigin: 'left center',
          }}
        />
      </div>
      <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 34, letterSpacing: '0.04em', color: INK, marginTop: 8, minHeight: 44 }}>
        {url.slice(0, typed)}
        <span style={{ opacity: Math.floor(frame / 8) % 2 ? 1 : 0, color: GREEN }}>▍</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ composition */

/**
 * X announcement (1920x1080, 15 s at 30 fps). A looping animation of the forum art sits behind kinetic copy:
 * wordmark → open social trading → community → pillars → beta open. Starts and ends on the bare background, so it
 * loops cleanly on X. Robinhood Chain appears as text only (their brand rules keep their logo out of AI imagery).
 */
export const Announce = ({ bgVideo, bgSeconds = 6, music, musicVolume = 0.8 }: AnnounceProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / durationInFrames;
  const drift = Math.sin(t * Math.PI * 2) * 160;
  const zoom = 1.06 + Math.sin(t * Math.PI * 2 + Math.PI / 2) * 0.02;

  return (
    <AbsoluteFill style={{ backgroundColor: `rgb(${PAPER})`, overflow: 'hidden' }}>
      {bgVideo ? (
        <Loop durationInFrames={Math.round(bgSeconds * fps)}>
          <OffthreadVideo src={staticFile(bgVideo)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Loop>
      ) : (
        <Img
          src={staticFile('forum-2560.webp')}
          style={{
            position: 'absolute',
            height: 1080,
            width: 3240,
            left: '50%',
            top: 0,
            transform: `translateX(calc(-50% + ${drift}px)) scale(${zoom})`,
            transformOrigin: 'center 70%',
          }}
        />
      )}
      {/* Paper glow keeps the copy readable over the moving art. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 46% 48% at 50% 47%, rgba(${PAPER},0.95) 0%, rgba(${PAPER},0.88) 45%, rgba(${PAPER},0.5) 72%, rgba(${PAPER},0) 100%)`,
        }}
      />

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        {frame < 100 && <Wordmark at={8} out={86} />}
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
        {frame >= 92 && frame < 190 && (
          <>
            <Eyebrow at={94} out={176}>For humans and AI agents</Eyebrow>
            <Words text="Open social trading." at={98} out={176} size={112} accent={['social']} />
          </>
        )}
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30 }}>
        {frame >= 188 && frame < 286 && (
          <>
            <Eyebrow at={190} out={272}>Open source</Eyebrow>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Words text="Built by the community," at={194} out={272} size={96} stagger={2} />
              <Words text="for the community." at={204} out={272} size={96} stagger={2} accent={['community.']} />
            </div>
          </>
        )}
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        {frame >= 284 && frame < 370 && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1600 }}>
            <Chip label="Non-custodial" at={288} out={356} />
            <Chip label="Fast trades" at={296} out={356} />
            <Chip label="Low fees" at={304} out={356} />
          </div>
        )}
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        {frame >= 366 && <Finale at={368} out={432} />}
      </AbsoluteFill>

      {music ? <Audio src={staticFile(music)} volume={(f) => musicVolume * interpolate(f, [0, 20, durationInFrames - 30, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} /> : null}
    </AbsoluteFill>
  );
};
