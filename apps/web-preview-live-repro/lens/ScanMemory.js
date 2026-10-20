/**
 * v0.4.1 — on-device learning from the user's own confirmed scans.
 *
 * When the user confirms a proposal, the projected 128-d descriptor of that scan (same space as the calibrated
 * index) is kept on this device with the confirmed printing family — never the camera image, nothing leaves
 * the phone. Next time a scan is very close to one of these descriptors (cosine ≥ MIN_SIM, i.e. the same card
 * in similar conditions), that family is proposed again first.
 *
 * Safety: memory only ever feeds PROPOSALS (the user still confirms). It never contributes to an automatic
 * identification, whose rules stay those of the calibrated index (FCIR 0).
 */
const KEY = 'scanMemory.v1';
export const MIN_SIM = 0.92;
const MAX = 400;

const toB64 = a => { let s = ''; const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const fromB64 = s => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Int8Array(u.buffer); };

export class ScanMemory {
  constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    this.storage = storage; this.items = [];
    try { this.items = (JSON.parse(this.storage?.getItem(KEY) || '[]') || []).map(x => ({ ...x, v: fromB64(x.v) })); } catch { this.items = []; }
  }

  get size() { return this.items.length; }

  _save() {
    try { this.storage?.setItem(KEY, JSON.stringify(this.items.map(x => ({ ...x, v: toB64(x.v) })))); } catch {}
  }

  /** Remember a confirmed scan (q: unit Float32Array descriptor). */
  add(id, q, { languages = [], at = Date.now() } = {}) {
    if (!id || !q?.length) return;
    const v = new Int8Array(q.length);
    for (let i = 0; i < q.length; i++) v[i] = Math.max(-127, Math.min(127, Math.round(q[i] * 127)));
    this.items.push({ id, languages, at, v });
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
    this._save();
  }

  /** Families remembered close to this descriptor: [{ id, sim }] best first (sim ≥ MIN_SIM). */
  match(q, minSim = MIN_SIM) {
    if (!q?.length || !this.items.length) return [];
    const best = new Map();
    for (const it of this.items) {
      if (it.v.length !== q.length) continue;
      let s = 0; for (let i = 0; i < q.length; i++) s += q[i] * it.v[i];
      s /= 127;
      if (s >= minSim && s > (best.get(it.id) ?? -1)) best.set(it.id, s);
    }
    return [...best].map(([id, sim]) => ({ id, sim })).sort((a, b) => b.sim - a.sim);
  }

  clear() { this.items = []; this._save(); }
}
