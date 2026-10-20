import { cosine } from './VisualEmbeddingAdapter.js';
import { PrecomputedIndex, INDEX_LANGS } from './PrecomputedIndex.js';
import { DeepIndex } from './DeepIndex.js';

/** 'auto' scans every language; otherwise a single language scope. */
export function scopeLangs(lang) { return lang === 'auto' || !lang ? [...INDEX_LANGS] : [lang]; }

export class ANNIndex {
  constructor({ maxRefs = 1200, precomputed = null, deep = undefined, prefilter = 24, rerank = 8 } = {}) {
    this.maxRefs = maxRefs;
    this.pre = precomputed || new PrecomputedIndex();
    // v0.3.5 calibrated instant index (null disables it, e.g. in Node tests).
    this.deep = deep === undefined ? (typeof window !== 'undefined' ? new DeepIndex() : null) : deep;
    this.prefilter = prefilter;
    this.rerank = rerank;
    this.deepCache = new Map();
    this.deepInFlight = new Map();
    this.refs = new Map();
    this.db = null;
    this.loading = null;
    this.warming = false;
    this.cursor = new Map();
    this.poolTotal = new Map();
  }

  /** Number of refs the on-device index aims to hold for a language scope. */
  target(lang) {
    if (this.preTarget) return this.preTarget;
    const total = this.poolTotal.get(lang); return total == null ? this.maxRefs : Math.min(this.maxRefs, total);
  }

  /** Loads the precomputed index (all languages for 'auto'). Returns false if unavailable. */
  async loadPrecomputed(lang, onProgress = () => {}) {
    const langs = scopeLangs(lang);
    this.preTarget = null;
    // v0.3.5: calibrated deep index first (metadata + 128-d int8 vectors, no reference download).
    if (this.deep) {
      try {
        await this.pre.load(langs, p => onProgress({ loaded: p.loaded, langs }), { vectors: false });
        await Promise.all(langs.map(l => this.deep.loadLang(l, this.pre.metaRows(l))));
        this.preTarget = this.pre.count(langs);
        return true;
      } catch (error) { this.deepError = String(error?.message || error); }
    }
    try {
      // Expected totals are known only after load; report progress per language file.
      await this.pre.load(langs, p => onProgress({ loaded: p.loaded, langs }));
      this.preTarget = this.pre.count(langs);
      return true;
    } catch (error) {
      this.preError = String(error?.message || error);
      return false;
    }
  }

  usesPrecomputed(lang) { return this.usesDeep(lang) || scopeLangs(lang).every(l => this.pre.isLoaded(l)); }
  usesDeep(lang) { return Boolean(this.deep) && scopeLangs(lang).every(l => this.deep.isLoaded(l) && this.pre.hasMeta(l)); }

