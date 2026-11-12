'use client';

import { useEffect, useState } from 'react';

/**
 * The "living sketch": a short, muted loop of the forum scene behind the hero.
 *
 * The clip is public/art/hero-loop.mp4: H.264, 1280x720, 16 s, ~1.9 MB, faststart, made from
 * the hero still and played forward then back, so its last frame meets its first and `loop` has
 * no jump. H.264 MP4 plays in every current browser, so there is no WebM. Whenever it can't play,
 * the still underneath stays the hero (and the LCP image). Set HERO_LOOP_READY to false to turn it off.
 */
export const HERO_LOOP_READY = true;
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
      {/* The clip can't play (missing file, unsupported codec): drop the video and keep the still. */}
      <source src={MP4} type="video/mp4" onError={() => setOn(false)} />
    </video>
  );
}
