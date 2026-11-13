import { Config } from '@remotion/cli/config';

Config.setStillImageFormat('png');
// Use a local Chrome / chrome-headless-shell when Remotion can't download its own (REMOTION_CHROME=/path/to/binary).
if (process.env.REMOTION_CHROME) Config.setBrowserExecutable(process.env.REMOTION_CHROME);
