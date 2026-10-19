import { cosine } from './VisualEmbeddingAdapter.js';

export class ANNIndex {
  constructor({ maxRefs = 1200 } = {}) {
    this.maxRefs = maxRefs;
    this.refs = new Map();
    this.db = null;
    this.loading = null;
    this.warming = false;
    this.cursor = new Map();
  }

  async open() {
    if (this.db || !('indexedDB' in window)) return this.db;
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

  async warm(lang, embedding, { batch = 18, signal = null } = {}) {
    if (this.warming || this.count(lang) >= this.maxRefs) return;
    this.warming = true;
    try {
      await this.load(lang);
      let cursor = this.cursor.get(lang) || '0';
      const params = new URLSearchParams({ lang, cursor, size: String(Math.max(batch, 24)) });
      const response = await fetch(`/api/visual-cards?${params}`); if (!response.ok) return;
      const payload = await response.json();
      const items = (payload.items || []).filter(x => x.image).slice(0, batch);
      for (const card of items) {
        if (signal?.aborted) break;
        const key = `${lang}:${card.id}`; if (this.refs.has(key)) continue;
        try {
          const image = await embedding.imageCanvas(card.image);
          const fast = Array.from(embedding.fastDescriptor(image));
          let deep = null;
          if (embedding.model) deep = Array.from(await embedding.embed(image));
          await this.put({
            key, id: card.id, entityId: card.entityId || null, name: card.name, localId: String(card.localId || ''), lang,
            setId: card.setId || null, setName: card.setName || null, setAbbreviation: card.setAbbreviation || null,
            printedTotal: card.printedTotal ?? null, setReadiness: card.setReadiness || null,
            visualOnlyLockAllowed: card.visualOnlyLockAllowed === true, poolBuildId: payload.buildId || null,
            image: card.image, fast, deep, at: Date.now(),
          });
        } catch {}
      }
      if (payload.exhausted) cursor = '0'; else cursor = payload.nextCursor || cursor;
      this.cursor.set(lang, cursor); await this._metaSet(`cursor:${lang}`, cursor);
    } finally { this.warming = false; }
  }

  async _metaGet(key) { const db = await this.open(); if (!db) return null; return new Promise(resolve => { const tx = db.transaction('meta', 'readonly'); const r = tx.objectStore('meta').get(key); r.onsuccess = () => resolve(r.result?.value ?? null); r.onerror = () => resolve(null); }); }
  async _metaSet(key, value) { const db = await this.open(); if (!db) return; await new Promise(resolve => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); tx.oncomplete = resolve; tx.onerror = resolve; }); }
}
