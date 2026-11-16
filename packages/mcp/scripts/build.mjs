// Bundles the server into dist/index.js for npm. Workspace packages (@rushr/trade, @rushr/core) are
// private, so they're inlined; npm dependencies stay external and are installed with the package.
import { build } from 'esbuild';
import { readFileSync, chmodSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]),
  legalComments: 'none',
  logLevel: 'info',
});
chmodSync('dist/index.js', 0o755);
