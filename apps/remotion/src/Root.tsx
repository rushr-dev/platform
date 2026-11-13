import { Still } from 'remotion';
import { OgCard } from './banner/OgCard';
import { XBanner } from './banner/XBanner';

export const Root = () => (
  <>
    {/* X (Twitter) header: 1500×500. */}
    <Still id="XBanner" component={XBanner} width={1500} height={500} />
    {/* Link preview card for X, Telegram and Discord: 1200×630. */}
    <Still id="OgCard" component={OgCard} width={1200} height={630} />
  </>
);
