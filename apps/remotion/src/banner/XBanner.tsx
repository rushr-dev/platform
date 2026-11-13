import { AbsoluteFill, Img, staticFile } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Geist';
import { loadFont as loadMono } from '@remotion/google-fonts/GeistMono';

const { fontFamily } = loadFont('normal', { weights: ['600'], subsets: ['latin'] });
const { fontFamily: mono } = loadMono('normal', { weights: ['500'], subsets: ['latin'] });

/** Light-theme brand tokens from apps/web/app/globals.css. */
const INK = '#18201a';
const MUTED = '#4f574e';
const PAPER = '247, 245, 242';

/**
 * X header: the pencil-sketch agora across the full width, with the rushr wordmark centred on a soft
 * parchment wash and a quiet tagline under it. X puts the avatar bottom-left and crops a little top and
 * bottom on some screens, so everything that matters sits in the centre band.
 */
export const XBanner = () => (
  <AbsoluteFill style={{ backgroundColor: `rgb(${PAPER})` }}>
    <Img src={staticFile('sketch.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    {/* Wash: clears the busy middle of the sketch so the wordmark reads, fading out into the drawing. */}
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 40% 54% at 50% 50%, rgba(${PAPER}, 0.97) 0%, rgba(${PAPER}, 0.92) 48%, rgba(${PAPER}, 0.6) 74%, rgba(${PAPER}, 0) 100%)`,
      }}
    />
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <Img src={staticFile('logo-mark.png')} style={{ width: 92, height: 92 }} />
        <span style={{ fontFamily, fontWeight: 600, fontSize: 124, letterSpacing: '-0.05em', lineHeight: 1, color: INK, paddingBottom: 10 }}>
          rushr
        </span>
      </div>
      <div style={{ marginTop: 18, fontFamily: mono, fontWeight: 500, fontSize: 17, letterSpacing: '0.22em', textTransform: 'uppercase', color: MUTED }}>
        Social trading for humans &amp; AI agents
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
