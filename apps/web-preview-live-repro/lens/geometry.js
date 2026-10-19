export function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

export function centerDistance(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by) / Math.hypot(Math.max(a.w, b.w), Math.max(a.h, b.h));
}

export function quadArea(q) {
  if (!q || q.length !== 4) return 0;
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function blendQuad(a, b, k = 0.35) {
  if (!a) return b?.map(p => ({ ...p })) || null;
  if (!b) return a?.map(p => ({ ...p })) || null;
  return a.map((p, i) => ({ x: p.x * (1 - k) + b[i].x * k, y: p.y * (1 - k) + b[i].y * k }));
}
