// Run one Replicate model and save its output file. Token from REPLICATE_API_TOKEN (apps/remotion/.env.replicate, gitignored).
//   node scripts/replicate.mjs <owner/model> <input.json> <out-file>
// In input.json, a string value "@file:<path>" is uploaded to Replicate first and replaced with its URL.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [model, inputPath, outPath] = process.argv.slice(2);
const token = process.env.REPLICATE_API_TOKEN;
if (!model || !inputPath || !outPath || !token) {
  console.error('usage: REPLICATE_API_TOKEN=… node scripts/replicate.mjs <owner/model> <input.json> <out-file>');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}` };

async function upload(path) {
  const form = new FormData();
  form.append('content', new Blob([await readFile(path)]), basename(path));
  const r = await fetch('https://api.replicate.com/v1/files', { method: 'POST', headers: auth, body: form });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
  return (await r.json()).urls.get;
}

const input = JSON.parse(await readFile(inputPath, 'utf8'));
for (const [k, v] of Object.entries(input)) if (typeof v === 'string' && v.startsWith('@file:')) input[k] = await upload(v.slice(6));

let p = await (
  await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  })
).json();
if (!p.id) throw new Error(JSON.stringify(p));
console.log(`${model}: ${p.id} ${p.status}`);
const started = Date.now();
while (!['succeeded', 'failed', 'canceled'].includes(p.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  p = await (await fetch(p.urls.get, { headers: auth })).json();
  process.stdout.write(`  ${Math.round((Date.now() - started) / 1000)}s ${p.status}\n`);
}
if (p.status !== 'succeeded') throw new Error(`${p.status}: ${p.error}`);
const url = Array.isArray(p.output) ? p.output[0] : p.output;
const file = await fetch(url);
await writeFile(outPath, Buffer.from(await file.arrayBuffer()));
console.log(`saved ${outPath} (${p.metrics?.predict_time?.toFixed?.(1) ?? '?'}s compute)`);
