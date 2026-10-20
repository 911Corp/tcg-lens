import { clamp } from './config.js';
import { EdgeRectDetector } from './EdgeRectDetector.js';

function extremeQuad(points) {
  if (!points.length) return null;
  let tl = points[0], tr = points[0], br = points[0], bl = points[0];
  for (const p of points) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl];
}

/**
 * v0.3.3: straight-edge rectangle search first (EdgeRectDetector: 81 % correct on realistic scenes
 * vs 43 % for the blob detector, 73 % vs 0 % on a busy table). The blob detector remains a fallback
 * for strongly rotated cards. While a card is tracked, only angles near its own are searched.
 */
export class CardDetector {
  constructor(opts = {}) { this.edge = new EdgeRectDetector(); this.blob = new BlobCardDetector(opts); this.frames = opts.frames || null; }

  /** v0.3.9: same result as detect(), computed in the frame worker when it is available. */
  async detectAsync(video, { angleHint } = {}) {
    const f = this.frames;
    if (!f?.ready || !video?.videoWidth) return this.detect(video, { angleHint });
    const angleSets = [...(Number.isFinite(angleHint) ? [this.edge.hintAngles(angleHint)] : []), this.edge.angles];
    let r;
    try { r = await f.detect(video, { detW: this.edge.width, angleSets, minCoverage: this.edge.minCoverage }); }
    catch { return this.detect(video, { angleHint }); }
    const edge = this.edge.toDetection(r.found, r.scale);
    if (edge.length) return edge;
    return this.blob.detect(video).map(d => ({ ...d, source: 'blob' }));
  }

  detect(video, { angleHint } = {}) {
    if (Number.isFinite(angleHint)) {
      const near = this.edge.detect(video, { angleHint });
      if (near.length) return near;
    }
    const edge = this.edge.detect(video);
    if (edge.length) return edge;
    return this.blob.detect(video).map(d => ({ ...d, source: 'blob' }));
  }
}

export class BlobCardDetector {
  constructor({ detectorWidth = 184 } = {}) {
    this.detectorWidth = detectorWidth;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  detect(video) {
    const VW = video.videoWidth, VH = video.videoHeight;
    if (!VW || !VH) return [];
    const dw = this.detectorWidth, dh = Math.max(128, Math.round(VH / VW * dw));
    this.canvas.width = dw; this.canvas.height = dh;
    this.ctx.drawImage(video, 0, 0, dw, dh);
    const rgba = this.ctx.getImageData(0, 0, dw, dh).data;
    const gray = new Uint8Array(dw * dh), edge = new Uint8Array(dw * dh);
    let edgeSum = 0, edgeN = 0;
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) gray[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
    for (let y = 1; y < dh - 1; y++) for (let x = 1; x < dw - 1; x++) {
      const p = y * dw + x, gx = gray[p + 1] - gray[p - 1], gy = gray[p + dw] - gray[p - dw];
      edgeSum += Math.abs(gx) + Math.abs(gy); edgeN++;
    }
    const threshold = clamp(edgeSum / Math.max(1, edgeN) * 2.2, 30, 78);
    for (let y = 1; y < dh - 1; y++) for (let x = 1; x < dw - 1; x++) {
      const p = y * dw + x, gx = gray[p + 1] - gray[p - 1], gy = gray[p + dw] - gray[p - dw];
      if (Math.abs(gx) + Math.abs(gy) > threshold) edge[p] = 1;
    }
    let mask = edge;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Uint8Array(mask);
      for (let y = 2; y < dh - 2; y++) for (let x = 2; x < dw - 2; x++) {
        const p = y * dw + x;
        if (!mask[p]) continue;
        next[p - 1] = next[p + 1] = next[p - dw] = next[p + dw] = 1;
      }
      mask = next;
    }
    const seen = new Uint8Array(dw * dh), candidates = [], stack = [];
    const sx = VW / dw, sy = VH / dh;
    for (let y = 1; y < dh - 1; y += 2) for (let x = 1; x < dw - 1; x += 2) {
      const seed = y * dw + x;
      if (!mask[seed] || seen[seed]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      const points = [];
      stack.length = 0; stack.push(seed); seen[seed] = 1;
      while (stack.length && count < 26000) {
        const z = stack.pop(), zy = (z / dw) | 0, zx = z - zy * dw;
        count++; minX = Math.min(minX, zx); maxX = Math.max(maxX, zx); minY = Math.min(minY, zy); maxY = Math.max(maxY, zy);
        if ((count & 3) === 0) points.push({ x: zx, y: zy });
        for (const nz of [z - 1, z + 1, z - dw, z + dw]) if (nz > 0 && nz < mask.length && mask[nz] && !seen[nz]) { seen[nz] = 1; stack.push(nz); }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1, area = bw * bh;
      const portraitRatio = Math.min(bw, bh) / Math.max(bw, bh);
      const fill = count / Math.max(1, area);
      const areaRatio = area / (dw * dh);
      if (areaRatio < 0.035 || areaRatio > 0.70 || portraitRatio < 0.56 || portraitRatio > 0.82 || fill < 0.035) continue;
      const quadSmall = extremeQuad(points);
      if (!quadSmall) continue;
      let quad = quadSmall.map(p => ({ x: p.x * sx, y: p.y * sy }));
      let box = { x: minX * sx, y: minY * sy, w: bw * sx, h: bh * sy };
      if (box.w > box.h) {
        quad = [quad[3], quad[0], quad[1], quad[2]];
        box = { ...box, rotated: true };
      }
      const centerBias = 1 - Math.min(1, Math.hypot((box.x + box.w / 2) / VW - 0.5, (box.y + box.h / 2) / VH - 0.5));
      const aspectTarget = 63 / 88;
      const aspectScore = 1 - Math.min(1, Math.abs(portraitRatio - aspectTarget) / 0.2);
      candidates.push({ box, quad, score: aspectScore * 0.48 + fill * 0.22 + areaRatio * 0.15 + centerBias * 0.15 });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 1); // milestone: intentionally single-card only
  }
}
