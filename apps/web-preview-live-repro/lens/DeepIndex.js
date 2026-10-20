/**
 * v0.3.5 calibrated instant recognition index.
 *
 * Every reference of the canonical pool is described offline by a 128-d vector: MobileNet v2 α0.5
 * embedding (1280) + the fast layout/colour descriptor (236), projected by a *learned whitening*
 * trained on simulated camera crops (glare, blur, exposure, misalignment) so that camera effects are
 * ignored and card-specific detail is kept (held-out hard crops: top-1 96 % vs 30 % for the raw
 * embedding). A scan is then one model pass on the camera crop + one projection + 40 616 int8 dot
 * products — no reference image is downloaded at scan time.
 *
 * Artwork twins (Japanese version, reprints, promos sharing the illustration) are identified on the
 * fly: the instant-lock margin is measured against the best NON-twin family, and a candidate with
 * twins needs printed evidence (language, number) to pick the printing.
 */
import { versionedFetch } from './indexVersion.js';

export const DEEP_SCHEMA = 'tcg-lens-deep-index-v1';

export class DeepIndex {
  constructor({ base = '/data', fetchImpl = null } = {}) {
    this.base = base; this.fetchImpl = fetchImpl || versionedFetch(base);
    this.meta = null; this.mean = null; this.M = null;
    this.langs = new Map();          // lang -> { vec: Int8Array, n, fam: Int32Array }
    this.famIds = []; this.famIndex = new Map(); this.famLangs = []; this.famRows = [];
    this.twinCache = new Map(); this.loading = new Map();
  }

  isLoaded(lang) { return this.langs.has(lang); }

  async _gz(path) {
    const res = await this.fetchImpl(`${this.base}/${path}`);
    if (!res.ok) throw new Error(`${path} unavailable`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer;
    if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream unavailable');
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  async loadModel() {
    if (this.meta) return;
    if (!this.loading.has('model')) this.loading.set('model', (async () => {
      const res = await this.fetchImpl(`${this.base}/deep-index.json`);
      if (!res.ok) throw new Error('deep index unavailable');
      const meta = await res.json();
      if (meta.schema !== DEEP_SCHEMA) throw new Error(`unexpected deep index schema ${meta.schema}`);
      const f = new Float32Array(await this._gz('deep-model.bin.gz'));
      if (f.length !== meta.inDims * (1 + meta.dims)) throw new Error('deep model size mismatch');
      this.mean = f.subarray(0, meta.inDims); this.M = f.subarray(meta.inDims);
      this.meta = meta;
    })());
    return this.loading.get('model');
  }

  /**
   * @param {string} lang
   * @param {{ count: number, rows: any[], col: Record<string, number> }} metaRows visual-index metadata (PrecomputedIndex)
   */
  async loadLang(lang, metaRows) {
    if (this.langs.has(lang)) return;
    if (!this.loading.has(lang)) this.loading.set(lang, (async () => {
      await this.loadModel();
      const vec = new Int8Array(await this._gz(`deep-index-${lang}.bin.gz`));
      const n = metaRows.count, D = this.meta.dims;
      if (vec.length !== n * D) throw new Error(`deep index ${lang} size mismatch`);
      const fam = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const id = metaRows.rows[i][metaRows.col.id];
        let f = this.famIndex.get(id);
        if (f == null) { f = this.famIds.length; this.famIds.push(id); this.famIndex.set(id, f); this.famLangs.push([]); this.famRows.push([]); }
        fam[i] = f;
        if (!this.famLangs[f].includes(lang)) this.famLangs[f].push(lang);
        this.famRows[f].push([lang, i]);
      }
      this.langs.set(lang, { vec, n, fam });
      this.twinCache.clear();
    })());
    return this.loading.get(lang);
  }

  /** Camera crop descriptors → normalized 128-d query (same recipe as the offline index). */
  project(deep, fast) {
    const m = this.meta, w = Math.sqrt(m.fastWeight), wd = Math.sqrt(1 - m.fastWeight);
    const x = new Float32Array(m.inDims);
    const nd = norm(deep), nf = norm(fast);
    for (let i = 0; i < m.deepDims; i++) x[i] = deep[i] / nd * wd - this.mean[i];
    for (let i = 0; i < m.fastDims; i++) x[m.deepDims + i] = fast[i] / nf * w - this.mean[m.deepDims + i];
    const D = m.dims, q = new Float32Array(D);
    for (let i = 0; i < m.inDims; i++) { const xi = x[i]; if (!xi) continue; const off = i * D; for (let d = 0; d < D; d++) q[d] += xi * this.M[off + d]; }
    const nq = norm(q); for (let d = 0; d < D; d++) q[d] /= nq;
    return q;
  }

  /** Best score per family over the given languages. */
  familyScores(q, langs) {
    const D = this.meta.dims, best = new Float32Array(this.famIds.length).fill(-9);
    for (const lang of langs) {
      const L = this.langs.get(lang); if (!L) continue;
      const { vec, n, fam } = L;
      for (let i = 0, off = 0; i < n; i++, off += D) {
        let s = 0; for (let d = 0; d < D; d++) s += q[d] * vec[off + d];
        s /= 127; const f = fam[i]; if (s > best[f]) best[f] = s;
      }
    }
    return best;
  }

  /** Top-k families: [{ id, family, score, languages }]. */
  search(q, langs, k = 30) {
    const best = this.familyScores(q, langs);
    const top = [];
    for (let f = 0; f < best.length; f++) {
      const s = best[f]; if (s <= -9) continue;
      if (top.length < k) { top.push([f, s]); if (top.length === k) top.sort((a, b) => b[1] - a[1]); continue; }
      if (s > top[k - 1][1]) { top[k - 1] = [f, s]; for (let j = k - 1; j > 0 && top[j][1] > top[j - 1][1]; j--) [top[j], top[j - 1]] = [top[j - 1], top[j]]; }
    }
    if (top.length < k) top.sort((a, b) => b[1] - a[1]);
    return top.map(([f, score]) => ({ id: this.famIds[f], family: f, score, languages: this.famLangs[f].filter(l => langs.includes(l)) }));
  }

  /** Families whose references are near-identical to this family's (shared artwork). Cached. */
  twins(family, langs, tau = this.meta?.calibration?.twinTau ?? 0.8) {
    const key = `${family}|${langs.join(',')}`;
    if (this.twinCache.has(key)) return this.twinCache.get(key);
    const D = this.meta.dims, acc = new Float32Array(this.famIds.length).fill(-9);
    for (const [lang, row] of this.famRows[family]) {
      const L = this.langs.get(lang); if (!L) continue;
      const q = new Float32Array(D); for (let d = 0; d < D; d++) q[d] = L.vec[row * D + d] / 127;
      const s = this.familyScores(q, langs);
      for (let f = 0; f < s.length; f++) if (s[f] > acc[f]) acc[f] = s[f];
    }
    acc[family] = -9;
    const out = [];
    for (let f = 0; f < acc.length; f++) if (acc[f] >= tau) out.push({ id: this.famIds[f], family: f, similarity: acc[f], languages: this.famLangs[f] });
    this.twinCache.set(key, out);
    return out;
  }
}

function norm(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s) || 1; }
