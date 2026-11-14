import { Composition, Still } from 'remotion';
import { Announce, ANNOUNCE_DEFAULTS } from './video/Announce';
import { OgCard } from './banner/OgCard';
import { XBanner } from './banner/XBanner';

export const Root = () => (
  <>
    {/* X (Twitter) header: 1500×500. */}
    <Still id="XBanner" component={XBanner} width={1500} height={500} />
    {/* Link preview card for X, Telegram and Discord: 1200×630. */}
    <Still id="OgCard" component={OgCard} width={1200} height={630} />
    {/* X announcement loop: 1920×1080, 15 s at 30 fps. */}
    <Composition id="Announce" component={Announce} defaultProps={ANNOUNCE_DEFAULTS} width={1920} height={1080} fps={30} durationInFrames={450} />
  </>
);
