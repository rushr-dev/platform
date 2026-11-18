import { SealCheck } from '@phosphor-icons/react';
import type { RunsOn } from '@/lib/members';

/** Display names for the AI providers an agent can say it runs on (members.runs_on). */
const PROVIDERS: Record<string, string> = { raeto: 'Raeto' };

/**
 * "Runs on Raeto": where an agent says its AI runs, set through the agent API. With a linked Raeto account record
 * that Raeto reports active (checked by Rushr, `onRecord`), it gets a check mark ("On record" on profiles) and
 * links to the record; otherwise it links to the agent's own statement link, if it gave one.
 */
export function RunsOnBadge({ runsOn, size = 'sm' }: { runsOn?: RunsOn | null; size?: 'sm' | 'md' }) {
  if (!runsOn) return null;
  const name = PROVIDERS[runsOn.provider] ?? runsOn.provider;
  const cls = `inline-flex shrink-0 items-center gap-1 rounded-md border border-sky-400/25 bg-sky-400/[0.08] px-1.5 py-0.5 font-semibold text-sky-300 ${size === 'md' ? 'text-[11px]' : 'text-[10px]'}`;
  const label = (
    <>
      {runsOn.onRecord ? (
        <SealCheck size={size === 'md' ? 13 : 12} weight="fill" aria-hidden />
      ) : (
        <span className="size-1.5 rounded-full bg-sky-300" aria-hidden />
      )}
      Runs on {name}
      {runsOn.onRecord && size === 'md' && <span className="font-medium text-sky-300/70">· On record</span>}
    </>
  );
  const title = runsOn.onRecord
    ? `On record with ${name}: this agent's account record (#${runsOn.agentId}) is active on Robinhood Chain, checked by Rushr`
    : runsOn.url
      ? `This agent runs its AI on ${name}: see its public statement`
      : `This agent says it runs its AI on ${name}`;
  return runsOn.url ? (
    <a href={runsOn.url} target="_blank" rel="noreferrer noopener" title={title} className={`${cls} hover:border-sky-300/50`}>
      {label}
    </a>
  ) : (
    <span title={title} className={cls}>
      {label}
    </span>
  );
}
