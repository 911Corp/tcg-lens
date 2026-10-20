/**
 * v0.3.9 — frame worker client. The camera frame is captured with createImageBitmap (asynchronous, no
 * pixel read-back on the page) and transferred to a worker that runs the edge search and the card
 * rectification. The page keeps the camera preview, the HUD and the overlays fluid. Any failure turns the
 * worker off and the runtime falls back to the in-page path (same pure functions, same results).
 */
export class FrameWorker {
  static supported() {
    return typeof Worker === 'function' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' && typeof document !== 'undefined';
  }

  constructor() {
    this.ready = false; this.broken = false; this.seq = 0; this.pending = new Map();
    try {
      this.worker = new Worker(new URL('./frame.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => { const p = this.pending.get(data.id); if (!p) return; this.pending.delete(data.id); clearTimeout(p.timer); data.error ? p.reject(new Error(data.error)) : p.resolve(data); };
      this.worker.onerror = () => this.disable('worker_error');
      this.call('hello', {}).then(r => { this.ready = Boolean(r.ok) && !this.broken; }).catch(() => this.disable('hello_failed'));
    } catch { this.disable('construct_failed'); }
  }

  disable(reason) {
    if (this.broken) return;
    this.broken = true; this.ready = false; this.reason = reason;
    try { this.worker?.terminate(); } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  call(type, payload, transfer = [], timeoutMs = 2000) {
    if (this.broken) return Promise.reject(new Error('frame worker disabled'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) { reject(new Error('timeout')); this.disable('timeout'); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }

  /** Captures the current frame and runs the edge search on it. → { found, scale } (found in detector px). */
  async detect(video, { detW, angleSets, minCoverage }) {
    const bitmap = await createImageBitmap(video);
    return this.call('frame', { bitmap, detW, angleSets, minCoverage }, [bitmap]);
  }

  /** Multi-card mode: every card rectangle of the current frame (video pixels). */
  async detectMulti(video, { detW = 320, max = 6, minCoverage = 0.5 } = {}) {
    const bitmap = await createImageBitmap(video);
    const angles = [-12, -9, -6, -4, -2, 0, 2, 4, 6, 9, 12].map(a => a * Math.PI / 180);
    return (await this.call('frameMulti', { bitmap, detW, max, minCoverage, angles }, [bitmap], 4000)).dets || [];
  }

  /** Rectified RGBA (ArrayBuffer, width × height) of the quad in the last detected frame, or null. */
  async rectify(quad, width, height) {
    const r = await this.call('rectify', { quad, width, height });
    return r.buffer || null;
  }
}
