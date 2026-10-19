import { clamp } from './config.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a, b, c) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

function angleDeg(prev, current, next) {
  const ax = prev.x - current.x, ay = prev.y - current.y;
  const bx = next.x - current.x, by = next.y - current.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const cosine = clamp((ax * bx + ay * by) / (la * lb), -1, 1);
  return Math.acos(cosine) * 180 / Math.PI;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function validateCardQuad(quad, frameWidth, frameHeight, options = {}) {
  const cfg = {
    minAreaRatio: 0.025,
    maxAreaRatio: 0.86,
    minAspect: 0.42,
    maxAspect: 0.94,
    minAngleDeg: 22,
    maxAngleDeg: 158,
    boundsToleranceRatio: 0.025,
    ...options,
  };
  if (!Array.isArray(quad) || quad.length !== 4 || !Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || frameWidth <= 0 || frameHeight <= 0) {
    return { valid: false, score: 0, reason: 'invalid_quad_input' };
  }
  if (quad.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return { valid: false, score: 0, reason: 'non_finite_corner' };

  const tolX = frameWidth * cfg.boundsToleranceRatio, tolY = frameHeight * cfg.boundsToleranceRatio;
  if (quad.some(p => p.x < -tolX || p.y < -tolY || p.x > frameWidth + tolX || p.y > frameHeight + tolY)) {
    return { valid: false, score: 0, reason: 'quad_out_of_bounds' };
  }

  const signs = quad.map((p, i) => cross(p, quad[(i + 1) % 4], quad[(i + 2) % 4]));
  const nonZero = signs.filter(v => Math.abs(v) > 1e-6);
  if (nonZero.length !== 4 || !nonZero.every(v => Math.sign(v) === Math.sign(nonZero[0]))) {
    return { valid: false, score: 0, reason: 'non_convex_or_self_intersecting' };
  }

  const area = polygonArea(quad);
  const areaRatio = area / (frameWidth * frameHeight);
  if (areaRatio < cfg.minAreaRatio) return { valid: false, score: 0, reason: 'quad_too_small', areaRatio };
  if (areaRatio > cfg.maxAreaRatio) return { valid: false, score: 0, reason: 'quad_too_large', areaRatio };

  const edges = quad.map((p, i) => distance(p, quad[(i + 1) % 4]));
  const minEdge = Math.max(10, Math.min(frameWidth, frameHeight) * 0.035);
  if (Math.min(...edges) < minEdge) return { valid: false, score: 0, reason: 'edge_too_short', areaRatio, edges };

  const avgWidth = (edges[0] + edges[2]) / 2;
  const avgHeight = (edges[1] + edges[3]) / 2;
  const aspect = avgWidth / Math.max(1e-6, avgHeight);
  if (aspect < cfg.minAspect || aspect > cfg.maxAspect) return { valid: false, score: 0, reason: 'implausible_card_aspect', areaRatio, aspect };

  const angles = quad.map((p, i) => angleDeg(quad[(i + 3) % 4], p, quad[(i + 1) % 4]));
  if (angles.some(a => a < cfg.minAngleDeg || a > cfg.maxAngleDeg)) return { valid: false, score: 0, reason: 'extreme_perspective', areaRatio, aspect, angles };

  const targetAspect = 63 / 88;
  const aspectScore = 1 - clamp(Math.abs(aspect - targetAspect) / 0.30, 0, 1);
  const areaScore = clamp((areaRatio - cfg.minAreaRatio) / 0.18, 0, 1);
  const angleScore = 1 - clamp(angles.reduce((sum, a) => sum + Math.abs(a - 90), 0) / (4 * 68), 0, 1);
  const score = clamp(aspectScore * 0.45 + areaScore * 0.25 + angleScore * 0.30, 0, 1);
  return { valid: true, score, reason: 'ok', areaRatio, aspect, angles, edges };
}
