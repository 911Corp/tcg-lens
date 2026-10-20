/**
 * Barcode reading (EAN-13 / EAN-8 / UPC-A / UPC-E / JAN) from the live camera, independent from
 * card detection, OCR and the embedding model.
 *
 * Native BarcodeDetector when the browser has it (Android Chrome), otherwise the zxing-wasm based
 * polyfill loaded on demand (iOS Safari, desktop). Only checksum-valid codes are returned.
 */
const POLYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@2.2.11/pure/+esm';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

export function toGtin14(code) {
  const d = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const g = d.padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(g[13]) ? g : null;
}

export class BarcodeAdapter {
  constructor() { this.detector = null; this.initPromise = null; this.kind = null; this.canvas = null; }

  init() {
    if (!this.initPromise) this.initPromise = (async () => {
      try {
        if ('BarcodeDetector' in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const wanted = FORMATS.filter(x => supported.includes(x));
          if (wanted.length) { this.detector = new window.BarcodeDetector({ formats: wanted }); this.kind = 'natif'; return true; }
        }
      } catch {}
      // v0.3.9: zxing-wasm decoding in a worker (no main-thread stalls), in-page polyfill otherwise.
      if (typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function') {
        try {
          const worker = new Worker(new URL('./barcode.worker.js', import.meta.url), { type: 'module' });
          let seq = 0; const pending = new Map();
          worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (p) { pending.delete(data.id); clearTimeout(p.t); data.error ? p.reject(new Error(data.error)) : p.resolve(data); } };
          const call = (msg, transfer = []) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 8000); pending.set(id, { resolve, reject, t }); worker.postMessage({ id, formats: FORMATS, maxW: 960, ...msg }, transfer); });
          await call({ type: 'init' });
          this.detector = { detect: async video => { const bitmap = await createImageBitmap(video); return (await call({ type: 'detect', bitmap }, [bitmap])).codes; }, direct: true };
          this.kind = 'wasm (worker)';
          return true;
        } catch {}
      }
      try {
        const mod = await import(/* @vite-ignore */ POLYFILL);
        this.detector = new mod.BarcodeDetector({ formats: FORMATS });
        this.kind = 'wasm';
        return true;
      } catch { this.kind = 'indisponible'; return false; }
    })();
    return this.initPromise;
  }

  /** @returns {Promise<{ code: string, gtin14: string, format: string } | null>} */
  async detect(video) {
    if (!(await this.init())) return null;
    try {
      if (this.detector.direct) {
        for (const c of await this.detector.detect(video)) { const gtin14 = toGtin14(c.rawValue); if (gtin14) return { code: String(c.rawValue).replace(/\D/g, ''), gtin14, format: c.format }; }
        return null;
      }
      // A reduced copy is enough for barcodes and keeps the WASM decoder fast.
      const w = Math.min(960, video.videoWidth || 960), h = Math.round(w * (video.videoHeight || 720) / (video.videoWidth || 960));
      if (!this.canvas) this.canvas = document.createElement('canvas');
      this.canvas.width = w; this.canvas.height = h;
      this.canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, w, h);
      const codes = await this.detector.detect(this.canvas);
      for (const c of codes) {
        const gtin14 = toGtin14(c.rawValue);
        if (gtin14) return { code: String(c.rawValue).replace(/\D/g, ''), gtin14, format: c.format };
      }
      return null;
    } catch { return null; }
  }
}
