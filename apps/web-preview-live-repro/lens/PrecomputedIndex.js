/**
 * Precomputed on-device visual index (built by tools/build-visual-index.mjs).
 *
 * All reference descriptors of the canonical candidate pool are downloaded once (Int8, ~7 MB
 * compressed for FR+EN+JA) instead of being computed image by image on the phone. Candidates are
 * grouped by printing family (TCGdex card id): the FR and EN printings of the same card share the
 * artwork, so they must not compete for top-1/top-2 margin. The language of the physical card is
 * resolved separately from printed text (see LanguageEvidence) and is never guessed.
 */
import { versionedFetch } from './indexVersion.js';

export const INDEX_SCHEMA = 'tcg-lens-visual-index-v1';
export const INDEX_LANGS = Object.freeze(['fr', 'en', 'ja']);

export class PrecomputedIndex {
  constructor({ base = '/data', fetchImpl = null } = {}) {
    this.base = base;
    this.fetchImpl = fetchImpl || versionedFetch(base);
    this.langs = new Map();      // lang -> { meta, vec: Int8Array, dims }
    this.families = new Map();   // id -> Map(lang -> row)
    this.loading = new Map();
  }

  isLoaded(lang) { return Boolean(this.langs.get(lang)?.vec); }
  hasMeta(lang) { return this.langs.has(lang); }
  metaRows(lang) { const L = this.langs.get(lang); return L ? { count: L.meta.count, rows: L.meta.rows, col: L.col } : null; }
  count(langs = INDEX_LANGS) { let n = 0; for (const l of langs) n += this.langs.get(l)?.meta.count ?? 0; return n; }

  /**
   * Loads the given languages in parallel. onProgress({ loaded, total }) counts references.
   * `vectors: false` loads metadata only (v0.3.5: the calibrated DeepIndex replaces the per-reference
   * fast vectors at scan time).
   */
  async load(langs = INDEX_LANGS, onProgress = () => {}, { vectors = true } = {}) {
    const pending = langs.filter(l => !this.langs.has(l) || (vectors && !this.langs.get(l).vec));
    await Promise.all(pending.map(lang => {
      const key = `${lang}:${vectors ? 'v' : 'm'}`;
      if (!this.loading.has(key)) this.loading.set(key, this._loadLang(lang, vectors).finally(() => onProgress({ loaded: this.count(langs), lang })));
      return this.loading.get(key);
    }));
    return this.count(langs);
  }

  async _loadLang(lang, vectors = true) {
    const [metaRes, buffer] = await Promise.all([
      this.langs.has(lang) ? null : this.fetchImpl(`${this.base}/visual-index-${lang}.json`),
      vectors ? this._fetchVectors(lang) : null,
    ]);
    if (!metaRes) { // metadata already loaded: only attach the vectors
      const L = this.langs.get(lang); const vec = new Int8Array(buffer);
      if (vec.length !== L.meta.count * L.meta.dims) throw new Error(`visual index ${lang} size mismatch`);
      L.vec = vec; return;
    }
    if (!metaRes.ok) throw new Error(`visual index ${lang} unavailable`);
    const meta = await metaRes.json();
    if (meta.schema !== INDEX_SCHEMA) throw new Error(`unexpected index schema ${meta.schema}`);
    const vec = buffer ? new Int8Array(buffer) : null;
    if (vec && vec.length !== meta.count * meta.dims) throw new Error(`visual index ${lang} size mismatch`);
    const col = Object.fromEntries(meta.columns.map((c, i) => [c, i]));
    this.langs.set(lang, { meta, vec, dims: meta.dims, col });
    meta.rows.forEach((row, i) => {
      const id = row[col.id];
      if (!this.families.has(id)) this.families.set(id, new Map());
      this.families.get(id).set(lang, i);
    });
  }

  /**
   * Descriptors ship gzip-compressed (~45 % smaller; static hosts rarely compress binary types) and
   * are inflated with DecompressionStream. If the host already decoded it, or the browser lacks
   * DecompressionStream, the raw file is used.
   */
  async _fetchVectors(lang) {
    if (typeof DecompressionStream === 'function') {
      try {
        const res = await this.fetchImpl(`${this.base}/visual-index-${lang}.bin.gz`);
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer; // already decoded by the host
          return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        }
      } catch {}
    }
    const raw = await this.fetchImpl(`${this.base}/visual-index-${lang}.bin`);
    if (!raw.ok) throw new Error(`visual index ${lang} unavailable`);
    return raw.arrayBuffer();
  }

  /** Metadata of one reference row as a candidate-shaped object. */
  row(lang, i) {
    const L = this.langs.get(lang); const r = L.meta.rows[i]; const c = L.col;
    return {
      id: r[c.id], lang, name: r[c.name], localId: r[c.localId], printedTotal: r[c.printedTotal], setId: r[c.setId],
      setName: r[c.setName], setAbbreviation: r[c.setAbbreviation], releaseDate: r[c.releaseDate],
      image: /^https?:/.test(r[c.imagePath]) ? r[c.imagePath] : `${L.meta.imageBase}${r[c.imagePath]}`, printedNumber: c.printedNumber != null ? r[c.printedNumber] || null : null, visualOnlyLockAllowed: r[c.visualOnlyLockAllowed] === 1,
      lockBlockedReason: r[c.lockBlockedReason] || null, entityId: r[c.entityId],
    };
  }

  /** Languages in which a printing family exists, restricted to `langs`. */
  familyLanguages(id, langs = INDEX_LANGS) {
    const fam = this.families.get(id); if (!fam) return [];
    return langs.filter(l => fam.has(l));
  }

  /**
   * Best `n` printing families by fast-descriptor cosine. One entry per family (its best-scoring
   * language row), so identical artwork in several languages never splits the margin.
   */
  fastTop(query, langs = INDEX_LANGS, n = 24) {
    const best = new Map();
    for (const lang of langs) {
      const L = this.langs.get(lang); if (!L?.vec) continue;
      const { vec, dims, meta, col } = L;
      for (let i = 0, off = 0; i < meta.count; i++, off += dims) {
        let s = 0;
        for (let t = 0; t < dims; t++) s += query[t] * vec[off + t];
        s /= 127;
        const id = meta.rows[i][col.id];
        const prev = best.get(id);
        if (!prev || s > prev.fast) best.set(id, { id, lang, row: i, fast: s });
      }
    }
    return [...best.values()].sort((a, b) => b.fast - a.fast).slice(0, n);
  }

  /** Candidate object for a family hit, with per-language metadata for later language resolution. */
  familyCandidate(hit, langs = INDEX_LANGS) {
    const languages = this.familyLanguages(hit.id, langs);
    const byLang = {};
    for (const l of languages) byLang[l] = this.row(l, this.families.get(hit.id).get(l));
    const primary = byLang[hit.lang];
    return {
      ...primary,
      languages,
      byLang,
      // Conservative until the physical language is proven: every language must allow it.
      visualOnlyLockAllowed: languages.every(l => byLang[l].visualOnlyLockAllowed),
      lockBlockedReason: languages.map(l => byLang[l].lockBlockedReason).find(Boolean) || null,
    };
  }
}
