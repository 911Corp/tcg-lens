import { centerDistance, iou, blendQuad } from './geometry.js';

export class TrackManager {
  constructor({ minStableHits = 4, lostAfterMs = 850 } = {}) {
    this.minStableHits = minStableHits;
    this.lostAfterMs = lostAfterMs;
    this.nextId = 1;
    this.track = null;
    this.generation = 0;
  }

  reset() { this.track = null; this.generation++; }

  bumpGeneration() {
    this.generation++;
    if (this.track) { this.track.generation = this.generation; this.track.hits = this.minStableHits; this.track.stable = true; }
    return this.track;
  }

  update(detections, at = performance.now()) {
    const d = detections[0] || null;
    if (!d) {
      if (this.track && at - this.track.lastSeen > this.lostAfterMs) this.reset();
      return this.track;
    }
    if (!this.track) return this._newTrack(d, at);
    const overlap = iou(this.track.box, d.box), distance = centerDistance(this.track.box, d.box);
    if (overlap < 0.08 && distance > 0.52) return this._newTrack(d, at);
    const k = 0.32, old = this.track.box;
    this.track.box = { x: old.x * (1 - k) + d.box.x * k, y: old.y * (1 - k) + d.box.y * k, w: old.w * (1 - k) + d.box.w * k, h: old.h * (1 - k) + d.box.h * k };
    this.track.quad = blendQuad(this.track.quad, d.quad, k);
    this.track.lastSeen = at;
    this.track.hits++;
    this.track.stable = this.track.hits >= this.minStableHits;
    return this.track;
  }

  _newTrack(d, at) {
    this.generation++;
    this.track = { id: this.nextId++, generation: this.generation, box: { ...d.box }, quad: d.quad?.map(p => ({ ...p })) || null, hits: 1, stable: false, lastSeen: at };
    return this.track;
  }
}
