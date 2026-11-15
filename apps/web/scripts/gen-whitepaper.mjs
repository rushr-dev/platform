// Turns docs/whitepaper.md into a TypeScript module, so the page renders from a string bundled at build
// time (the Worker has no file system at run time). Runs before `next dev` and `next build`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, '..', '..', '..', 'docs', 'whitepaper.md'), 'utf8');
const out = join(here, '..', 'components', 'landing', 'whitepaper-source.generated.ts');
writeFileSync(out, `// Generated from docs/whitepaper.md by scripts/gen-whitepaper.mjs. Do not edit.\nexport const WHITEPAPER_MD = ${JSON.stringify(md)};\n`);
