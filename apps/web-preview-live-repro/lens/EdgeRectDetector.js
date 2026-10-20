/**
 * Card detector v0.3.3 — straight-edge rectangle search.
 *
 * A trading card is a 63:88 rectangle with four long straight borders. Instead of segmenting a
 * blob (fragile on wood, fabric, busy tables, hands, sleeves), we look for those borders directly:
 *
 *   1. Sobel gradients on a small grayscale copy of the frame (≈240 px wide).
 *   2. For a few hypothesis angles (±12°), oriented edge pixels vote into 1-D projection histograms:
 *      vertical borders along u = x·cosθ + y·sinθ, horizontal borders along v = −x·sinθ + y·cosθ.
 *   3. Pairs of strong left/right peaks fix the width; the 63:88 ratio predicts the height, and the
 *      top/bottom peaks are searched only between those borders.
 *   4. Every hypothesis is verified by sampling the four sides: the fraction of each side that lies on
 *      a correctly oriented edge ("coverage"). Occlusion of one side by a finger is tolerated.
 *
 * Pure function of the pixels; same inputs → same quad. Returns [{ box, quad, score, coverage }].
 */
const ASPECT = 63 / 88;

export class EdgeRectDetector {
  constructor({ width = 240, angles = [-12, -9, -6, -4, -2, 0, 2, 4, 6, 9, 12], minCoverage = 0.5 } = {}) {
    this.width = width;
    this.angles = angles.map(a => a * Math.PI / 180);
    this.minCoverage = minCoverage;
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this.ctx = this.canvas?.getContext('2d', { willReadFrequently: true }) || null;
  }

  /** Small RGBA copy of the frame (what detectRect works on). */
  grab(source) {
    const VW = source.videoWidth || source.width, VH = source.videoHeight || source.height;
    if (!VW || !VH || !this.ctx) return null;
    const w = this.width, h = Math.round(VH / VW * w);
    this.canvas.width = w; this.canvas.height = h;
    this.ctx.drawImage(source, 0, 0, w, h);
    return { rgba: this.ctx.getImageData(0, 0, w, h).data, w, h, scale: VW / w };
  }

  hintAngles(angleHint) { return [-3, -1.5, 0, 1.5, 3].map(d => angleHint + d * Math.PI / 180); }

  /** detectRect output (detector pixels) → detection in video pixels. */
  toDetection(found, scale) {
    if (!found) return [];
    const quad = found.quad.map(p => ({ x: p.x * scale, y: p.y * scale }));
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    return [{ box, quad, score: found.score, coverage: found.coverage, angle: found.th, source: 'edge-rect' }];
  }

  /** @param {{ angleHint?: number }} [opts] radians of the tracked card: search ±3° around it only. */
  detect(source, opts = {}) {
    const VW = source.videoWidth || source.width, VH = source.videoHeight || source.height;
    if (!VW || !VH || !this.ctx) return [];
    const w = this.width, h = Math.round(VH / VW * w);
    this.canvas.width = w; this.canvas.height = h;
    this.ctx.drawImage(source, 0, 0, w, h);
    const rgba = this.ctx.getImageData(0, 0, w, h).data;
    const angles = Number.isFinite(opts.angleHint) ? [-3, -1.5, 0, 1.5, 3].map(d => opts.angleHint + d * Math.PI / 180) : this.angles;
    const found = detectRect(rgba, w, h, angles, this.minCoverage);
    if (!found) return [];
    const s = VW / w;
    const quad = found.quad.map(p => ({ x: p.x * s, y: p.y * s }));
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    return [{ box, quad, score: found.score, coverage: found.coverage, angle: found.th, source: 'edge-rect' }];
  }
}

/** Core search on an RGBA buffer (exported for tests). */
export function detectRect(rgba, w, h, angles, minCoverage = 0.5, opts = {}) {
  const prep = prepareEdges(rgba, w, h);
  return prep ? searchRect(prep, angles, minCoverage, opts) : null;
}

