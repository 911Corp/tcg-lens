import { DEFAULT_POLICY } from './config.js';
import { validateCardQuad } from './QuadQuality.js';

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const x = from[i].x, y = from[i].y, u = to[i].x, v = to[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}


/**
 * Bilinear projective warp (pure; also used by the frame worker). H maps destination → source pixels.
 * Returns false on a non-finite projection. v0.3.9: tight loop, no per-pixel objects (~10× faster).
 */
export function warpInto(sd, sw, sh, H, od, W, Hh) {
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H, sw1 = sw - 1, sh1 = sh - 1;
  let di = 0;
  for (let y = 0; y < Hh; y++) {
    let nx = h1 * y + h2, ny = h4 * y + h5, d = h7 * y + h8;
    for (let x = 0; x < W; x++, nx += h0, ny += h3, d += h6, di += 4) {
      let px = nx / d, py = ny / d;
      if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
      px = px < 0 ? 0 : px > sw1 ? sw1 : px; py = py < 0 ? 0 : py > sh1 ? sh1 : py;
      const x0 = px | 0, y0 = py | 0, x1 = x0 < sw1 ? x0 + 1 : sw1, y1 = y0 < sh1 ? y0 + 1 : sh1;
      const fx = px - x0, fy = py - y0, gx = 1 - fx, gy = 1 - fy;
      const i00 = (y0 * sw + x0) << 2, i10 = (y0 * sw + x1) << 2, i01 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;
      od[di] = (sd[i00] * gx + sd[i10] * fx) * gy + (sd[i01] * gx + sd[i11] * fx) * fy;
      od[di + 1] = (sd[i00 + 1] * gx + sd[i10 + 1] * fx) * gy + (sd[i01 + 1] * gx + sd[i11 + 1] * fx) * fy;
      od[di + 2] = (sd[i00 + 2] * gx + sd[i10 + 2] * fx) * gy + (sd[i01 + 2] * gx + sd[i11 + 2] * fx) * fy;
      od[di + 3] = 255;
    }
  }
  return true;
}

/** Card bounding box crop (≈2× the output width) and the quad in crop pixels (shared by page and worker). */
export function cropPlan(quad, VW, VH, outWidth) {
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2), by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const bw = Math.min(VW, Math.ceil(Math.max(...xs)) + 2) - bx, bh = Math.min(VH, Math.ceil(Math.max(...ys)) + 2) - by;
  const k = Math.min(1, (outWidth * 2) / Math.max(1, bw));
  return { bx, by, bw, bh, cw: Math.max(1, Math.round(bw * k)), ch: Math.max(1, Math.round(bh * k)), quad: quad.map(p => ({ x: (p.x - bx) * k, y: (p.y - by) * k })) };
}

export function destinationHomography(quad, W, Hh) {
  const H = homography([{ x: 0, y: 0 }, { x: W - 1, y: 0 }, { x: W - 1, y: Hh - 1 }, { x: 0, y: Hh - 1 }], quad);
  return H && !H.some(v => !Number.isFinite(v)) ? H : null;
}

export class PerspectiveRectifier {
  constructor({ width = DEFAULT_POLICY.rectifiedWidth, aspect = DEFAULT_POLICY.cardAspect } = {}) {
    this.width = width;
    this.height = Math.round(width / aspect);
    this.source = document.createElement('canvas');
    this.lastValidation = null;
  }

  /** Same as rectify(), done in the frame worker on the frame it just analysed (no page stall). */
  async rectifyAsync(video, quad, frames) {
    if (!frames?.ready || !video?.videoWidth) return this.rectify(video, quad);
    this.lastValidation = validateCardQuad(quad, video.videoWidth, video.videoHeight);
    if (!this.lastValidation.valid) return null;
    let res;
    try { res = await frames.rectify(quad, this.width, this.height); } catch { return this.rectify(video, quad); }
    if (!res) { this.lastValidation = { ...this.lastValidation, valid: false, score: 0, reason: 'unstable_homography' }; return null; }
    const out = document.createElement('canvas'); out.width = this.width; out.height = this.height;
    out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res), this.width, this.height), 0, 0);
    return out;
  }

  rectify(video, quad) {
    if (!video?.videoWidth || !video?.videoHeight) {
      this.lastValidation = { valid: false, score: 0, reason: 'missing_video_dimensions' };
      return null;
    }
    this.lastValidation = validateCardQuad(quad, video.videoWidth, video.videoHeight);
    if (!this.lastValidation.valid) return null;
    // v0.3.3: copy only the card's bounding box, at ~2× the output resolution, instead of the whole
    // camera frame (a 1080×1920 getImageData every tick was the costliest step on phones).
    const VW = video.videoWidth, VH = video.videoHeight;
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2), by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const bw = Math.min(VW, Math.ceil(Math.max(...xs)) + 2) - bx, bh = Math.min(VH, Math.ceil(Math.max(...ys)) + 2) - by;
    const k = Math.min(1, (this.width * 2) / Math.max(1, bw));
    const src = this.source;
    src.width = Math.max(1, Math.round(bw * k)); src.height = Math.max(1, Math.round(bh * k));
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(video, bx, by, bw, bh, 0, 0, src.width, src.height);
    const sourceData = sctx.getImageData(0, 0, src.width, src.height);
    quad = quad.map(p => ({ x: (p.x - bx) * k, y: (p.y - by) * k }));
    const out = document.createElement('canvas'); out.width = this.width; out.height = this.height;
    const octx = out.getContext('2d');
    const output = octx.createImageData(out.width, out.height);
    const dstQuad = [{ x: 0, y: 0 }, { x: out.width - 1, y: 0 }, { x: out.width - 1, y: out.height - 1 }, { x: 0, y: out.height - 1 }];
    const H = homography(dstQuad, quad); // destination -> source
    if (!H || H.some(v => !Number.isFinite(v))) {
      this.lastValidation = { ...this.lastValidation, valid: false, score: 0, reason: 'unstable_homography' };
      return null;
    }
    if (!warpInto(sourceData.data, src.width, src.height, H, output.data, out.width, out.height)) {
      this.lastValidation = { ...this.lastValidation, valid: false, score: 0, reason: 'non_finite_projection' };
      return null;
    }
    octx.putImageData(output, 0, 0);
    return out;
  }
}
