// Step 2 — simulated camera crops (glare, blur, exposure, colour, misalignment, noise) → embeddings.
//   TRAIN=1 node camera-crops.mjs   (training crops)   |   node camera-crops.mjs   (held-out calibration crops)
// Part of the calibrated instant index pipeline (see tools/deep/train-and-export.py).
// Usage: node {this file} … — work files go to $DEEP_WORK (default /tmp/tcg-lens-deep).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
import fs from 'node:fs/promises'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ref = process.env.REF_DIR || '/home/claude/refimg', app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.DEEP_WORK || '/tmp/tcg-lens-deep'; await fs.mkdir(work, { recursive: true });
const TRAIN = process.env.TRAIN === '1';
const N = TRAIN ? { fr: 1600, en: 1600, ja: 800 } : { fr: 300, en: 300, ja: 200 };
const sample = [];
for (const lang of ['fr', 'en', 'ja']) {
  const meta = JSON.parse(await fs.readFile(`${app}/data/visual-index-${lang}.json`, 'utf8'));
  const ci = meta.columns.indexOf('imagePath'), ii = meta.columns.indexOf('id');
  for (let k = 0; k < N[lang]; k++) { const i = Math.floor((k + (TRAIN ? 0.137 : 0.5)) * meta.rows.length / N[lang]); sample.push({ lang, row: i, id: meta.rows[i][ii], file: meta.rows[i][ci].replace(/\//g, '_') }); }
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.route('http://deep.local/**', async route => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p === '/') return route.fulfill({ body: '<!doctype html><title>d</title>', contentType: 'text/html' });
  if (p.startsWith('/app/')) return route.fulfill({ body: await fs.readFile(path.join(app, p.slice(5))), contentType: 'text/javascript' });
  try { return route.fulfill({ body: await fs.readFile(path.join(ref, p.slice(5))), contentType: 'image/webp' }); } catch { return route.fulfill({ status: 404, body: '' }); }
});
await page.goto('http://deep.local/');
const res = await page.evaluate(async sample => {
  const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.min.js'); tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
  await tf.setBackend('wasm'); await tf.ready();
  const model = await mobilenet.load({ version: 2, alpha: 0.5 });
  const { VisualEmbeddingAdapter } = await import('/app/lens/VisualEmbeddingAdapter.js');
  const fastAd = new VisualEmbeddingAdapter();
  let s = sample.length > 1000 ? 777 : 12345; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const W = 224, H = 313; // app rectifiedWidth 224 × 63:88
  const out = []; const fast = [];
  for (let k = 0; k < sample.length; k++) {
    const img = new Image(); img.src = '/ref/' + encodeURIComponent(sample[k].file);
    try { await img.decode(); } catch { out.push(null); fast.push(null); continue; }
    for (const level of ['mild', 'hard']) {
      const hard = level === 'hard';
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      x.fillStyle = `rgb(${60 + r() * 60},${60 + r() * 50},${55 + r() * 50})`; x.fillRect(0, 0, W, H);
      const j = hard ? 0.045 : 0.02;
      x.save(); x.translate(W / 2 + (r() - 0.5) * 2 * j * W, H / 2 + (r() - 0.5) * 2 * j * H); x.rotate((r() - 0.5) * (hard ? 0.05 : 0.02)); const sc = 1 + (r() - 0.5) * 2 * j;
      x.filter = `blur(${(r() * (hard ? 1.6 : 0.7)).toFixed(2)}px) brightness(${(hard ? 0.65 : 0.85) + r() * (hard ? 0.6 : 0.3)}) contrast(${0.82 + r() * 0.3}) saturate(${0.75 + r() * 0.45}) hue-rotate(${((r() - 0.5) * (hard ? 16 : 6)).toFixed(1)}deg)`;
      x.drawImage(img, -W * sc / 2, -H * sc / 2, W * sc, H * sc); x.restore(); x.filter = 'none';
      if (r() < (hard ? 0.7 : 0.3)) { const g = x.createRadialGradient(r() * W, r() * H, 5, r() * W, r() * H, W * (0.3 + r() * 0.5)); g.addColorStop(0, `rgba(255,255,250,${(hard ? 0.55 : 0.3) * r()})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
      const id = x.getImageData(0, 0, W, H); for (let p = 0; p < id.data.length; p += 4) { const n = (r() - 0.5) * (hard ? 28 : 12); id.data[p] += n; id.data[p + 1] += n; id.data[p + 2] += n; } x.putImageData(id, 0, 0);
      const t = tf.tidy(() => model.infer(c, true)); const d = Array.from(await t.data()); t.dispose();
      out.push(d); fast.push(Array.from(fastAd.fastDescriptor(c)));
    }
  }
  return { out, fast };
}, sample);
const pre = TRAIN ? 't-' : 'q-';
const dims = 1280, n = sample.length * 2;
const buf = new Float32Array(n * dims); const fb = new Float32Array(n * 236);
res.out.forEach((d, k) => d && buf.set(d, k * dims)); res.fast.forEach((d, k) => d && fb.set(d, k * 236));
await fs.writeFile(`${work}/${pre}emb.bin`, Buffer.from(buf.buffer)); await fs.writeFile(`${work}/${pre}fast.bin`, Buffer.from(fb.buffer));
await fs.writeFile(`${work}/${pre}meta.json`, JSON.stringify(sample.flatMap(x => [{ ...x, level: 'mild' }, { ...x, level: 'hard' }])));
console.log('queries', n);
await browser.close();