/**
 * v0.3.9 — several cards in one frame (multi-card mode): repeated search, each new card must not overlap a
 * card already found. Smaller cards allowed (minWidthFrac). Same verification as the single-card search.
 */
export function detectRects(rgba, w, h, angles, minCoverage = 0.5, { max = 6, minWidthFrac = 0.1 } = {}) {
  const prep = prepareEdges(rgba, w, h); if (!prep) return [];
  const found = [];
  for (let k = 0; k < max; k++) {
    const r = searchRect(prep, angles, minCoverage, { minWidthFrac, exclude: found.map(f => f.quad) });
    if (!r) break;
    found.push(r);
  }
  return found;
}

function inside(pt, quad) {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = quad[i], b = quad[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
/** A hypothesis overlaps an already found card: its centre or one of its corners pulled 20 % inwards lies inside. */
function overlaps(quad, exclude) {
  if (!exclude?.length) return false;
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const pts = [{ x: cx, y: cy }, ...quad.map(p => ({ x: p.x + (cx - p.x) * 0.2, y: p.y + (cy - p.y) * 0.2 }))];
  return exclude.some(q => pts.some(p => inside(p, q)) || inside({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 }, quad));
}

/** Gradients and strong edge pixels (shared by single and multi search). */
export function prepareEdges(rgba, w, h) {
  const n = w * h, gray = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  // Max over channels catches colour-only borders (yellow card on beige table).
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  let sum = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    let bx = 0, by = 0, best = -1;
    for (let c = 0; c < 3; c++) {
      const q = p * 4 + c, row = w * 4;
      const sx = (rgba[q + 4 - row] + 2 * rgba[q + 4] + rgba[q + 4 + row]) - (rgba[q - 4 - row] + 2 * rgba[q - 4] + rgba[q - 4 + row]);
      const sy = (rgba[q + row - 4] + 2 * rgba[q + row] + rgba[q + row + 4]) - (rgba[q - row - 4] + 2 * rgba[q - row] + rgba[q - row + 4]);
      const m = sx * sx + sy * sy;
      if (m > best) { best = m; bx = sx; by = sy; }
    }
    gx[p] = bx; gy[p] = by; const m = Math.sqrt(best); mag[p] = m; sum += m;
  }
  const mean = sum / n;
  const thr = Math.max(40, mean * 1.6);
  // Edge pixel list (strong only) for voting.
  const ex = [], ey = [], ew = [], eg = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const p = y * w + x; if (mag[p] < thr) continue;
    ex.push(x); ey.push(y); ew.push(Math.min(mag[p], thr * 4)); eg.push(p);
  }
  if (ex.length < 40) return null;
  return { w, h, gx, gy, mag, thr, ex, ey, ew, eg };
}

