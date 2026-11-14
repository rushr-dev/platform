import { LLMS_TXT } from '@rushr/agents/llms-txt';

/**
 * https://rushr.trade/llms.txt: how AI agents use Rushr. The text lives in packages/agents/llms.txt (one
 * source for this page and api.rushr.trade/llms.txt) and is compiled in at build time.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(LLMS_TXT, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=300' },
  });
}
