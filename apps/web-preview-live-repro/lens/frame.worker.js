// v0.3.9 — per-frame image work off the main thread: card edge search on a small copy of the camera
// frame, then rectification of the tracked card from the same frame. Pure functions shared with the page.
import { detectRect, detectRects } from './EdgeRectDetector.js';
import { warpInto, cropPlan, destinationHomography } from './PerspectiveRectifier.js';

let frame = null; // ImageBitmap of the last analysed camera frame
const canvasFor = (() => { const pool = new Map(); return (key, w, h) => { let c = pool.get(key); if (!c) { c = new OffscreenCanvas(w, h); pool.set(key, c); } if (c.width !== w) c.width = w; if (c.height !== h) c.height = h; return c; }; })();
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'hello') return self.postMessage({ id, ok: typeof OffscreenCanvas === 'function' && Boolean(new OffscreenCanvas(2, 2).getContext('2d')) });
    if (type === 'frame') {
      frame?.close?.(); frame = data.bitmap;
      const w = data.detW, h = Math.round(frame.height / frame.width * w);
      const c = canvasFor('det', w, h), g = ctx2d(c); g.drawImage(frame, 0, 0, w, h);
      const rgba = g.getImageData(0, 0, w, h).data;
      let found = null;
      for (const angles of data.angleSets) { found = detectRect(rgba, w, h, angles, data.minCoverage); if (found) break; }
      return self.postMessage({ id, found: found ? { quad: found.quad, score: found.score, coverage: found.coverage, th: found.th } : null, scale: frame.width / w, vw: frame.width, vh: frame.height });
    }
    if (type === 'frameMulti') {
      frame?.close?.(); frame = data.bitmap;
      const w = data.detW, h = Math.round(frame.height / frame.width * w);
      const c = canvasFor('det', w, h), g = ctx2d(c); g.drawImage(frame, 0, 0, w, h);
      const found = detectRects(g.getImageData(0, 0, w, h).data, w, h, data.angles, data.minCoverage, { max: data.max });
      const k = frame.width / w;
      return self.postMessage({ id, dets: found.map(f => ({ quad: f.quad.map(p => ({ x: p.x * k, y: p.y * k })), score: f.score })) });
    }
    if (type === 'rectify') {
      if (!frame) return self.postMessage({ id, buffer: null });
      const plan = cropPlan(data.quad, frame.width, frame.height, data.width);
      const c = canvasFor(`src${data.width}`, plan.cw, plan.ch), g = ctx2d(c);
      g.drawImage(frame, plan.bx, plan.by, plan.bw, plan.bh, 0, 0, plan.cw, plan.ch);
      const src = g.getImageData(0, 0, plan.cw, plan.ch).data;
      const H = destinationHomography(plan.quad, data.width, data.height);
      if (!H) return self.postMessage({ id, buffer: null });
      const out = new Uint8ClampedArray(data.width * data.height * 4);
      if (!warpInto(src, plan.cw, plan.ch, H, out, data.width, data.height)) return self.postMessage({ id, buffer: null });
      return self.postMessage({ id, buffer: out.buffer }, [out.buffer]);
    }
  } catch (error) { self.postMessage({ id, error: String(error?.message || error) }); }
};
