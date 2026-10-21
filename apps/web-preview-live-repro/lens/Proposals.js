/**
 * v0.4.1 — proposals ("Est-ce cette carte ?") when no identification is confirmed.
 *
 * Never an identification: the user confirms by tapping. Three cumulative requirements, so that every
 * proposal strongly agrees with the scanned card:
 *   1. Calibrated probability (tools/deep/calibrate-proposals.py, held-out camera crops incl. cards missing
 *      from the catalogue): shown only when the top candidate has p ≥ show (0.6), then every candidate with
 *      p ≥ include (0.1), at most 3. Held-out: the right card is among the shown proposals 98 % of the time.
 *   2. Temporal consistency: a candidate must be proposed on ≥ 3 of the last 4 analysed frames of the same
 *      card (one lucky frame is not enough).
 *   3. Printed evidence: a candidate contradicted by a printed number / total read twice identically, or by a
 *      proven language, is removed; one matching the printed number and total moves to the top ("number match").
 */
import { corroborateCandidate, parseCollectorText } from './MetadataCorroboration.js';

/** Probability for each of the top-k ranked candidates from their family scores (sorted, length ≥ k + 1). */
export function proposalProbabilities(scores, cal) {
  if (!cal?.coef || scores.length < 2) return [];
  const k = Math.min(cal.k ?? 5, scores.length - 1), s = [...scores, scores[scores.length - 1]];
  const out = [];
  for (let r = 0; r < k; r++) {
    const sr = s[r], gap = s[0] - sr, nxt = sr - s[r + 1], m12 = Math.min(s[0] - s[1], 0.3);
    const x = [sr, gap, nxt, r === 0 ? 1 : 0, sr * sr, gap * gap, m12];
    let z = cal.intercept; for (let i = 0; i < x.length; i++) z += cal.coef[i] * x[i];
    out.push(1 / (1 + Math.exp(-z)));
  }
  return out;
}

/** One frame: the candidates that pass the calibrated display rule ([{ id, p, rank }]). */
export function frameProposals(ranked, cal) {
  const p = proposalProbabilities(ranked.map(h => h.score), cal);
  if (!p.length || p[0] < (cal.show ?? 0.6)) return [];
  return ranked.slice(0, p.length).map((h, i) => ({ id: h.id, p: p[i], rank: i })).filter(x => x.p >= (cal.include ?? 0.1)).slice(0, cal.max ?? 3);
}

/** Most frequent identical printed reading (number + total) seen at least twice, or null. */
export function stablePrintedRead(texts) {
  const counts = new Map();
  for (const t of texts) {
    const p = parseCollectorText(t);
    if (!p.number || p.printedTotal == null) continue;
    const key = `${p.number}/${p.printedTotal}`;
    const e = counts.get(key) || { parsed: p, n: 0 }; e.n++; counts.set(key, e);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best && best.n >= 2 ? best.parsed : null;
}

export class ProposalTracker {
  constructor({ window = 4, minFrames = 3 } = {}) { this.window = window; this.minFrames = minFrames; this.frames = []; }
  reset() { this.frames = []; }

  /** @param ranked [{ id, score }] family ranking of one analysed frame. */
  observe(ranked, cal, memory = []) {
    const f = frameProposals(ranked, cal);
    // The user's own confirmed scans (ScanMemory, cosine ≥ 0.92): that family is proposed (proposal only).
    for (const m of memory) {
      const e = f.find(x => x.id === m.id);
      if (e) e.p = Math.max(e.p, 0.75), e.remembered = true;
      else if (ranked.some(h => h.id === m.id)) f.unshift({ id: m.id, p: 0.75, rank: -1, remembered: true });
    }
    this.frames.push(f.slice(0, 3));
    if (this.frames.length > this.window) this.frames.shift();
  }

  /**
   * Stable proposals: [{ id, p, frames, numberMatch }] sorted (number match first, then probability).
   * @param candidates the latest candidate objects (to read printed metadata and languages)
   * @param evidence { printed: parsed collector text seen twice | null, language: proven language | null, script: 'latin' | 'ja' | null }
   */
  stable(candidates, evidence = {}) {
    if (this.frames.length < this.minFrames) return [];
    const agg = new Map();
    for (const f of this.frames) for (const x of f) { const a = agg.get(x.id) || { id: x.id, sum: 0, frames: 0, remembered: false }; a.sum += x.p; a.frames++; a.remembered ||= Boolean(x.remembered); agg.set(x.id, a); }
    const byId = new Map(candidates.map(c => [c.id, c]));
    const out = [];
    for (const a of agg.values()) {
      if (a.frames < this.minFrames) continue;
      const c = byId.get(a.id); if (!c) continue;
      const langs = c.languages?.length ? c.languages : [c.lang];
      if (evidence.language && !langs.includes(evidence.language)) continue;
      // v0.4.3: a card proven to be printed in Latin script is never proposed as its Japanese printing (and vice versa).
      if (evidence.script === 'latin' && langs.every(l => l === 'ja')) continue;
      if (evidence.script === 'ja' && !langs.includes('ja')) continue;
      let numberMatch = false;
      if (evidence.printed) {
        const row = (evidence.language && c.byLang?.[evidence.language]) || c;
        const v = corroborateCandidate(row, evidence.printed, {});
        if (v.contradicts) continue;
        numberMatch = v.printingSupport;
      }
      out.push({ id: a.id, p: a.sum / a.frames, frames: a.frames, numberMatch, remembered: a.remembered });
    }
    // The strongest proposal must itself have passed the display bar on average.
    out.sort((x, y) => (y.numberMatch - x.numberMatch) || (y.remembered - x.remembered) || (y.p - x.p));
    return out.length && (out[0].numberMatch || out[0].p >= 0.6) ? out.slice(0, 3) : [];
  }
}

/** Plain-language strength of a proposal (calibrated probability). */
export function proposalStrength(p, numberMatch = false) {
  if (numberMatch) return 'number';
  return p >= 0.85 ? 'high' : p >= 0.6 ? 'good' : 'possible';
}
