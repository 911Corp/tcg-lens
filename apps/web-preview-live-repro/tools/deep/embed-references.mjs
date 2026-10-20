// Step 1 — 1280-d MobileNet v2 α0.5 embeddings of every reference (visual-index row order).
//   node embed-references.mjs <lang> [part] [parts]   (refs read from $REF_DIR, default /home/claude/refimg)
// Part of the calibrated instant index pipeline (see tools/deep/train-and-export.py).
// Usage: node {this file} … — work files go to $DEEP_WORK (default /tmp/tcg-lens-deep).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
import fs from 'node:fs/promises'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ref = process.env.REF_DIR || '/home/claude/refimg', app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.DEEP_WORK || '/tmp/tcg-lens-deep'; await fs.mkdir(work, { recursive: true });
const [lang, part = '0', parts = '1'] = process.argv.slice(2);
const meta = JSON.parse(await fs.readFile(`${app}/data/visual-index-${lang}.json`, 'utf8'));
const col = meta.columns.indexOf('imagePath');
const all = meta.rows.map((r, i) => ({ i, file: r[col].replace(/\//g, '_') }));
const mine = all.filter(x => x.i % Number(parts) === Number(part));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.route('http://deep.local/**', async route => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p === '/') return route.fulfill({ body: '<!doctype html><title>d</title>', contentType: 'text/html' });
  try { return route.fulfill({ body: await fs.readFile(path.join(ref, p.slice(5))), contentType: 'image/webp' }); } catch { return route.fulfill({ status: 404, body: '' }); }
});
await page.goto('http://deep.local/');
await page.evaluate(async () => {
  const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.min.js'); tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
  await tf.setBackend('wasm'); await tf.ready();
  window.model = await mobilenet.load({ version: 2, alpha: 0.5 });
  window.embed = async files => {
    const canv = await Promise.all(files.map(async f => { try { const i = new Image(); i.src = '/ref/' + encodeURIComponent(f); await Promise.race([i.decode(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]); const c = document.createElement('canvas'); c.width = 224; c.height = 312; c.getContext('2d').drawImage(i, 0, 0, 224, 312); return c; } catch { return null; } }));
    const ok = canv.map(c => c || (() => { const c = document.createElement('canvas'); c.width = 224; c.height = 312; return c; })());
    const out = tf.tidy(() => model.infer(tf.stack(ok.map(c => tf.image.resizeBilinear(tf.cast(tf.browser.fromPixels(c), 'float32'), [224, 224], true))), true));
    const d = await out.data(); out.dispose();
    return { data: Array.from(d), missing: canv.map(c => !c) };
  };
});
const out = new Float32Array(all.length * 1280); // full-size; only my rows are filled
const fh = await fs.open(`${work}/emb-${lang}-${part}.bin`, 'w');
let missing = 0; const t0 = Date.now();
for (let k = 0; k < mine.length; k += 32) {
  const batch = mine.slice(k, k + 32);
  const r = await page.evaluate(f => window.embed(f), batch.map(b => b.file));
  batch.forEach((b, j) => { if (r.missing[j]) missing++; out.set(r.data.slice(j * 1280, (j + 1) * 1280), b.i * 1280); });
  if (k % 1024 === 0) console.log(lang, part, k, '/', mine.length, Math.round((Date.now() - t0) / 1000) + 's');
}
await fh.write(Buffer.from(out.buffer)); await fh.close();
console.log('done', lang, part, mine.length, 'missing', missing, Math.round((Date.now() - t0) / 1000) + 's');
await browser.close();
