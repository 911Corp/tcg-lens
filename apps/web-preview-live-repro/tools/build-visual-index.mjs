// Build the precomputed on-device visual index from the canonical candidate pool.
//
//   node apps/web-preview-live-repro/tools/build-visual-index.mjs <refImageDir> [--chromium=/path/to/chrome]
//
// For every pool item (all languages) the reference image is rendered exactly as the app does
// (VisualEmbeddingAdapter.imageCanvas -> fastDescriptor) inside Chromium, so descriptors match the
// client code. Output per language, next to the pool:
//   data/visual-index-{lang}.bin   Int8 descriptors, row-major, value = round(x * 127) (+ .bin.gz)
//   data/visual-index-{lang}.json  compact metadata rows aligned with the binary rows
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDir = path.resolve(process.argv[2] || '/home/claude/refimg');
const chromium = (process.argv.find(a => a.startsWith('--chromium=')) || '').slice(11) || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const { chromium: pw } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

export const INDEX_SCHEMA = 'tcg-lens-visual-index-v1';
const fileFor = u => path.join(refDir, u.replace(/^https?:\/\/(assets\.tcgdex\.net\/)?/, '').replace(/\//g, '_'));

const browser = await pw.launch({ executablePath: chromium });
const page = await browser.newPage();
await page.route('http://idx.local/**', async route => {
  const url = new URL(route.request().url());
  try {
    if (url.pathname.startsWith('/ref/')) { const f = decodeURIComponent(url.pathname.slice(5)); return route.fulfill({ body: await fs.readFile(path.join(refDir, f)), contentType: /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/webp' }); }
    if (url.pathname === '/') return route.fulfill({ body: '<!doctype html><title>idx</title>', contentType: 'text/html' });
    return route.fulfill({ body: await fs.readFile(path.join(appDir, url.pathname)), contentType: 'text/javascript' });
  } catch { return route.fulfill({ status: 404, body: '' }); }
});
await page.goto('http://idx.local/');
await page.evaluate(async () => {
  const { VisualEmbeddingAdapter } = await import('/lens/VisualEmbeddingAdapter.js');
  const adapter = new VisualEmbeddingAdapter();
  window.describeBatch = async names => Promise.all(names.map(async name => {
    try {
      const canvas = await adapter.imageCanvas(`/ref/${encodeURIComponent(name)}`);
      return Array.from(adapter.fastDescriptor(canvas));
    } catch { return null; }
  }));
});

for (const lang of ['fr', 'en', 'ja']) {
  const pool = JSON.parse(await fs.readFile(path.join(appDir, 'data', `candidate-pool-${lang}.json`), 'utf8'));
  const rows = [], vectors = [];
  let dims = 0, missing = 0;
  for (let i = 0; i < pool.items.length; i += 64) {
    const batch = pool.items.slice(i, i + 64);
    const names = batch.map(it => path.basename(fileFor(it.image)));
    const descs = await page.evaluate(n => window.describeBatch(n), names);
    batch.forEach((it, k) => {
      const d = descs[k];
      if (!d) { missing++; return; }
      dims = d.length;
      vectors.push(d);
      rows.push([it.id, it.name, it.localId, it.printedTotal ?? null, it.setId, it.setName, it.setAbbreviation ?? null, it.releaseDate ?? null,
        it.image.replace('https://assets.tcgdex.net/', ''), (it.visualOnlyLockAllowed ? 1 : 0), it.lockBlockedReason || null, it.entityId, it.printedNumber || null]);
    });
  }
  const bin = new Int8Array(vectors.length * dims);
  vectors.forEach((v, r) => v.forEach((x, c) => { bin[r * dims + c] = Math.max(-127, Math.min(127, Math.round(x * 127))); }));
  await fs.writeFile(path.join(appDir, 'data', `visual-index-${lang}.bin`), Buffer.from(bin.buffer));
  await fs.writeFile(path.join(appDir, 'data', `visual-index-${lang}.bin.gz`), zlib.gzipSync(Buffer.from(bin.buffer), { level: 9 }));
  await fs.writeFile(path.join(appDir, 'data', `visual-index-${lang}.json`), JSON.stringify({
    schema: INDEX_SCHEMA, lang, dims, count: rows.length, poolBuildId: pool.buildId, asOf: pool.asOf, imageBase: 'https://assets.tcgdex.net/',
    columns: ['id', 'name', 'localId', 'printedTotal', 'setId', 'setName', 'setAbbreviation', 'releaseDate', 'imagePath', 'visualOnlyLockAllowed', 'lockBlockedReason', 'entityId', 'printedNumber'],
    rows,
  }));
  console.log(`${lang}: ${rows.length} refs, ${dims} dims, ${missing} missing images`);
}
await browser.close();