  async open() {
    if (this.db || typeof window === 'undefined' || !('indexedDB' in window)) return this.db;
    this.db = await new Promise(resolve => {
      const req = indexedDB.open('tcg-lens-ann-v3', 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('refs')) db.createObjectStore('refs', { keyPath: 'key' }); if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null);
    });
    return this.db;
  }

  async load(lang) {
    if (this.loading) await this.loading;
    this.loading = (async () => {
      const db = await this.open(); if (!db) return;
      const rows = await new Promise(resolve => { const tx = db.transaction('refs', 'readonly'); const r = tx.objectStore('refs').getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]); });
      for (const row of rows) if (row.lang === lang) this.refs.set(row.key, row);
      const cursor = await this._metaGet(`cursor:${lang}`); if (cursor) this.cursor.set(lang, cursor);
    })();
    await this.loading; this.loading = null;
  }

  count(lang) {
    if (this.usesDeep(lang) || this.usesPrecomputed(lang)) return this.pre.count(scopeLangs(lang));
    const langs = scopeLangs(lang); let n = 0; for (const r of this.refs.values()) if (langs.includes(r.lang)) n++; return n;
  }

  async put(row) {
    this.refs.set(row.key, row);
    const db = await this.open(); if (!db) return;
    await new Promise(resolve => { const tx = db.transaction('refs', 'readwrite'); tx.objectStore('refs').put(row); tx.oncomplete = resolve; tx.onerror = resolve; });
  }

  fastTopK(vector, lang, k = 12) {
    const top = [];
    const langs = scopeLangs(lang);
    for (const ref of this.refs.values()) {
      if (!langs.includes(ref.lang) || !ref.fast) continue;
      const score = cosine(vector, ref.fast);
      top.push({ ref, fastScore: score }); top.sort((a, b) => b.fastScore - a.fastScore); if (top.length > k) top.pop();
    }
    return top;
  }

  async query(canvas, lang, embedding, k = 6, opts = {}) {
    if (this.usesDeep(lang)) return this._queryDeep(canvas, lang, embedding, k, opts);
    if (this.usesPrecomputed(lang)) return this._queryPrecomputed(canvas, lang, embedding, k);
    if (!this.count(lang)) return [];
    const fastVector = embedding.fastDescriptor(canvas);
    const pre = this.fastTopK(fastVector, lang, Math.max(k * 2, 10));
    if (!pre.length) return [];
    const deepReady = await embedding.ensureModel();
    if (!deepReady) return pre.slice(0, k).map(x => ({ ...x.ref, score: x.fastScore, marginSource: 'prefilter', embeddingVerified: false }));
    const queryDeep = await embedding.embed(canvas);
    for (const hit of pre.slice(0, Math.max(k, 4))) {
      if (!hit.ref.deep && hit.ref.image) {
        try {
          const refCanvas = await embedding.imageCanvas(hit.ref.image);
          hit.ref.deep = Array.from(await embedding.embed(refCanvas));
          await this.put(hit.ref);
        } catch {}
      }
      hit.deepScore = hit.ref.deep ? cosine(queryDeep, hit.ref.deep) : null;
      hit.score = hit.deepScore == null ? hit.fastScore * 0.82 : hit.deepScore * 0.82 + hit.fastScore * 0.18;
    }
    pre.sort((a, b) => (b.score ?? b.fastScore) - (a.score ?? a.fastScore));
    return pre.slice(0, k).map(x => ({ ...x.ref, score: x.score ?? x.fastScore, fastScore: x.fastScore, deepScore: x.deepScore, embeddingVerified: x.deepScore != null }));
  }

  /**
   * Precomputed path: fast prefilter over every reference of the scope (one entry per printing
   * family), then deep re-scoring of the best `rerank` families in parallel. Only deep-verified
   * hits are returned when the model is available, so scores share one scale.
   */
  async _queryPrecomputed(canvas, lang, embedding, k) {
    const langs = scopeLangs(lang);
    const pre = this.pre.fastTop(embedding.fastDescriptor(canvas), langs, Math.max(this.prefilter, k));
    if (!pre.length) return [];
    const deepReady = await embedding.ensureModel();
    if (!deepReady) return pre.slice(0, k).map(h => ({ ...this.pre.familyCandidate(h, langs), score: h.fast, fastScore: h.fast, embeddingVerified: false }));
    const top = pre.slice(0, Math.max(this.rerank, k));
    const [queryDeep] = await Promise.all([embedding.embed(canvas), this._deepBatch(top, embedding)]);
    for (const h of top) h.deep = this.deepCache.get(`${h.lang}:${h.id}`) || null;
    for (const h of top) {
      h.deepScore = h.deep ? cosine(queryDeep, h.deep) : null;
      h.score = h.deepScore == null ? h.fast * 0.82 : h.deepScore * 0.82 + h.fast * 0.18;
    }
    const verified = top.filter(h => h.deepScore != null).sort((a, b) => b.score - a.score);
    return verified.slice(0, k).map(h => ({ ...this.pre.familyCandidate(h, langs), score: h.score, fastScore: h.fast, deepScore: h.deepScore, embeddingVerified: true }));
  }

  /** Deep embeddings for the uncached hits, images loaded in parallel and embedded in one batch. */
  async _deepBatch(hits, embedding) {
    const missing = hits.filter(h => !this.deepCache.has(`${h.lang}:${h.id}`));
    if (!missing.length) return;
    if (typeof embedding.embedBatch !== 'function') { await Promise.all(missing.map(h => this._deepFor(h, embedding))); return; }
    const canvases = await Promise.all(missing.map(h => embedding.imageCanvas(this.pre.row(h.lang, h.row).image).catch(() => null)));
    const ok = missing.filter((_, i) => canvases[i]);
    if (!ok.length) return;
    try {
      const vecs = await embedding.embedBatch(canvases.filter(Boolean));
      ok.forEach((h, i) => { if (vecs[i]) this.deepCache.set(`${h.lang}:${h.id}`, vecs[i]); });
    } catch { await Promise.all(ok.map(h => this._deepFor(h, embedding))); }
  }

  /**
   * v0.3.5 instant path: one model pass on the crop, learned-whitening projection, scores against
   * every reference. Candidates carry their artwork twins and the margin to the best non-twin.
   */
  async _queryDeep(canvas, lang, embedding, k, { track = null } = {}) {
    const langs = scopeLangs(lang);
    const deep = await embedding.embed(canvas);
    if (!deep) return [];
    const q1 = this.deep.project(deep, embedding.fastDescriptor(canvas));
    // Average the last frames of the same track: glare and holo sheen move between frames.
    if (!track || this.qTrack !== track) { this.qTrack = track; this.qWindow = []; }
    this.qWindow.push(q1); if (this.qWindow.length > (this.queryWindow ?? 3)) this.qWindow.shift();
    const q = new Float32Array(q1.length);
    for (const v of this.qWindow) for (let d = 0; d < q.length; d++) q[d] += v[d];
    let nq = 0; for (let d = 0; d < q.length; d++) nq += q[d] * q[d]; nq = Math.sqrt(nq) || 1;
    for (let d = 0; d < q.length; d++) q[d] /= nq;
    const hits = this.deep.search(q, langs, 30);
    if (!hits.length) return [];
    const top = hits[0];
    const twins = this.deep.twins(top.family, langs);
    const twinIds = new Set(twins.map(t => t.id));
    const nonTwin = hits.find(h => h !== top && !twinIds.has(h.id));
    const out = hits.slice(0, Math.max(k, 1 + Math.min(twins.length, 6))).map(h => {
      const c = this.pre.familyCandidate({ id: h.id, lang: h.languages[0] }, langs);
      return { ...c, score: h.score, embeddingVerified: true, calibrated: true };
    });
    out[0].twins = twins.map(t => ({ id: t.id, languages: t.languages.filter(l => langs.includes(l)), similarity: t.similarity }));
    out[0].marginNonTwin = top.score - (nonTwin?.score ?? 0);
    // Scores of the twins (they are near the top) for language-based twin resolution.
    out[0].twinScores = Object.fromEntries(hits.filter(h => twinIds.has(h.id)).map(h => [h.id, h.score]));
    // Visual script evidence: gap between the top family and its best twin of the other script
    // (Japanese vs Latin printings of the same artwork).
    const scriptOf = ls => (ls.includes('ja') ? 'ja' : 'latin');
    const topScript = scriptOf(top.languages);
    const otherScript = hits.filter(h => twinIds.has(h.id) && scriptOf(h.languages) !== topScript);
    out[0].script = topScript;
    out[0].scriptGap = otherScript.length ? top.score - Math.max(...otherScript.map(h => h.score)) : null;
    return out;
  }

  async _deepFor(hit, embedding) {
    const key = `${hit.lang}:${hit.id}`;
    if (this.deepCache.has(key)) return this.deepCache.get(key);
    if (!this.deepInFlight.has(key)) {
      this.deepInFlight.set(key, (async () => {
        try {
          const image = this.pre.row(hit.lang, hit.row).image;
          const vec = await embedding.embed(await embedding.imageCanvas(image));
          if (vec) this.deepCache.set(key, vec);
          return vec || null;
        } catch { return null; } finally { this.deepInFlight.delete(key); }
      })());
    }
    return this.deepInFlight.get(key);
  }

  async warm(lang, embedding, { batch = 18, signal = null, concurrency = 6 } = {}) {
    if (this.usesPrecomputed(lang)) return; // the full index is already on the device
    if (this.warming || this.count(lang) >= this.maxRefs) return;
    if (lang === 'auto') lang = 'fr'; // legacy progressive warm is single-language
    this.warming = true;
    try {
      await this.load(lang);
      let cursor = this.cursor.get(lang) || '0';
      // v0.3.1 fix: request exactly the page we process. Previously 24 items were requested, 18 processed
      // and the cursor advanced by 24, so one reference in four was silently never indexed.
      const size = Math.max(8, batch);
      const params = new URLSearchParams({ lang, cursor, size: String(size) });
      const response = await fetch(`/api/visual-cards?${params}`); if (!response.ok) return;
      const payload = await response.json();
      if (Number.isFinite(payload.total)) this.poolTotal.set(lang, payload.total);
      const items = (payload.items || []).filter(x => x.image && !this.refs.has(`${lang}:${x.id}`));
      // Background warming stores the cheap prefilter descriptor only; the deep embedding is computed
      // lazily in query() for the few refs that reach final scoring (same scores, far faster warm-up).
      for (let i = 0; i < items.length && !signal?.aborted; i += concurrency) {
        const refs = await Promise.all(items.slice(i, i + concurrency).map(card =>
          this._refFromCard(card, lang, embedding, payload.buildId, { deep: false }).catch(() => null)));
        for (const ref of refs) if (ref) await this.put(ref);
      }
      if (payload.exhausted) cursor = '0'; else cursor = payload.nextCursor || cursor;
      this.cursor.set(lang, cursor); await this._metaSet(`cursor:${lang}`, cursor);
    } finally { this.warming = false; }
  }

  /**
   * v0.3.1 targeted warming: add canonical-pool printings matching a printed number + printed total
   * read by OCR, so the true card can be compared visually even when it is outside the bounded
   * newest-first warm window. Adds candidates only; locking rules are unchanged.
   */
  async warmTargeted(items, lang, embedding, { limit = 12 } = {}) {
    const added = [];
    for (const card of (items || []).filter(x => x?.id && x.image && x.lang === lang).slice(0, limit)) {
      const key = `${lang}:${card.id}`;
      if (this.refs.has(key)) continue;
      try { await this.put(await this._refFromCard(card, lang, embedding, card.poolBuildId || null)); added.push(card.id); } catch {}
    }
    return added;
  }

  async _refFromCard(card, lang, embedding, buildId, { deep: withDeep = true } = {}) {
    const image = await embedding.imageCanvas(card.image);
    const fast = Array.from(embedding.fastDescriptor(image));
    let deep = null;
    if (withDeep && embedding.model) deep = Array.from(await embedding.embed(image));
    return {
      key: `${lang}:${card.id}`, id: card.id, entityId: card.entityId || null, name: card.name, localId: String(card.localId || ''), lang,
      setId: card.setId || null, setName: card.setName || null, setAbbreviation: card.setAbbreviation || null,
      printedTotal: card.printedTotal ?? null, setReadiness: card.setReadiness || null,
      visualOnlyLockAllowed: card.visualOnlyLockAllowed === true, lockBlockedReason: card.lockBlockedReason || null,
      artworkTwins: card.artworkTwins ?? 0, poolBuildId: buildId || null,
      image: card.image, fast, deep, at: Date.now(),
    };
  }

  async _metaGet(key) { const db = await this.open(); if (!db) return null; return new Promise(resolve => { const tx = db.transaction('meta', 'readonly'); const r = tx.objectStore('meta').get(key); r.onsuccess = () => resolve(r.result?.value ?? null); r.onerror = () => resolve(null); }); }
  async _metaSet(key, value) { const db = await this.open(); if (!db) return; await new Promise(resolve => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); tx.oncomplete = resolve; tx.onerror = resolve; }); }
}
