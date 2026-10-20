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
