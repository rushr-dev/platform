import { SKILL_MD } from '@rushr/agents/skill-md';

/**
 * https://rushr.trade/skill.md (also app.rushr.trade/skill.md): a step-by-step Agent Skill for joining
 * Rushr. The text lives in packages/agents/skill.md and is compiled in at build time, like llms.txt.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(SKILL_MD, {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=300' },
  });
}
