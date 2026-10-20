function normalize(values) {
  let n = 0; for (const x of values) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(values, x => x / n);
}

export function cosine(a, b) {
  if (!a || !b) return -1;
  let dot = 0, aa = 0, bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / (Math.sqrt(aa * bb) || 1);
}

export class VisualEmbeddingAdapter {
  constructor() {
    this.model = null;
    this.modelPromise = null;
  }

  async ensureModel() {
    if (this.model) return true;
    if (this.modelPromise) return this.modelPromise;
    this.modelPromise = (async () => {
      try {
        await this._loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'tf');
        await this._loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js', 'mobilenet');
        if (!window.tf || !window.mobilenet) return false;
        try { await window.tf.setBackend('webgl'); } catch {}
        await window.tf.ready();
        this.model = await window.mobilenet.load({ version: 2, alpha: 0.5 });
        return true;
      } catch (error) {
        console.warn('TCG Lens embedding model unavailable', error);
        return false;
      }
    })();
    return this.modelPromise;
  }

  fastDescriptor(canvas) {
    const w = 64, h = 88, tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h), edge = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      edge[p] = Math.min(1, Math.hypot(gray[p + 1] - gray[p - 1], gray[p + w] - gray[p - w]) * 2.2);
    }
    const out = [];
    for (let by = 0; by < 11; by++) for (let bx = 0; bx < 8; bx++) {
      let lum = 0, ed = 0, n = 0;
      for (let y = by * 8; y < Math.min(h, by * 8 + 8); y++) for (let x = bx * 8; x < bx * 8 + 8; x++) {
        const p = y * w + x; lum += gray[p]; ed += edge[p]; n++;
      }
      out.push(lum / n - 0.5, ed / n - 0.18);
    }
    for (let by = 0; by < 5; by++) for (let bx = 0; bx < 4; bx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = by * 17; y < Math.min(h, by * 17 + 17); y += 2) for (let x = bx * 16; x < Math.min(w, bx * 16 + 16); x += 2) {
        const p = (y * w + x) * 4; r += data[p] / 255; g += data[p + 1] / 255; b += data[p + 2] / 255; n++;
      }
      out.push(r / n - 0.5, g / n - 0.5, b / n - 0.5);
    }
    return normalize(out);
  }

  async embed(canvas) {
    if (!(await this.ensureModel())) return null;
    let tensor = null;
    try {
      tensor = this.model.infer(canvas, true);
      const data = await tensor.data();
      return normalize(data);
    } finally { tensor?.dispose?.(); }
  }

  /**
   * Batch embedding of several reference canvases in one model call (much faster than N calls on
   * both WebGL and CPU backends). Same values as embed(): bilinear resize commutes with the model's
   * affine normalisation, and alignCorners matches mobilenet's own resize.
   */
  async embedBatch(canvases) {
    if (!canvases.length) return [];
    if (!(await this.ensureModel())) return canvases.map(() => null);
    const tf = window.tf;
    let out = null;
    try {
      out = tf.tidy(() => this.model.infer(tf.stack(canvases.map(c => tf.image.resizeBilinear(tf.cast(tf.browser.fromPixels(c), 'float32'), [224, 224], true))), true));
      const data = await out.data();
      const dims = data.length / canvases.length;
      return canvases.map((_, i) => normalize(data.subarray(i * dims, (i + 1) * dims)));
    } finally { out?.dispose?.(); }
  }

  async imageCanvas(url, width = 224, height = 312) {
    // TCGdex serves images with CORS from its CDN: load directly (fast, cached), and fall back to
    // the same-origin proxy only if the direct load fails.
    const load = src => new Promise((resolve, reject) => {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.onload = () => resolve(img); img.onerror = reject; img.src = src;
    });
    let img;
    try { img = await load(url); }
    catch (error) { if (!url.includes('assets.tcgdex.net')) throw error; img = await load(`/api/visual-image?url=${encodeURIComponent(url)}`); }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas;
  }

  _loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find(s => s.src === src);
      if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
      const script = document.createElement('script'); script.src = src; script.async = true;
      script.onload = resolve; script.onerror = reject; document.head.appendChild(script);
    });
  }
}
