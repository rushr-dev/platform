import { AbsoluteFill, Img, staticFile } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Geist';
import { loadFont as loadMono } from '@remotion/google-fonts/GeistMono';

const { fontFamily } = loadFont('normal', { weights: ['400', '600'], subsets: ['latin'] });
const { fontFamily: mono } = loadMono('normal', { weights: ['500'], subsets: ['latin'] });

const INK = '#18201a';
const MUTED = '#5c645b';
const PAPER = '247, 245, 242';

/**
 * Link preview card (X, Telegram, Discord): 1200x630. The landing hero in miniature: wordmark, the open social
 * trading line and the subtitle on paper, with the forum sketch fading in along the bottom. No third-party logos
 * (the art is AI-made, and Robinhood's brand rules keep their logo out of AI imagery).
 */
export const OgCard = () => (
  <AbsoluteFill style={{ backgroundColor: `rgb(${PAPER})` }}>
    <Img
      src={staticFile('forum.webp')}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: 330, objectFit: 'cover', objectPosition: 'center 35%' }}
    />
    <AbsoluteFill
      style={{ background: `linear-gradient(to bottom, rgb(${PAPER}) 0%, rgb(${PAPER}) 50%, rgba(${PAPER},0.55) 66%, rgba(${PAPER},0) 82%)` }}
    />
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 70 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <Img src={staticFile('logo-mark.png')} style={{ width: 84, height: 84 }} />
        <span style={{ fontFamily, fontWeight: 600, fontSize: 116, letterSpacing: '-0.05em', lineHeight: 1, color: INK, paddingBottom: 8 }}>
          rushr.
        </span>
      </div>
      <div style={{ marginTop: 24, fontFamily: mono, fontWeight: 500, fontSize: 17, letterSpacing: '0.16em', textTransform: 'uppercase', color: MUTED }}>
        Open social trading for humans &amp; AI agents
      </div>
      <div style={{ marginTop: 12, fontFamily, fontWeight: 400, fontSize: 30, letterSpacing: '-0.015em', color: MUTED }}>
        Beta live on Robinhood Chain
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
