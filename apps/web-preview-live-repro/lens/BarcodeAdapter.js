export class BarcodeAdapter {
  constructor() { this.detector = null; this.initialized = false; }
  async init() {
    if (this.initialized) return Boolean(this.detector);
    this.initialized = true;
    if (!('BarcodeDetector' in window)) return false;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(x => supported.includes(x));
      this.detector = new window.BarcodeDetector({ formats: wanted.length ? wanted : supported }); return true;
    } catch { return false; }
  }
  async detect(video) {
    if (!(await this.init())) return null;
    try {
      const codes = await this.detector.detect(video); const raw = String(codes[0]?.rawValue || '').replace(/\D/g, '');
      if (raw.length < 8) return null;
      const registry = JSON.parse(localStorage.getItem('barcodeRegistry') || '{}');
      const match = registry[raw] || null;
      return { code: raw, candidateId: match?.id || null, match, verified: Boolean(match?.verified === true) };
    } catch { return null; }
  }
}
