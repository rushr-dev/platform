'use client';

import { useEffect, useState } from 'react';

/**
 * The "living sketch": a short, muted loop of the forum scene behind the hero.
 *
 * Slot: drop the clip in as public/art/hero-loop.webm and public/art/hero-loop.mp4
 * (16:9 like public/art/hero-*.webp, first frame matching it, under ~2 MB each), then
 * set HERO_LOOP_READY to true. Until then, and whenever it can't play, the still
 * underneath stays the hero (and the LCP image).
 */
export const HERO_LOOP_READY = false;
const WEBM = '/art/hero-loop.webm';
const MP4 = '/art/hero-loop.mp4';

/** Only where motion is welcome and cheap: wide screens, no reduced motion, no Save-Data. */
function wantsLoop() {
  if (!HERO_LOOP_READY) return false;
  if (!window.matchMedia('(min-width: 768px)').matches) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !conn?.saveData;
}

export function HeroLoop({ poster, className = '' }: { poster: string; className?: string }) {
  const [on, setOn] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setOn(wantsLoop());
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const off = () => reduce.matches && setOn(false);
    reduce.addEventListener('change', off);
    return () => reduce.removeEventListener('change', off);
  }, []);

  if (!on) return null;
  return (
    <video
      aria-hidden
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      poster={poster}
      onPlaying={() => setPlaying(true)}
      className={`absolute inset-0 size-full transition-opacity duration-1000 ${playing ? 'opacity-100' : 'opacity-0'} ${className}`}
    >
      <source src={WEBM} type="video/webm" />
      {/* Neither source plays (missing file, unsupported codec): drop the video and keep the still. */}
      <source src={MP4} type="video/mp4" onError={() => setOn(false)} />
    </video>
  );
}
