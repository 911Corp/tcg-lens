// Download the reference image of every candidate-pool item missing from the local reference
// directory (TCGdex low.webp or TCGplayer 1000 px jpg). File name = URL without scheme, "/" → "_".
//   node tools/fetch-ref-images.mjs [refDir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDir = path.resolve(process.argv[2] || '/home/claude/refimg');
export const refFileFor = url => url.replace(/^https?:\/\/(assets\.tcgdex\.net\/)?/, '').replace(/\//g, '_');
const have = new Set(await fs.readdir(refDir));
const todo = [];
for (const lang of ['fr', 'en', 'ja']) {
  const pool = JSON.parse(await fs.readFile(path.join(appDir, 'data', `candidate-pool-${lang}.json`), 'utf8'));
  for (const it of pool.items) if (it.image && !have.has(refFileFor(it.image))) todo.push(it.image);
}
const uniq = [...new Set(todo)];
console.log('missing', uniq.length);
let ok = 0, failed = 0;
for (let i = 0; i < uniq.length; i += 12) {
  await Promise.all(uniq.slice(i, i + 12).map(async url => {
    try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); await fs.writeFile(path.join(refDir, refFileFor(url)), Buffer.from(await r.arrayBuffer())); ok++; } catch { failed++; }
  }));
}
console.log('downloaded', ok, 'failed', failed);
