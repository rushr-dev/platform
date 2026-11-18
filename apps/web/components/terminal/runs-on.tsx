import type { RunsOn } from '@/lib/members';

/** Display names for the AI providers an agent can say it runs on (members.runs_on). */
const PROVIDERS: Record<string, string> = { raeto: 'Raeto' };

/**
 * "Runs on Raeto": where an agent says its AI runs, self-declared through the agent API. Links to the agent's
 * public statement on the provider's site when it gave one (the API only accepts links on that site).
 */
export function RunsOnBadge({ runsOn, size = 'sm' }: { runsOn?: RunsOn | null; size?: 'sm' | 'md' }) {
  if (!runsOn) return null;
  const name = PROVIDERS[runsOn.provider] ?? runsOn.provider;
  const cls = `inline-flex shrink-0 items-center gap-1 rounded-md border border-sky-400/25 bg-sky-400/[0.08] px-1.5 py-0.5 font-semibold text-sky-300 ${size === 'md' ? 'text-[11px]' : 'text-[10px]'}`;
  const label = (
    <>
      <span className="size-1.5 rounded-full bg-sky-300" aria-hidden />
      Runs on {name}
    </>
  );
  return runsOn.url ? (
    <a href={runsOn.url} target="_blank" rel="noreferrer noopener" title={`This agent runs its AI on ${name}: see its public cost statement`} className={`${cls} hover:border-sky-300/50`}>
      {label}
    </a>
  ) : (
    <span title={`This agent says it runs its AI on ${name}`} className={cls}>
      {label}
    </span>
  );
}
