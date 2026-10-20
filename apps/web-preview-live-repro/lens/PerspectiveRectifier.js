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

function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}

export class PerspectiveRectifier {
  constructor({ width = DEFAULT_POLICY.rectifiedWidth, aspect = DEFAULT_POLICY.cardAspect } = {}) {
    this.width = width;
    this.height = Math.round(width / aspect);
    this.source = document.createElement('canvas');
    this.lastValidation = null;
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
    const sw = src.width, sh = src.height, sd = sourceData.data, od = output.data;
    const sample = (x, y, channel) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4 + channel, i10 = (y0 * sw + x1) * 4 + channel;
      const i01 = (y1 * sw + x0) * 4 + channel, i11 = (y1 * sw + x1) * 4 + channel;
      const top = sd[i00] * (1 - fx) + sd[i10] * fx;
      const bottom = sd[i01] * (1 - fx) + sd[i11] * fx;
      return top * (1 - fy) + bottom * fy;
    };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const p = applyH(H, x, y);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        this.lastValidation = { ...this.lastValidation, valid: false, score: 0, reason: 'non_finite_projection' };
        return null;
      }
      const sx = Math.max(0, Math.min(sw - 1, p.x)), sy = Math.max(0, Math.min(sh - 1, p.y));
      const di = (y * out.width + x) * 4;
      od[di] = sample(sx, sy, 0); od[di + 1] = sample(sx, sy, 1); od[di + 2] = sample(sx, sy, 2); od[di + 3] = 255;
    }
    octx.putImageData(output, 0, 0);
    return out;
  }
}