export function searchRect(prep, angles, minCoverage = 0.5, { minWidthFrac = 0.22, exclude = null } = {}) {
  const { w, h, gx, gy, mag, thr, ex, ey, ew, eg } = prep;
  const diag = Math.ceil(Math.hypot(w, h)) + 2, E = ex.length;
  const uArr = new Float32Array(E), vArr = new Float32Array(E), isV = new Uint8Array(E), isH = new Uint8Array(E);
  let best = null; const all = [];
  for (const th of angles) {
    const c = Math.cos(th), s = Math.sin(th);
    const U = new Float32Array(diag * 2);
    for (let i = 0; i < E; i++) {
      const p = eg[i], m = mag[p];
      uArr[i] = ex[i] * c + ey[i] * s + diag; vArr[i] = -ex[i] * s + ey[i] * c + diag;
      isV[i] = Math.abs(gx[p] * c + gy[p] * s) / m > 0.92 ? 1 : 0;   // gradient along u → vertical border
      isH[i] = Math.abs(-gx[p] * s + gy[p] * c) / m > 0.92 ? 1 : 0;  // gradient along v → horizontal border
      if (isV[i]) U[Math.round(uArr[i])] += ew[i];
    }
    const Us = smooth(U), uPeaks = peaks(Us, 9);
    // Strongest plausible left/right pairs first.
    const pairs = [];
    for (let a = 0; a < uPeaks.length; a++) for (let b = a + 1; b < uPeaks.length; b++) {
      const width = uPeaks[b] - uPeaks[a];
      if (width < w * minWidthFrac || width > w * 0.98 || width / ASPECT > h * 1.02) continue;
      pairs.push([uPeaks[a], uPeaks[b], Us[uPeaks[a]] + Us[uPeaks[b]]]);
    }
    pairs.sort((x, y) => y[2] - x[2]);
    for (const [L, R] of pairs.slice(0, exclude ? 24 : 10)) {
      const width = R - L, H = width / ASPECT;
      const Vb = new Float32Array(diag * 2);
      for (let i = 0; i < E; i++) if (isH[i] && uArr[i] >= L - 1 && uArr[i] <= R + 1) Vb[Math.round(vArr[i])] += ew[i];
      const Vs = smooth(Vb), vPeaks = peaks(Vs, 8);
      // Cards are exactly 63:88: one horizontal border plus the ratio fixes the other one, so a
      // border hidden by a finger or a sleeve edge does not matter.
      const tried = new Set();
      const consider = (T, B) => {
        const key = `${Math.round(T)}:${Math.round(B)}`; if (tried.has(key)) return; tried.add(key);
        const quad = corners(L - diag, R - diag, T - diag, B - diag, c, s);
        if (quad.some(q => q.x < -2 || q.y < -2 || q.x > w + 1 || q.y > h + 1)) return;
        if (exclude && overlaps(quad, exclude)) return;
        const cov = coverage(quad, gx, gy, mag, w, h, thr * 0.75);
        const sorted = [...cov].sort((x, y) => x - y);
        // Mean of the three best sides (one side may be occluded), the worst side must still exist a bit.
        const score = (sorted[1] + sorted[2] + sorted[3]) / 3;
        if (sorted[0] < 0.12 || score < minCoverage) return;
        // Prefer the outer card edge over the inner artwork frame when scores are close.
        const rank = score + Math.min(0.06, (width * (B - T)) / (w * h) * 0.08) + sorted[0] * 0.1;
        const cand = { rank, score, coverage: cov, quad, width, height: B - T, cu: (L + R) / 2, cv: (T + B) / 2, th, contrast: null };
        all.push(cand);
        if (best && rank <= best.rank) return;
        // A real border is a line, not a texture: parallel lines a few pixels away must be much
        // weaker (rejects grids, fabric, wood grain that happen to fit the ratio). Lazy: only for
        // a candidate about to win.
        if (!isLine(cand, gx, gy, mag, w, h, thr)) return;
        best = cand;
      };
      for (const P of vPeaks) { consider(P, P + H); consider(P - H, P); }
    }
  }
  if (!best) return null;
  // Pokémon cards have an inner frame with nearly the same ratio. If a slightly larger concentric
  // rectangle is also supported by edges, it is the physical card edge: take it.
  let outer = best;
  for (const c of all) {
    if (c.th !== best.th || c.width <= outer.width) continue;
    const k = c.width / best.width;
    if (k < 1.03 || k > 1.16) continue;
    if (Math.abs(c.cu - best.cu) > best.width * 0.05 || Math.abs(c.cv - best.cv) > best.height * 0.05) continue;
    if (c.score >= best.score * 0.7 && isLine(c, gx, gy, mag, w, h, thr)) outer = c;
  }
  // Each border is then refined on its own (endpoints moved along the normal), which absorbs the
  // angle step and mild perspective; corners are the intersections of the four refined lines.
  const lines = [0, 1, 2, 3].map(k => refineSide(outer.quad[k], outer.quad[(k + 1) % 4], gx, gy, mag, w, h, thr * 0.75));
  const quad = [0, 1, 2, 3].map(k => intersect(lines[(k + 3) % 4], lines[k]) || outer.quad[k]);
  return { ...outer, quad };
}

