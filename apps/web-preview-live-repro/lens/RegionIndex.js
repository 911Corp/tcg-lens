/**
 * v0.4.2 — edition and script discrimination between artwork twins, from three card zones (tools/deep/train-regions.py).
 *
 * The calibrated index recognises the illustration very well; 95 % of its remaining top-1 errors are artwork twins
 * (another printing with the same illustration). This index compares the zones where printings differ — text box,
 * bottom band (set symbol, number, copyright), top band (name, HP/PV) — of a 448-px rectified crop against every
 * reference of the twin group. Loaded lazily, the first time a candidate with twins needs it.
 *
 * Outputs are evidence only, used under calibrated bars with zero errors on held-out crops:
 *   - editionMargin ≥ calibration.twinMargin → the printing among its twins;
 *   - P(Japanese) ≥ scriptThreshold (or ≤ 1 − threshold) → visual script proof.
 */
import { versionedFetch } from './indexVersion.js';

export const REGION_SCHEMA = 'tcg-lens-region-index-v1';

export class RegionIndex {
  constructor({ base = '/data', fetchImpl = null } = {}) {
    this.base = base; this.fetchImpl = fetchImpl || versionedFetch(base);
    this.meta = null; this.mean = null; this.M = null; this.scriptW = null; this.scriptB = 0;
    this.byLangRow = new Map(); // `${lang}:${row}` -> Int8Array view
    this.loading = null; this.failed = false;
  }

  get ready() { return Boolean(this.meta); }

  async _gz(path) {
    const res = await this.fetchImpl(`${this.base}/${path}`);
    if (!res.ok) throw new Error(`${path} unavailable`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer;
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  load() {
    if (this.meta || this.failed) return Promise.resolve(Boolean(this.meta));
    if (!this.loading) this.loading = (async () => {
      try {
        const res = await this.fetchImpl(`${this.base}/region-index.json`);
        if (!res.ok) throw new Error('region index unavailable');
        const meta = await res.json();
        if (meta.schema !== REGION_SCHEMA) throw new Error('region schema');
        const f = new Float32Array(await this._gz('region-model.bin.gz'));
        const I = meta.inDims, D = meta.dims;
        this.mean = f.subarray(0, I); this.M = f.subarray(I, I + I * D); this.scriptW = f.subarray(I + I * D, I + I * D + D); this.scriptB = f[I + I * D + D];
        for (const lang of Object.keys(meta.rows)) {
          const vec = new Int8Array(await this._gz(`region-index-${lang}.bin.gz`));
          meta.rows[lang].forEach((row, k) => this.byLangRow.set(`${lang}:${row}`, vec.subarray(k * D, (k + 1) * D)));
        }
        this.meta = meta;
        return true;
      } catch { this.failed = true; return false; }
    })();
    return this.loading;
  }

  /** Card zones of a 448-px rectified card, as 224 × 224 canvases (same boxes as training). */
  zones(canvas) {
    return this.meta.regions.map(r => {
      const [x0, y0, x1, y1] = this.meta.boxes[r];
      const o = document.createElement('canvas'); o.width = 224; o.height = 224;
      o.getContext('2d').drawImage(canvas, x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height, 0, 0, 224, 224);
      return o;
    });
  }

  /** [3 × 1280 normalized embeddings] → unit 96-d descriptor. */
  project(embs) {
    const I = this.meta.inDims, D = this.meta.dims, x = new Float32Array(I);
    let o = 0;
    for (const e of embs) { let n = 0; for (let i = 0; i < e.length; i++) n += e[i] * e[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < e.length; i++) x[o + i] = e[i] / n - this.mean[o + i]; o += e.length; }
    const q = new Float32Array(D);
    for (let i = 0; i < I; i++) { const xi = x[i]; if (!xi) continue; const off = i * D; for (let d = 0; d < D; d++) q[d] += xi * this.M[off + d]; }
    let n = 0; for (let d = 0; d < D; d++) n += q[d] * q[d]; n = Math.sqrt(n) || 1;
    for (let d = 0; d < D; d++) q[d] /= n;
    return q;
  }

  /** P(the card is printed in Japanese). */
  pJapanese(q) { let z = this.scriptB; for (let d = 0; d < q.length; d++) z += this.scriptW[d] * q[d]; return 1 / (1 + Math.exp(-z)); }

  /**
   * Best zone similarity per printing family: families = [{ id, rows: [[lang, row], …] }].
   * Returns [{ id, score }] best first (families without zone references are left out).
   */
  scoreFamilies(q, families) {
    const out = [];
    for (const f of families) {
      let best = -9;
      for (const [lang, row] of f.rows) {
        const v = this.byLangRow.get(`${lang}:${row}`); if (!v) continue;
        let s = 0; for (let d = 0; d < q.length; d++) s += q[d] * v[d];
        if (s / 127 > best) best = s / 127;
      }
      if (best > -9) out.push({ id: f.id, score: best });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Edition decision among a twin group: { id, margin, decided } (decided only under the calibrated bar). */
  decide(q, families) {
    const s = this.scoreFamilies(q, families);
    if (s.length < 2 || s.length < families.length) return { id: s[0]?.id ?? null, margin: 0, decided: false, scores: s };
    const margin = s[0].score - s[1].score;
    return { id: s[0].id, margin, decided: margin >= this.meta.calibration.twinMargin, scores: s };
  }

  /** 'ja' | 'latin' | null under the calibrated script threshold. */
  script(q) {
    const p = this.pJapanese(q), t = this.meta.calibration.scriptThreshold;
    return p >= t ? 'ja' : p <= 1 - t ? 'latin' : null;
  }
}
