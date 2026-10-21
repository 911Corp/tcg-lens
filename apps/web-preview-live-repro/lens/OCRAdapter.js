import { corroborateCandidate, parseCollectorText } from './MetadataCorroboration.js';

export class OCRAdapter {
  constructor() {
    this.workers = new Map();   // tesseract language -> Promise<worker|null>
  }

  /** One persistent worker per Tesseract language (each runs in its own thread). */
  ensureWorker(lang) {
    if (lang === 'digits') return this._digitsWorker();
    const tessLang = lang === 'ja' ? 'jpn' : lang === 'fr' ? 'fra' : 'eng';
    if (!this.workers.has(tessLang)) {
      this.workers.set(tessLang, (async () => {
        await this._loadTesseract();
        if (!window.Tesseract?.createWorker) return null;
        return window.Tesseract.createWorker(tessLang, 1, { logger: () => {} });
      })().catch(() => { this.workers.delete(tessLang); return null; }));
    }
    return this.workers.get(tessLang);
  }

  /** v0.4.4: start the readers ahead of the first card (each runs one tiny recognition to finish loading). */
  async warm(lang = 'auto') {
    const auto = lang === 'auto';
    const blank = document.createElement('canvas'); blank.width = 64; blank.height = 24;
    const g = blank.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 24);
    const ws = await Promise.all([this.ensureWorker(auto ? 'en' : lang), this._digitsWorker(), auto ? this.ensureWorker('ja') : null]);
    for (const w of ws) if (w) { try { await w.recognize(blank); } catch {} }
  }

  /** Separate reader restricted to digits and "/" (sparse text: the zone also holds the illustrator line): the printed collector number. */
  _digitsWorker() {
    if (!this.workers.has('digits')) {
      this.workers.set('digits', (async () => {
        await this._loadTesseract();
        if (!window.Tesseract?.createWorker) return null;
        const w = await window.Tesseract.createWorker('eng', 1, { logger: () => {} });
        await w.setParameters({ tessedit_char_whitelist: '0123456789/', tessedit_pageseg_mode: '11' });
        return w;
      })().catch(() => { this.workers.delete('digits'); return null; }));
    }
    return this.workers.get('digits');
  }

  /**
   * v0.3.3: the collector number ("001/084") is tiny; read it from the two bottom corners only,
   * enlarged, with the digits-only reader. Runs in parallel with the text readers.
   */
  async _numberRead(canvas) {
    try {
      const w = await this._digitsWorker(); if (!w) return '';
      const out = [];
      for (const [x, wid] of [[0, 0.5], [0.5, 0.5]]) {
        const z = this._zone(canvas, x, 0.9, wid, 0.1, 960, 192);
        const r = await w.recognize(z);
        out.push((r.data?.text || '').replace(/\s+/g, ''));
      }
      // Near-identical frames repeat the same misreading, so implausible numbers are dropped here
      // rather than left to the 2-identical-reads contradiction rule.
      return [...new Set(out.flatMap(collectorCandidates))].join(' ');
    } catch { return ''; }
  }

  /**
   * In auto mode the Latin reader ('eng': digits, PV/HP, names, rules text) and a Japanese reader on
   * the title zone run in parallel. Comparing what each reader recognises is the script evidence
   * used by LanguageEvidence to prove (or contradict) Japanese.
   */
  async analyze(rectifiedCanvas, lang, visualCandidates = []) {
    const auto = lang === 'auto';
    const worker = await this.ensureWorker(auto ? 'en' : lang); if (!worker) return { available: false };
    const top = this._zone(rectifiedCanvas, 0, 0, 1, 0.32, 900, 250);
    const bottom = this._zone(rectifiedCanvas, 0, 0.69, 1, 0.31, 900, 250);
    const jaPass = auto ? this._japaneseRead(top) : Promise.resolve(null);
    const numberPass = this._numberRead(rectifiedCanvas);
    const topResult = await worker.recognize(top);
    const bottomResult = await worker.recognize(bottom);
    const ja = await jaPass;
    const numberText = await numberPass;
    const topText = (topResult.data?.text || '').replace(/\s+/g, ' ').trim();
    const bottomText = (bottomResult.data?.text || '').replace(/\s+/g, ' ').trim();
    const script = auto ? {
      latinConf: Number(topResult.data?.confidence) || 0, jaConf: ja?.confidence ?? 0, jaText: ja?.text || '',
      latinStrong: strongLatinWords(topResult.data) + strongLatinWords(bottomResult.data), jaStrong: ja?.strong ?? 0, jaWords: ja?.words || [],
    } : null;
    // The digits-only read comes first: parseCollectorText takes the first "N/T" it finds.
    const parsed = this.parse(`${topText} ${bottomText}${script?.jaText ? ` ${script.jaText}` : ''}`, `${numberText} ${bottomText}`);
    const lookupItems = await this.lookupCanonical(parsed, lang);
    const candidates = await this.resolveCandidates(parsed, lang, visualCandidates, lookupItems);
    const best = candidates[0] || null;
    return {
      available: true, text: `${topText} ${bottomText}`.trim(), script, parsed, candidates,
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
      // A multi-language family is matched against each language's printed name.
      const names = card.byLang ? Object.values(card.byLang).map(x => x.name) : [card.name];
      const nameScore = Math.max(...names.map(n => tokenScore(String(n || '').toLowerCase(), parsed.words, text)));
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

  async _japaneseRead(canvas) {
    try {
      const w = await this.ensureWorker('ja'); if (!w) return null;
      const r = await w.recognize(canvas);
      const words = (r.data?.words || []).map(w => [w.text, Math.round(w.confidence)]);
      // Japanese characters inside words the Japanese model is confident about.
      const strong = words.filter(([t, c]) => c >= 75).reduce((n, [t]) => n + (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).filter(ch => ch !== 'ー').length, 0);
      return { text: (r.data?.text || '').replace(/\s+/g, ''), confidence: Number(r.data?.confidence) || 0, strong, words };
    } catch { return null; }
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

/**
 * v0.4.4: printed "number/total" candidates in a digits-only read. Tesseract glues neighbouring marks to the
 * number ("35036/12814730" for 036/128, "083/2172026/" with the regulation year): around every "/", the
 * numerator is the last 3 digits of the run before it (or the whole run when shorter: "4/102"), the total the
 * first 3 digits after it (2 when 3 is implausible). Only plausible pairs are kept.
 */
export function collectorCandidates(text) {
  const s = String(text || '').replace(/\s+/g, ''), out = [];
  const re = /(\d+)\/(\d+)/g; let m;
  while ((m = re.exec(s))) {
    const left = m[1], right = m[2];
    const num = left.length > 3 ? left.slice(-3) : left;
    for (const total of [right.slice(0, 3), right.slice(0, 2)]) {
      const cand = `${num}/${total}`;
      if (total.length >= 2 && plausibleCollector(cand)) { out.push(cand); break; }
    }
    re.lastIndex = m.index + m[1].length + 1; // overlapping: "071/21762026/" then the next "/"
  }
  return [...new Set(out)];
}

/** A digits-only read that looks like a real printed "number/total". */
export function plausibleCollector(text) {
  const m = String(text || '').match(/^(\d{1,4})\/(\d{2,4})$/);
  if (!m) return false;
  const n = Number(m[1]), t = Number(m[2]);
  return n >= 1 && t >= 10 && t <= 400 && n <= t + 150;
}

/** Latin words (3+ letters) the Latin model is confident about. */
function strongLatinWords(data) {
  return (data?.words || []).filter(w => w.confidence >= 80 && /^[A-Za-zÀ-ÿ'’-]{3,}$/.test(w.text)).length;
}

function tokenScore(name, words, fullText) {
  if (!name) return 0;
  const useful = words.map(x => x.toLowerCase()).filter(x => x.length >= 4);
  if (!useful.length) return fullText.includes(name) ? 1 : 0;
  const hit = useful.reduce((n, word) => n + (name.includes(word) ? Math.min(1, word.length / Math.max(4, name.length)) : 0), 0);
  return Math.min(1, hit + (fullText.includes(name) ? 0.5 : 0));
}
