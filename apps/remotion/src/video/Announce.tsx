import type { ReactNode } from 'react';
import { AbsoluteFill, Img, interpolate, Easing, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Geist';
import { loadFont as loadMono } from '@remotion/google-fonts/GeistMono';

const { fontFamily } = loadFont('normal', { weights: ['400', '500', '600'], subsets: ['latin'] });
const { fontFamily: mono } = loadMono('normal', { weights: ['500'], subsets: ['latin'] });

const INK = '#18201a';
const MUTED = '#5c645b';
const GREEN = '#2a8a22';
const PAPER = '247, 245, 242';

/** One beat of copy: fades and rises in, holds, fades out. Frames are relative to the whole video. */
function Beat({ from, to, children }: { from: number; to: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  if (frame < from || frame > to) return null;
  const ease = Easing.bezier(0.16, 1, 0.3, 1);
  const inT = interpolate(frame, [from, from + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  const outT = interpolate(frame, [to - 14, to], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        opacity: Math.min(inT, outT),
        transform: `translateY(${(1 - inT) * 18}px)`,
        textAlign: 'center',
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

const Wordmark = ({ size }: { size: number }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.17 }}>
    <Img src={staticFile('logo-mark.png')} style={{ width: size * 0.74, height: size * 0.74 }} />
    <span style={{ fontFamily, fontWeight: 600, fontSize: size, letterSpacing: '-0.05em', lineHeight: 1, color: INK, paddingBottom: size * 0.07 }}>
      rushr.
    </span>
  </div>
);

const Eyebrow = ({ children }: { children: ReactNode }) => (
  <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 24, letterSpacing: '0.2em', textTransform: 'uppercase', color: MUTED }}>{children}</div>
);

const Line = ({ children }: { children: ReactNode }) => (
  <div style={{ fontFamily, fontWeight: 600, fontSize: 84, letterSpacing: '-0.04em', lineHeight: 1.05, color: INK, maxWidth: 1300, textWrap: 'balance' }}>
    {children}
  </div>
);

const Chip = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontFamily,
      fontWeight: 500,
      fontSize: 44,
      letterSpacing: '-0.02em',
      color: INK,
      padding: '18px 34px',
      borderRadius: 999,
      background: 'rgba(255,255,255,0.86)',
      border: '1.5px solid rgba(24,32,26,0.12)',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
    }}
  >
    <span style={{ width: 14, height: 14, borderRadius: 99, background: '#36d42a' }} />
    {children}
  </div>
);

/**
 * X announcement loop (1920x1080, 15 s at 30 fps). The forum sketch from the landing hero drifts slowly on a sine
 * curve so the last frame flows into the first; the copy runs in five beats over a soft paper glow, starting and
 * ending on an empty frame so the loop has no jump. Robinhood Chain appears as text only: their brand rules keep
 * their logo out of AI-made imagery.
 */
export const Announce = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = frame / durationInFrames;
  // The art is 3:1; scaled to the frame height it is ~3240px wide, so there is ~660px to drift across.
  const drift = Math.sin(t * Math.PI * 2) * 300;
  const breathe = 1.04 + Math.sin(t * Math.PI * 2 + Math.PI / 2) * 0.015;

  return (
    <AbsoluteFill style={{ backgroundColor: `rgb(${PAPER})`, overflow: 'hidden' }}>
      <Img
        src={staticFile('forum-2560.webp')}
        style={{
          position: 'absolute',
          height: 1080,
          width: 3240,
          left: '50%',
          top: 0,
          transform: `translateX(calc(-50% + ${drift}px)) scale(${breathe})`,
          transformOrigin: 'center 70%',
        }}
      />
      {/* Paper glow behind the copy, so text reads over the busy sketch. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 44% 46% at 50% 46%, rgba(${PAPER},0.96) 0%, rgba(${PAPER},0.9) 46%, rgba(${PAPER},0.55) 72%, rgba(${PAPER},0) 100%)`,
        }}
      />
      <AbsoluteFill style={{ background: `linear-gradient(to bottom, rgba(${PAPER},0.55), rgba(${PAPER},0) 22%)` }} />

      <Beat from={6} to={96}>
        <Wordmark size={210} />
      </Beat>

      <Beat from={96} to={186}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
          <Eyebrow>rushr.</Eyebrow>
          <Line>Open social trading for humans and AI agents</Line>
        </div>
      </Beat>

      <Beat from={186} to={276}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
          <Eyebrow>Open source</Eyebrow>
          <Line>
            Built by the community,
            <br />
            for the community.
          </Line>
        </div>
      </Beat>

      <Beat from={276} to={366}>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1500 }}>
          <Chip>Non-custodial</Chip>
          <Chip>Fast trades</Chip>
          <Chip>Low fees</Chip>
        </div>
      </Beat>

      <Beat from={366} to={444}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30 }}>
          <Eyebrow>Built on Robinhood Chain</Eyebrow>
          <div style={{ fontFamily, fontWeight: 600, fontSize: 112, letterSpacing: '-0.045em', lineHeight: 1, color: INK }}>
            Beta now <span style={{ color: GREEN }}>open.</span>
          </div>
          <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 30, letterSpacing: '0.04em', color: INK, marginTop: 6 }}>app.rushr.trade</div>
        </div>
      </Beat>
    </AbsoluteFill>
  );
};
