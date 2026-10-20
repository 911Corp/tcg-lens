import { corroborateCandidate, parseCollectorText } from './MetadataCorroboration.js';

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
    const parsed = this.parse(`${topText} ${bottomText}`, bottomText);
    const lookupItems = await this.lookupCanonical(parsed, lang);
    const candidates = await this.resolveCandidates(parsed, lang, visualCandidates, lookupItems);
    const best = candidates[0] || null;
    return {
      available: true, text: `${topText} ${bottomText}`.trim(), parsed, candidates,
      candidateId: best?.id || null,
      collectorExact: Boolean(best?.collectorExact),
      strongNameMatch: Boolean(best?.nameScore >= 0.72),
      printingSupport: Boolean(best?.collectorExact),
      conceptSupport: Boolean(best?.nameScore >= 0.72),
      contradiction: Boolean(best?.contradiction),
      // Printed-metadata contradictions are only made hard by OCRConsensus after repeated identical reads.
      contradictionKind: best?.contradiction ? (best.contradictionReasons ? 'printed_metadata' : 'exact_other_candidate') : null,
      contradictionSignature: best?.contradictionReasons ? `${parsed.collector}/${parsed.printedTotal ?? ''}` : null,
      // Canonical printings matching number + printed total; used for targeted index warming only.
      lookupItems: parsed.printedTotal ? lookupItems : [],
    };
  }

  parse(text, collectorText = text) {
    // v0.3.1: keep the printed total ("199/165") and set code; a bare local number is weak evidence.
    const printed = parseCollectorText(collectorText);
    const fallback = printed.number ? printed : parseCollectorText(text);
    const words = text.split(/[^\p{L}\p{N}-]+/u).filter(w => w.length >= 4 && !/^\d+$/.test(w));
    return { collector: fallback.number || '', printedTotal: fallback.printedTotal, setCode: fallback.setCode, words, text };
  }

  async lookupCanonical(parsed, lang) {
    // Canonical-pool lookup (never live TCGdex): number + printed total narrows to real printings.
    if (!parsed.collector) return [];
    const params = new URLSearchParams({ lang, number: parsed.collector });
    if (parsed.printedTotal) params.set('total', String(parsed.printedTotal));
    try { const r = await fetch(`/api/candidate-lookup?${params}`); if (r.ok) return (await r.json()).items || []; } catch {}
    return [];
  }

  async resolveCandidates(parsed, lang, visualCandidates, lookupItems = undefined) {
    const pool = lookupItems ?? await this.lookupCanonical(parsed, lang);
    // Visual top-K candidates carry their canonical metadata; always evaluate them directly.
    const byId = new Map();
    for (const card of [...visualCandidates, ...pool]) if (card?.id && !byId.has(card.id)) byId.set(card.id, card);
    const visualIds = new Set(visualCandidates.map(x => x.id));
    const text = parsed.text.toLowerCase();
    const ranked = [...byId.values()].map(card => {
      const meta = corroborateCandidate(card, { number: parsed.collector || null, printedTotal: parsed.printedTotal ?? null, setCode: parsed.setCode ?? null });
      const name = String(card.name || '').toLowerCase();
      const nameScore = tokenScore(name, parsed.words, text);
      const visualSupport = visualIds.has(card.id);
      return { ...card, meta, collectorExact: meta.printingSupport, numberOnly: meta.numberOnly, nameScore, visualSupport,
        score: (meta.printingSupport ? 0.55 : 0) + nameScore * 0.25 + (visualSupport ? 0.20 : 0) };
    }).sort((a, b) => b.score - a.score);
    const visualTop = visualCandidates[0]?.id;
    if (visualTop) {
      const top = ranked.find(x => x.id === visualTop);
      if (top?.meta?.contradicts) {
        // Physical contradiction between the printed number/total and the visual top's canonical record.
        top.contradiction = true;
        top.contradictionReasons = top.meta.reasons;
        return [top, ...ranked.filter(x => x.id !== visualTop)];
      }
      const corroborated = top && (top.collectorExact || top.nameScore >= 0.72) ? top : null;
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