function sideHits(a, b, gx, gy, mag, w, h, thr, band = 1) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  let hit = 0, total = 0;
  for (let t = 0.07; t <= 0.93; t += 0.02) {
    total++;
    for (let o = -band; o <= band; o++) {
      const x = Math.round(a.x + dx * t + nx * o), y = Math.round(a.y + dy * t + ny * o);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const p = y * w + x, m = mag[p];
      if (m >= thr && Math.abs(gx[p] * nx + gy[p] * ny) / m > 0.8) { hit++; break; }
    }
  }
  return hit / total;
}

function isLine(c, gx, gy, mag, w, h, thr) {
  if (c.contrast == null) c.contrast = lineContrast(c.quad, gx, gy, mag, w, h, thr * 0.75);
  return c.contrast >= 0.22;
}

function lineContrast(q, gx, gy, mag, w, h, thr) {
  let total = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const at = o => sideHits({ x: a.x + nx * o, y: a.y + ny * o }, { x: b.x + nx * o, y: b.y + ny * o }, gx, gy, mag, w, h, thr, 1);
    const on = at(0), off = (at(-6) + at(6) + at(-10) + at(10)) / 4;
    total += on - off;
  }
  return total / 4;
}

function refineSide(a, b, gx, gy, mag, w, h, thr) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  let best = { a, b, score: sideHits(a, b, gx, gy, mag, w, h, thr, 0) };
  for (let oa = -3; oa <= 3; oa++) for (let ob = -3; ob <= 3; ob++) {
    const A = { x: a.x + nx * oa, y: a.y + ny * oa }, B = { x: b.x + nx * ob, y: b.y + ny * ob };
    const sc = sideHits(A, B, gx, gy, mag, w, h, thr, 0) - (Math.abs(oa) + Math.abs(ob)) * 0.004;
    if (sc > best.score) best = { a: A, b: B, score: sc };
  }
  return best;
}

function intersect(l1, l2) {
  const x1 = l1.a.x, y1 = l1.a.y, x2 = l1.b.x, y2 = l1.b.y, x3 = l2.a.x, y3 = l2.a.y, x4 = l2.b.x, y4 = l2.b.y;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-6) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

function smooth(a) {
  const o = new Float32Array(a.length);
  for (let i = 2; i < a.length - 2; i++) o[i] = (a[i - 2] + 2 * a[i - 1] + 3 * a[i] + 2 * a[i + 1] + a[i + 2]) / 9;
  return o;
}

function peaks(a, k) {
  let max = 0; for (const v of a) if (v > max) max = v;
  const out = [];
  for (let i = 3; i < a.length - 3; i++) {
    const v = a[i];
    if (v < max * 0.12) continue;
    if (v >= a[i - 1] && v > a[i + 1] && v >= a[i - 2] && v > a[i + 2] && v >= a[i - 3] && v > a[i + 3]) out.push(i);
  }
  return out.sort((x, y) => a[y] - a[x]).slice(0, k).sort((x, y) => x - y);
}

/** Rectangle corners (TL, TR, BR, BL) from line positions in the rotated frame. */
function corners(L, R, T, B, c, s) {
  const back = (u, v) => ({ x: u * c - v * s, y: u * s + v * c });
  return [back(L, T), back(R, T), back(R, B), back(L, B)];
}

/** Fraction of each side (top, right, bottom, left) lying on a correctly oriented edge. */
function coverage(q, gx, gy, mag, w, h, thr) {
  const out = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    let hit = 0, total = 0;
    // Skip the rounded corners (≈5 % of each side).
    for (let t = 0.07; t <= 0.93; t += 0.02) {
      total++;
      for (let o = -2; o <= 2; o++) {
        const x = Math.round(a.x + dx * t + nx * o), y = Math.round(a.y + dy * t + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const p = y * w + x, m = mag[p];
        if (m < thr) continue;
        if (Math.abs(gx[p] * nx + gy[p] * ny) / m > 0.8) { hit++; break; }
      }
    }
    out.push(hit / total);
  }
  return out;
}
