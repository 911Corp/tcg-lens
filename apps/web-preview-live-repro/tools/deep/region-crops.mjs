// v0.4.2 — region descriptors (MobileNet v2 α0.5, 1280-d) of card zones, for edition and script discrimination.
//   node region-crops.mjs <jobs.json> <outPrefix> [part] [parts]
// jobs: [{ file, role: 'ref' | 't' | 'q', levels: [...] }] — 'ref' = clean reference, otherwise simulated camera
// crops (same augmentation family as camera-crops.mjs, rendered at 2× resolution: 448 × 626).
// Output: <outPrefix>-<region>.bin (float32, rows × 1280) and <outPrefix>-meta.json (one row per output).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
export const REGIONS = { text: [0.06, 0.53, 0.94, 0.86], bottom: [0.0, 0.865, 1.0, 1.0], top: [0.0, 0.0, 1.0, 0.13] };
const ref = process.env.REF_DIR || '/home/claude/refimg';
const [jobsFile, outPrefix, part = '0', parts = '1'] = process.argv.slice(2);
const all = JSON.parse(await fs.readFile(jobsFile, 'utf8'));
const jobs = all.filter((_, i) => i % Number(parts) === Number(part));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('crash', () => { console.error('renderer crashed'); process.exit(2); });
await page.route('http://deep.local/**', async route => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname);
  if (p === '/') return route.fulfill({ body: '<!doctype html><title>d</title>', contentType: 'text/html' });
  try { return route.fulfill({ body: await fs.readFile(path.join(ref, p.slice(5))), contentType: /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/webp' }); } catch { return route.fulfill({ status: 404, body: '' }); }
});
await page.goto('http://deep.local/');
await page.evaluate(async regions => {
  const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.min.js'); tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
  await load('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
  await tf.setBackend('wasm'); await tf.ready();
  window.model = await mobilenet.load({ version: 2, alpha: 0.5 });
  window.REGIONS = regions;
  let s = 4242; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const S = 2, W = 224 * S, H = 313 * S;
  const decode = async f => { const i = new Image(); i.src = '/ref/' + encodeURIComponent(f); await Promise.race([i.decode(), new Promise((_, j) => setTimeout(() => j(new Error('t')), 8000))]); return i; };
  async function crop(img, level) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    if (!level) { x.drawImage(img, 0, 0, W, H); return c; }
    const hard = level !== 'mild', h2 = level === 'hard2';
    x.fillStyle = `rgb(${60 + r() * 60},${60 + r() * 50},${55 + r() * 50})`; x.fillRect(0, 0, W, H);
    const j = h2 ? 0.055 : hard ? 0.045 : 0.02;
    x.save(); x.translate(W / 2 + (r() - 0.5) * 2 * j * W, H / 2 + (r() - 0.5) * 2 * j * H); x.rotate((r() - 0.5) * (hard ? 0.05 : 0.02));
    if (h2) x.transform(1, (r() - 0.5) * 0.06, (r() - 0.5) * 0.06, 1 + (r() - 0.5) * 0.06, 0, 0);
    const sc = 1 + (r() - 0.5) * 2 * j;
    x.filter = `blur(${(r() * (hard ? 1.6 : 0.7) * S).toFixed(2)}px) brightness(${(hard ? 0.65 : 0.85) + r() * (hard ? 0.6 : 0.3)}) contrast(${0.82 + r() * 0.3}) saturate(${0.75 + r() * 0.45}) hue-rotate(${((r() - 0.5) * (hard ? 16 : 6)).toFixed(1)}deg)`;
    if (h2 && r() < 0.5) { const dx = (r() - 0.5) * 6 * S, dy = (r() - 0.5) * 6 * S; for (let k = 0; k < 4; k++) { x.globalAlpha = k ? 0.35 : 1; x.drawImage(img, -W * sc / 2 + dx * k / 3, -H * sc / 2 + dy * k / 3, W * sc, H * sc); } x.globalAlpha = 1; }
    else x.drawImage(img, -W * sc / 2, -H * sc / 2, W * sc, H * sc);
    x.restore(); x.filter = 'none';
    if (h2 && r() < 0.5) { const g = x.createLinearGradient(r() * W, 0, r() * W, H); for (let k = 0; k <= 6; k++) g.addColorStop(k / 6, `hsla(${(k * 60 + r() * 60) % 360},90%,60%,${0.12 + r() * 0.16})`); x.globalCompositeOperation = r() < 0.5 ? 'soft-light' : 'overlay'; x.fillStyle = g; x.fillRect(0, 0, W, H); x.globalCompositeOperation = 'source-over'; }
    if (h2 && r() < 0.4) { x.save(); x.translate(r() * W, r() * H); x.rotate((r() - 0.5) * 1.2); const g = x.createLinearGradient(-12 * S, 0, 12 * S, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${0.35 + r() * 0.35})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(-12 * S, -H, 24 * S, 2 * H); x.restore(); }
    if (r() < (hard ? 0.7 : 0.3)) { const g = x.createRadialGradient(r() * W, r() * H, 5, r() * W, r() * H, W * (0.3 + r() * 0.5)); g.addColorStop(0, `rgba(255,255,250,${(hard ? 0.55 : 0.3) * r()})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
    if (h2 && r() < 0.45) { const g = x.createLinearGradient(r() * W, r() * H, r() * W, r() * H); g.addColorStop(0, `rgba(0,0,0,${0.25 + r() * 0.3})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
    if (h2) { x.globalCompositeOperation = 'multiply'; const warm = r() < 0.5; x.fillStyle = warm ? `rgb(255,${225 + r() * 30 | 0},${190 + r() * 50 | 0})` : `rgb(${200 + r() * 40 | 0},${225 + r() * 30 | 0},255)`; x.fillRect(0, 0, W, H); x.globalCompositeOperation = 'source-over'; }
    const id = x.getImageData(0, 0, W, H); for (let p = 0; p < id.data.length; p += 4) { const n = (r() - 0.5) * (hard ? 28 : 12); id.data[p] += n; id.data[p + 1] += n; id.data[p + 2] += n; } x.putImageData(id, 0, 0);
    if (h2) { const lw = (180 + (r() * 180 | 0)), small = document.createElement('canvas'); small.width = lw; small.height = Math.round(lw * H / W); small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
      const jpg = new Image(); jpg.src = small.toDataURL('image/jpeg', 0.45 + r() * 0.35); await jpg.decode(); const f = document.createElement('canvas'); f.width = W; f.height = H; f.getContext('2d').drawImage(jpg, 0, 0, W, H); return f; }
    return c;
  }
  const region = (c, [x0, y0, x1, y1]) => { const o = document.createElement('canvas'); o.width = 224; o.height = 224; o.getContext('2d').drawImage(c, x0 * c.width, y0 * c.height, (x1 - x0) * c.width, (y1 - y0) * c.height, 0, 0, 224, 224); return o; };
  window.work = async batch => {
    const out = { meta: [], emb: Object.fromEntries(Object.keys(regions).map(k => [k, []])) };
    for (const job of batch) {
      let img; try { img = await decode(job.file); } catch { continue; }
      for (const level of job.role === 'ref' ? [null] : job.levels) {
        const c = await crop(img, level);
        const canv = Object.values(regions).map(b => region(c, b));
        const t = tf.tidy(() => model.infer(tf.stack(canv.map(x => tf.browser.fromPixels(x))), true));
        const d = await t.data(); t.dispose();
        Object.keys(regions).forEach((k, i) => out.emb[k].push(Array.from(d.slice(i * 1280, (i + 1) * 1280))));
        out.meta.push({ ...job, level });
      }
    }
    return out;
  };
}, REGIONS);
// Streamed to disk batch by batch (holding ~50k × 3 × 1280 floats in JS arrays exhausts memory).
const handles = Object.fromEntries(await Promise.all(Object.keys(REGIONS).map(async r => [r, await fs.open(`${outPrefix}-${part}-${r}.bin`, 'w')])));
const metaOut = [];
const t0 = Date.now();
for (let k = 0; k < jobs.length; k += 40) {
  const p = await page.evaluate(b => window.work(b), jobs.slice(k, k + 40));
  metaOut.push(...p.meta);
  for (const r of Object.keys(REGIONS)) { const b = new Float32Array(p.emb[r].length * 1280); p.emb[r].forEach((v, i) => b.set(v, i * 1280)); await handles[r].write(Buffer.from(b.buffer)); }
  if (k % 800 === 0) console.log(part, k, '/', jobs.length, Math.round((Date.now() - t0) / 1000) + 's');
}
for (const h of Object.values(handles)) await h.close();
await fs.writeFile(`${outPrefix}-${part}-meta.json`, JSON.stringify(metaOut));
const res = { meta: metaOut };
console.log('done', part, res.meta.length, Math.round((Date.now() - t0) / 1000) + 's');
await browser.close();
