// v0.3.9 — EAN/UPC/JAN decoding (zxing-wasm polyfill) off the main thread, for browsers without a native
// BarcodeDetector (iOS Safari, desktop). Receives an ImageBitmap of the camera frame.
const POLYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@2.2.11/pure/+esm';
let detector = null, canvas = null;
self.onmessage = async ({ data }) => {
  const { id, bitmap, maxW, formats } = data;
  try {
    if (!detector) detector = new (await import(POLYFILL)).BarcodeDetector({ formats });
    if (data.type === 'init') return self.postMessage({ id, ok: true });
    const w = Math.min(maxW, bitmap.width), h = Math.round(w * bitmap.height / bitmap.width);
    if (!canvas) canvas = new OffscreenCanvas(w, h);
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, w, h); bitmap.close?.();
    const codes = await detector.detect(g.getImageData(0, 0, w, h));
    self.postMessage({ id, codes: codes.map(c => ({ rawValue: c.rawValue, format: c.format })) });
  } catch (error) { bitmap?.close?.(); self.postMessage({ id, error: String(error?.message || error) }); }
};
