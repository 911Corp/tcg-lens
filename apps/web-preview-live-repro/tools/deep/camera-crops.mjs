// Step 2 — simulated camera crops of references → MobileNet + fast descriptors.
// Part of the calibrated instant index pipeline (see tools/deep/train-and-export.py).
//   TRAIN=1 node camera-crops.mjs     training crops   (t-*)
//   node camera-crops.mjs             held-out crops   (q-*), incl. FOCUS sets measured separately
// Levels: mild, hard (glare, blur, exposure, colour, misalignment, noise) and hard2 (v0.3.6: slight
// perspective, holo / reverse sheen, sleeve streak, white balance, hand shadow, motion blur, low
// resolution, JPEG). Same preprocessing as the app (224 × 313 rectified crop → model).
// Env: REF_DIR, DEEP_WORK, PER_LANG ("fr:3000,en:3000,ja:1500"), FOCUS_SETS ("30th,30th-c,M6a").
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ref = process.env.REF_DIR || '/home/claude/refimg', app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.DEEP_WORK || '/tmp/tcg-lens-deep'; await fs.mkdir(work, { recursive: true });
const TRAIN = process.env.TRAIN === '1';
const PER = Object.fromEntries((process.env.PER_LANG || (TRAIN ? 'fr:3000,en:3000,ja:1500' : 'fr:300,en:300,ja:200')).split(',').map(x => x.split(':')).map(([l, n]) => [l, Number(n)]));
const FOCUS = new Set((process.env.FOCUS_SETS || '30th,30th-c,M6a').split(','));
const LEVELS = ['mild', 'hard', 'hard2'];
const fileOf = p => p.replace(/^https?:\/\//, '').replace(/\//g, '_');

// Focus-set rows are split by parity: odd rows are held out, even rows may be used for training.
const sample = [];
for (const lang of ['fr', 'en', 'ja']) {
  const meta = JSON.parse(await fs.readFile(`${app}/data/visual-index-${lang}.json`, 'utf8'));
  const col = Object.fromEntries(meta.columns.map((c, i) => [c, i]));
  const focusRows = meta.rows.map((r, i) => [r, i]).filter(([r]) => FOCUS.has(r[col.setId]));
  const heldFocus = new Set(focusRows.filter((_, k) => k % 2 === 1).map(([, i]) => i));
  const n = PER[lang] || 0;
  for (let k = 0; k < n; k++) {
    const i = Math.floor((k + (TRAIN ? 0.137 : 0.5)) * meta.rows.length / n);
    if (heldFocus.has(i) || (!TRAIN && FOCUS.has(meta.rows[i][col.setId]))) continue;
    sample.push({ lang, row: i, id: meta.rows[i][col.id], set: meta.rows[i][col.setId], file: fileOf(meta.rows[i][col.imagePath]) });
  }
  // Focus sets: training gets the even rows, held-out the odd rows.
  for (const [r, i] of focusRows) if (TRAIN ? !heldFocus.has(i) : heldFocus.has(i)) sample.push({ lang, row: i, id: r[col.id], set: r[col.setId], file: fileOf(r[col.imagePath]), focus: true });
}
console.log(TRAIN ? 'train' : 'held-out', 'references', sample.length, 'focus', sample.filter(s => s.focus).length);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.route('http://deep.local/**', async route => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p === '/') return route.fulfill({ body: '<!doctype html><title>d</title>', contentType: 'text/html' });
  if (p.startsWith('/app/')) return route.fulfill({ body: await fs.readFile(path.join(app, p.slice(5))), contentType: 'text/javascript' });
  try { return route.fulfill({ body: await fs.readFile(path.join(ref, p.slice(5))), contentType: /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/webp' }); } catch { return route.fulfill({ status: 404, body: '' }); }
});
await page.goto('http://deep.local/');
await page.evaluate(async () => {
  const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.min.js'); tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
  await tf.setBackend('wasm'); await tf.ready();
  window.model = await mobilenet.load({ version: 2, alpha: 0.5 });
  const { VisualEmbeddingAdapter } = await import('/app/lens/VisualEmbeddingAdapter.js');
  window.fastAd = new VisualEmbeddingAdapter();
});

// Chunks keep each browser round-trip small (a single call for ~24 000 crops runs out of memory).
await page.evaluate(seed => { window.__seed = seed; }, TRAIN ? 777 : 12345);
const res = { out: [], fast: [] };
for (let k = 0; k < sample.length; k += 150) {
const part = await page.evaluate(async ({ sample, LEVELS }) => {
  let s = window.__seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const W = 224, H = 313;
  const out = [], fast = [];
  const decode = async f => { const i = new Image(); i.src = '/ref/' + encodeURIComponent(f); await Promise.race([i.decode(), new Promise((_, j) => setTimeout(() => j(new Error('t')), 8000))]); return i; };
  for (const smp of sample) {
    let img; try { img = await decode(smp.file); } catch { for (const _ of LEVELS) { out.push(null); fast.push(null); } continue; }
    for (const level of LEVELS) {
      const hard = level !== 'mild', h2 = level === 'hard2';
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      x.fillStyle = `rgb(${60 + r() * 60},${60 + r() * 50},${55 + r() * 50})`; x.fillRect(0, 0, W, H);
      const j = h2 ? 0.055 : hard ? 0.045 : 0.02;
      x.save(); x.translate(W / 2 + (r() - 0.5) * 2 * j * W, H / 2 + (r() - 0.5) * 2 * j * H); x.rotate((r() - 0.5) * (hard ? 0.05 : 0.02));
      if (h2) x.transform(1, (r() - 0.5) * 0.06, (r() - 0.5) * 0.06, 1 + (r() - 0.5) * 0.06, 0, 0); // slight perspective / keystone
      const sc = 1 + (r() - 0.5) * 2 * j;
      x.filter = `blur(${(r() * (hard ? 1.6 : 0.7)).toFixed(2)}px) brightness(${(hard ? 0.65 : 0.85) + r() * (hard ? 0.6 : 0.3)}) contrast(${0.82 + r() * 0.3}) saturate(${0.75 + r() * 0.45}) hue-rotate(${((r() - 0.5) * (hard ? 16 : 6)).toFixed(1)}deg)`;
      if (h2 && r() < 0.5) { // motion blur: several shifted copies
        const dx = (r() - 0.5) * 6, dy = (r() - 0.5) * 6;
        for (let k = 0; k < 4; k++) { x.globalAlpha = k ? 0.35 : 1; x.drawImage(img, -W * sc / 2 + dx * k / 3, -H * sc / 2 + dy * k / 3, W * sc, H * sc); }
        x.globalAlpha = 1;
      } else x.drawImage(img, -W * sc / 2, -H * sc / 2, W * sc, H * sc);
      x.restore(); x.filter = 'none';
      if (h2 && r() < 0.5) { // holo / reverse-foil rainbow sheen
        const g = x.createLinearGradient(r() * W, 0, r() * W, H);
        for (let k = 0; k <= 6; k++) g.addColorStop(k / 6, `hsla(${(k * 60 + r() * 60) % 360},90%,60%,${0.12 + r() * 0.16})`);
        x.globalCompositeOperation = r() < 0.5 ? 'soft-light' : 'overlay'; x.fillStyle = g; x.fillRect(0, 0, W, H); x.globalCompositeOperation = 'source-over';
      }
      if (h2 && r() < 0.4) { // sleeve streak
        x.save(); x.translate(r() * W, r() * H); x.rotate((r() - 0.5) * 1.2); const g = x.createLinearGradient(-12, 0, 12, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${0.35 + r() * 0.35})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.fillRect(-12, -H, 24, 2 * H); x.restore();
      }
      if (r() < (hard ? 0.7 : 0.3)) { const g = x.createRadialGradient(r() * W, r() * H, 5, r() * W, r() * H, W * (0.3 + r() * 0.5)); g.addColorStop(0, `rgba(255,255,250,${(hard ? 0.55 : 0.3) * r()})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
      if (h2 && r() < 0.45) { // hand / phone shadow
        const g = x.createLinearGradient(r() * W, r() * H, r() * W, r() * H); g.addColorStop(0, `rgba(0,0,0,${0.25 + r() * 0.3})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
      }
      if (h2) { // white balance tint
        x.globalCompositeOperation = 'multiply'; const warm = r() < 0.5;
        x.fillStyle = warm ? `rgb(255,${225 + r() * 30 | 0},${190 + r() * 50 | 0})` : `rgb(${200 + r() * 40 | 0},${225 + r() * 30 | 0},255)`; x.fillRect(0, 0, W, H);
        x.globalCompositeOperation = 'source-over';
      }
      const id = x.getImageData(0, 0, W, H); for (let p = 0; p < id.data.length; p += 4) { const n = (r() - 0.5) * (hard ? 28 : 12); id.data[p] += n; id.data[p + 1] += n; id.data[p + 2] += n; } x.putImageData(id, 0, 0);
      let final = c;
      if (h2) { // low resolution + JPEG round trip
        const lw = 90 + (r() * 90 | 0), small = document.createElement('canvas'); small.width = lw; small.height = Math.round(lw * H / W);
        small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
        const jpg = new Image(); jpg.src = small.toDataURL('image/jpeg', 0.45 + r() * 0.35); await jpg.decode();
        final = document.createElement('canvas'); final.width = W; final.height = H; final.getContext('2d').drawImage(jpg, 0, 0, W, H);
      }
      const t = tf.tidy(() => model.infer(final, true)); out.push(Array.from(await t.data())); t.dispose();
      fast.push(Array.from(fastAd.fastDescriptor(final)));
    }
  }
  window.__seed = s;
  return { out, fast };
}, { sample: sample.slice(k, k + 150), LEVELS });
res.out.push(...part.out); res.fast.push(...part.fast);
if (k % 1500 === 0) console.log('crops', k, '/', sample.length);
}

const pre = TRAIN ? 't-' : 'q-';
const n = sample.length * LEVELS.length;
const buf = new Float32Array(n * 1280), fb = new Float32Array(n * 236);
res.out.forEach((d, k) => d && buf.set(d, k * 1280)); res.fast.forEach((d, k) => d && fb.set(d, k * 236));
await fs.writeFile(`${work}/${pre}emb.bin`, Buffer.from(buf.buffer)); await fs.writeFile(`${work}/${pre}fast.bin`, Buffer.from(fb.buffer));
await fs.writeFile(`${work}/${pre}meta.json`, JSON.stringify(sample.flatMap(x => LEVELS.map(level => ({ ...x, level })))));
console.log('crops', n);
await browser.close();
