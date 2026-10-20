import { cosine } from './VisualEmbeddingAdapter.js';

export class ANNIndex {
  constructor({ maxRefs = 1200 } = {}) {
    this.maxRefs = maxRefs;
    this.refs = new Map();
    this.db = null;
    this.loading = null;
    this.warming = false;
    this.cursor = new Map();
    this.poolTotal = new Map();
  }

  /** Number of refs the bounded on-device index aims to hold for a language. */
  target(lang) { const total = this.poolTotal.get(lang); return total == null ? this.maxRefs : Math.min(this.maxRefs, total); }

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

  count(lang) { let n = 0; for (const r of this.refs.values()) if (r.lang === lang) n++; return n; }

  async put(row) {
    this.refs.set(row.key, row);
    const db = await this.open(); if (!db) return;
    await new Promise(resolve => { const tx = db.transaction('refs', 'readwrite'); tx.objectStore('refs').put(row); tx.oncomplete = resolve; tx.onerror = resolve; });
  }

  fastTopK(vector, lang, k = 12) {
    const top = [];
    for (const ref of this.refs.values()) {
      if (ref.lang !== lang || !ref.fast) continue;
      const score = cosine(vector, ref.fast);
      top.push({ ref, fastScore: score }); top.sort((a, b) => b.fastScore - a.fastScore); if (top.length > k) top.pop();
    }
    return top;
  }

  async query(canvas, lang, embedding, k = 6) {
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

  async warm(lang, embedding, { batch = 18, signal = null, concurrency = 6 } = {}) {
    if (this.warming || this.count(lang) >= this.maxRefs) return;
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
