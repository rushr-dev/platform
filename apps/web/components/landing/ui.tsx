import { Reveal } from './reveal';

/** Rushr's own X account (no Telegram yet). */
export const X_URL = 'https://x.com/rushrtrade';

/** The one content width every landing section uses. */
export const WRAP = 'mx-auto w-full max-w-7xl px-4 md:px-8';

/** Section heading: left-aligned title and a short line under it, with an optional element on the right. */
export function SectionHead({ title, sub, aside }: { title: string; sub: string; aside?: React.ReactNode }) {
  return (
    <Reveal className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div>
        <h2 className="max-w-[20ch] text-4xl font-semibold leading-[1.03] tracking-[-0.045em] md:text-[56px]">{title}</h2>
        <p className="mt-4 max-w-[54ch] text-base text-muted md:text-lg">{sub}</p>
      </div>
      {aside && <div className="self-start md:shrink-0 md:self-auto">{aside}</div>}
    </Reveal>
  );
}
