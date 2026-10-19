export class OCRAdapter {
  constructor() {
    this.worker = null;
    this.workerLang = null;
    this.workerPromise = null;
  }

  async ensureWorker(lang) {
    const tessLang = lang === 'ja' ? 'jpn' : lang === 'fr' ? 'fra' : 'eng';
    if (this.worker && this.workerLang === tessLang) return this.worker;
    if (this.workerPromise) return this.workerPromise;
    this.workerPromise = (async () => {
      await this._loadTesseract();
      if (!window.Tesseract?.createWorker) return null;
      if (this.worker) { try { await this.worker.terminate(); } catch {} }
      this.worker = await window.Tesseract.createWorker(tessLang, 1, { logger: () => {} });
      this.workerLang = tessLang;
      return this.worker;
    })();
    try { return await this.workerPromise; } finally { this.workerPromise = null; }
  }

  async analyze(rectifiedCanvas, lang, visualCandidates = []) {
    const worker = await this.ensureWorker(lang); if (!worker) return { available: false };
    const top = this._zone(rectifiedCanvas, 0, 0, 1, 0.32, 900, 250);
    const bottom = this._zone(rectifiedCanvas, 0, 0.69, 1, 0.31, 900, 250);
    const topResult = await worker.recognize(top);
    const bottomResult = await worker.recognize(bottom);
    const topText = (topResult.data?.text || '').replace(/\s+/g, ' ').trim();
    const bottomText = (bottomResult.data?.text || '').replace(/\s+/g, ' ').trim();
    const parsed = this.parse(`${topText} ${bottomText}`);
    const candidates = await this.resolveCandidates(parsed, lang, visualCandidates);
    const best = candidates[0] || null;
    return {
      available: true, text: `${topText} ${bottomText}`.trim(), parsed, candidates,
      candidateId: best?.id || null,
      collectorExact: Boolean(best?.collectorExact),
      strongNameMatch: Boolean(best?.nameScore >= 0.72),
      contradiction: Boolean(best?.contradiction),
    };
  }

  parse(text) {
    const numberMatches = text.match(/(?:^|\s)([A-Z]{0,4}\s*\d{1,4})(?:\s*\/\s*\d{1,4})?(?=\s|$)/gi) || [];
    const collector = (numberMatches.map(x => x.trim()).find(x => /\d/.test(x)) || '').replace(/\/.*$/, '').replace(/\s+/g, '');
    const words = text.split(/[^\p{L}\p{N}-]+/u).filter(w => w.length >= 4 && !/^\d+$/.test(w));
    return { collector, words, text };
  }

  async resolveCandidates(parsed, lang, visualCandidates) {
    let pool = [];
    if (parsed.collector) {
      try { const r = await fetch(`/api/cards?lang=${lang}&localId=${encodeURIComponent(parsed.collector)}`); if (r.ok) pool = (await r.json()).items || []; } catch {}
    }
    if (!pool.length && parsed.words.length) {
      for (const word of [...parsed.words].sort((a, b) => b.length - a.length).slice(0, 3)) {
        try { const r = await fetch(`/api/cards?lang=${lang}&q=${encodeURIComponent(word)}`); if (r.ok) { pool = (await r.json()).items || []; if (pool.length) break; } } catch {}
      }
    }
    const visualIds = new Set(visualCandidates.map(x => x.id));
    const text = parsed.text.toLowerCase();
    const ranked = pool.map(card => {
      const name = String(card.name || '').toLowerCase();
      const collectorExact = Boolean(parsed.collector && String(card.localId || '').toLowerCase() === parsed.collector.toLowerCase());
      const nameScore = tokenScore(name, parsed.words, text);
      const visualSupport = visualIds.has(card.id);
      return { ...card, collectorExact, nameScore, visualSupport, score: (collectorExact ? 0.55 : 0) + nameScore * 0.25 + (visualSupport ? 0.20 : 0) };
    }).sort((a, b) => b.score - a.score);
    const visualTop = visualCandidates[0]?.id;
    if (visualTop) {
      const corroborated = ranked.find(x => x.id === visualTop && (x.collectorExact || x.nameScore >= 0.72));
      if (corroborated) return [corroborated, ...ranked.filter(x => x.id !== visualTop)];
      const strongOther = ranked.find(x => x.id !== visualTop && x.collectorExact && x.nameScore >= 0.55);
      if (strongOther) strongOther.contradiction = true;
    }
    return ranked;
  }

  _zone(canvas, x, y, w, h, outW, outH) {
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH); ctx.filter = 'grayscale(1) contrast(1.55)';
    ctx.drawImage(canvas, canvas.width * x, canvas.height * y, canvas.width * w, canvas.height * h, 0, 0, outW, outH); ctx.filter = 'none'; return c;
  }

  async _loadTesseract() {
    if (window.Tesseract) return;
    await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.async = true; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
  }
}

function tokenScore(name, words, fullText) {
  if (!name) return 0;
  const useful = words.map(x => x.toLowerCase()).filter(x => x.length >= 4);
  if (!useful.length) return fullText.includes(name) ? 1 : 0;
  const hit = useful.reduce((n, word) => n + (name.includes(word) ? Math.min(1, word.length / Math.max(4, name.length)) : 0), 0);
  return Math.min(1, hit + (fullText.includes(name) ? 0.5 : 0));
}
