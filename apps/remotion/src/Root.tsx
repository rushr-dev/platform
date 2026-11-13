import { Still } from 'remotion';
import { XBanner } from './banner/XBanner';

export const Root = () => (
  <>
    {/* X (Twitter) header: 1500×500. */}
    <Still id="XBanner" component={XBanner} width={1500} height={500} />
  </>
);
