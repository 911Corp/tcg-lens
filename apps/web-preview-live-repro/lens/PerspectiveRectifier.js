import { DEFAULT_POLICY } from './config.js';

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
  }

  rectify(video, quad) {
    if (!video?.videoWidth || !quad || quad.length !== 4) return null;
    const src = this.source;
    src.width = video.videoWidth; src.height = video.videoHeight;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(video, 0, 0, src.width, src.height);
    const sourceData = sctx.getImageData(0, 0, src.width, src.height);
    const out = document.createElement('canvas'); out.width = this.width; out.height = this.height;
    const octx = out.getContext('2d');
    const output = octx.createImageData(out.width, out.height);
    const dstQuad = [{ x: 0, y: 0 }, { x: out.width - 1, y: 0 }, { x: out.width - 1, y: out.height - 1 }, { x: 0, y: out.height - 1 }];
    const H = homography(dstQuad, quad); // destination -> source
    if (!H) return null;
    const sw = src.width, sh = src.height, sd = sourceData.data, od = output.data;
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const p = applyH(H, x, y);
      const sx = Math.max(0, Math.min(sw - 1, Math.round(p.x))), sy = Math.max(0, Math.min(sh - 1, Math.round(p.y)));
      const si = (sy * sw + sx) * 4, di = (y * out.width + x) * 4;
      od[di] = sd[si]; od[di + 1] = sd[si + 1]; od[di + 2] = sd[si + 2]; od[di + 3] = 255;
    }
    octx.putImageData(output, 0, 0);
    return out;
  }
}
