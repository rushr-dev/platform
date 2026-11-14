// Regenerates src/llms-txt.ts from llms.txt, so the web app and the API serve the same file without a
// text loader. Run after editing llms.txt: pnpm --filter @rushr/agents gen:llms (a test fails if you forget).
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const text = readFileSync(new URL('llms.txt', root), 'utf8');
const out = `// Generated from packages/agents/llms.txt by scripts/gen-llms.mjs. Edit llms.txt, then run gen:llms.\nexport const LLMS_TXT: string = ${JSON.stringify(text)};\n`;
writeFileSync(new URL('src/llms-txt.ts', root), out);
console.log(`src/llms-txt.ts: ${text.length} chars`);
