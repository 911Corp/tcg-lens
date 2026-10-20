/**
 * v0.3.9 — multi-card mode (a spread of cards on a table, a binder page).
 *
 * Each pass finds up to 6 card rectangles (detectRects, in the frame worker), rectifies each one from the
 * same frame and queries the calibrated index. A card is named only under the single-card instant-lock
 * rules: calibrated scale, no artwork twin, set visually complete (visualOnlyLockAllowed), no lock block,
 * score ≥ instantScore and non-twin margin ≥ instantMargin, quality ≥ instantMinQuality — observed on
 * ≥ instantVotes consecutive passes at the same place with the same identity. Anything else stays "?".
 * The printed language is not read in this mode: it is shown as candidates ("FR/EN ?") unless the
 * printing exists in a single language. No OCR, no guessing.
 */

import { t, money as fmtMoney, uiLang } from './i18nRef.js';

/** Pure decision for one slot (testable). */
export function multiDecision(history, policy) {
  const need = Math.max(2, policy.instantVotes ?? 2);
  if (history.length < need) return { state: 'pending' };
  const recent = history.slice(-need);
  const top = recent[recent.length - 1];
  if (!top.id) return { state: 'unknown' };
  if (!recent.every(h => h.id === top.id)) return { state: 'pending' };
  const all = (k, test) => recent.every(h => test(h[k]));
  const avg = k => recent.reduce((a, h) => a + h[k], 0) / recent.length;
  if (!all('calibrated', v => v === true)) return { state: 'unknown', reason: 'not_calibrated' };
  if (!all('twinFree', v => v === true)) return { state: 'ambiguous', reason: 'artwork_twins' };
  if (!all('visualOnlyLockAllowed', v => v === true)) return { state: 'ambiguous', reason: 'set_not_visually_complete' };
  if (recent.some(h => h.lockBlockedReason)) return { state: 'ambiguous', reason: 'lock_blocked' };
  if (avg('score') < policy.instantScore || avg('margin') < policy.instantMargin || avg('quality') < (policy.instantMinQuality ?? 0)) return { state: 'ambiguous', reason: 'below_instant_bar' };
  return { state: 'identified', id: top.id, score: avg('score'), margin: avg('margin') };
}

const scriptOf = ls => ((ls || []).includes('ja') ? 'ja' : 'latin');
/**
 * Same rule as the single-card runtime (_resolveTwins without a read language): artwork twins are ruled out
 * only by the calibrated visual script proof (Latin vs Japanese, gap ≥ scriptGap) when every twin is of
 * the other script. Same-script twins (reprints, promos) keep the card "?".
 */
export function twinFreeByScript(top, policy) {
  const twins = top.twins || [];
  if (!twins.length) return true;
  if (!(Number.isFinite(top.scriptGap) && Number.isFinite(policy.scriptGap) && top.scriptGap >= policy.scriptGap)) return false;
  const vs = top.script;
  return scriptOf(top.languages) === vs && twins.every(t => scriptOf(t.languages) !== vs);
}

const centre = q => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });
const width = q => Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);

export class MultiScan {
  /**
   * @param {object} deps { runtime } — uses runtime.frames, video, rectifier, quality, index, embedding, policy, lang, _screenPoint.
   * @param {HTMLElement} layer overlay root for the per-card labels and the summary bar.
   */
  constructor(runtime, layer) {
    this.rt = runtime; this.layer = layer; this.slots = []; this.nextId = 1; this.lastPass = 0; this.busy = false;
    this.prices = new Map(); this.passMs = 0;
  }

  reset() { this.slots = []; this.render(); }

  async tick(at) {
    this.render();
    if (this.busy || at - this.lastPass < 400) return;
    this.busy = true; this.lastPass = at;
    const t0 = performance.now();
    try { await this._pass(at); } finally { this.busy = false; this.passMs = Math.round(performance.now() - t0); }
    this.render();
  }

  async _pass(at) {
    const rt = this.rt, video = rt.video;
    let dets = [];
    if (rt.frames?.ready) {
      try { dets = await rt.frames.detectMulti(video, { detW: 320, max: 6, minCoverage: 0.5 }); } catch { dets = []; }
    }
    if (!rt.running || !rt.multiMode) return;
    // Match detections to slots (nearest centre within 40 % of the card width).
    const used = new Set();
    for (const d of dets.sort((a, b) => width(b.quad) - width(a.quad))) {
      const c = centre(d.quad), w = width(d.quad);
      let best = null, bd = Infinity;
      for (const s of this.slots) { if (used.has(s)) continue; const sc = centre(s.quad), dd = Math.hypot(sc.x - c.x, sc.y - c.y); if (dd < w * 0.4 && dd < bd) { bd = dd; best = s; } }
      if (!best) { best = { key: this.nextId++, history: [], decision: { state: 'pending' } }; this.slots.push(best); }
      best.quad = d.quad; best.seenAt = at; used.add(best);
    }
    this.slots = this.slots.filter(s => at - s.seenAt < 1500);
    // Identify each visible card from the frame the worker just analysed.
    for (const s of this.slots.filter(x => x.seenAt === at)) {
      const canvas = await rt.rectifier.rectifyAsync(video, s.quad, rt.frames);
      if (!canvas || !rt.multiMode) continue;
      const quality = rt.quality.score(canvas).score;
      const cands = await rt.index.query(canvas, rt.lang, rt.embedding, 6, { track: `multi:${s.key}` });
      const top = cands[0];
      const obs = top ? {
        id: top.id, score: top.score, margin: Number.isFinite(top.marginNonTwin) ? top.marginNonTwin : top.score - (cands[1]?.score ?? 0), quality,
        calibrated: top.calibrated === true, twinFree: top.calibrated === true && twinFreeByScript(top, rt.policy),
        visualOnlyLockAllowed: top.visualOnlyLockAllowed === true, lockBlockedReason: top.lockBlockedReason || null,
      } : { id: null };
      s.history = [...s.history, obs].slice(-6);
      const prev = s.decision;
      s.decision = multiDecision(s.history, rt.policy);
      // Once named, a card keeps its name while the same identity keeps coming back (like the single-card
      // lock, which only re-checks presence); two passes of another identity re-open the decision.
      if (prev.state === 'identified' && s.decision.state !== 'identified') {
        const last2 = s.history.slice(-2);
        if (!(last2.length === 2 && last2.every(h => h.id && h.id !== prev.id))) s.decision = prev;
      }
      if (s.decision.state === 'identified') {
        s.card = cands.find(k => k.id === s.decision.id) || top;
        if (!this.prices.has(this.priceKey(s.card))) this._loadPrice(s.card);
      } else if (s.decision.state !== 'pending') s.card = null;
    }
  }

  priceKey(card) { return `${card.id}|${(card.languages || [card.lang]).join(',')}|${uiLang()}`; }

  async _loadPrice(card) {
    const key = this.priceKey(card); this.prices.set(key, null);
    const langs = card.languages || [card.lang];
    try {
      const r = await fetch(`/api/card?id=${encodeURIComponent(card.id)}&lang=${encodeURIComponent(langs[0] || 'fr')}${langs.length > 1 ? `&langs=${encodeURIComponent(langs.join(','))}` : ''}&market=${uiLang() === 'en' ? 'us' : 'eu'}`);
      if (r.ok) { const c = await r.json(); this.prices.set(key, c.market?.center != null ? c.market : false); }
      else this.prices.set(key, false);
    } catch { this.prices.set(key, false); }
    this.render();
  }

  identified() { return this.slots.filter(s => s.decision.state === 'identified' && s.card); }

  render() {
    const L = this.layer; if (!L) return;
    if (!this.rt.multiMode) { L.hidden = true; L.innerHTML = ''; return; }
    L.hidden = false;
    const fmt = (v, c) => fmtMoney(v, c || 'EUR');
    const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
    const labels = this.slots.map(s => {
      const pts = s.quad.map(p => this.rt._screenPoint(p));
      const cx = pts.reduce((a, p) => a + p.x, 0) / 4, top = Math.min(...pts.map(p => p.y)), hgt = Math.max(...pts.map(p => p.y)) - top;
      const poly = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const st = s.decision.state, card = s.card;
      const m = card ? this.prices.get(this.priceKey(card)) : null;
      const text = st === 'identified' && card
        ? `<b>${esc(card.name)}</b><small>${esc(card.setName || card.setId || '')} · ${esc(card.localId)}${m ? ` · ${esc(m.from ? t('dès {price}', { price: fmt(m.center, m.currency) }) : fmt(m.center, m.currency))}` : ''}</small>`
        : st === 'pending' ? '<b>…</b>' : `<b>?</b><small>${esc(t('À scanner seule'))}</small>`;
      // Inside the top of the card (never over the header, never outside the screen).
      return { poly, html: `<div class="mc-label is-${st}" style="left:${cx.toFixed(0)}px;top:${Math.max(64, top + Math.min(18, hgt * 0.06)).toFixed(0)}px">${text}</div>`, st };
    });
    const ids = this.identified();
    const totals = {};
    for (const s of ids) { const m = this.prices.get(this.priceKey(s.card)); if (m) totals[m.currency] = (totals[m.currency] || 0) + m.center; }
    const value = Object.entries(totals).map(([c, v]) => fmt(Math.round(v * 100) / 100, c)).join(' + ');
    L.innerHTML = `<svg class="mc-svg" aria-hidden="true">${labels.map(l => `<polygon class="mc-edge is-${l.st}" points="${l.poly}"/>`).join('')}</svg>${labels.map(l => l.html).join('')}
      <div class="mc-bar"><span>${uiLang() === 'en' ? `<b>${ids.length}</b> of ${this.slots.length} card${this.slots.length === 1 ? '' : 's'} identified` : `<b>${ids.length}</b> / ${this.slots.length} carte${this.slots.length > 1 ? 's' : ''} identifiée${ids.length > 1 ? 's' : ''}`}${value ? ` · ${esc(value)}` : ''}</span>${ids.length ? `<button type="button" class="mc-add">${esc(t('Tout ajouter'))}</button>` : ''}</div>`;
    L.querySelector('.mc-add')?.addEventListener('click', () => {
      for (const s of ids) {
        const c = s.card, m = this.prices.get(this.priceKey(c)) || null, langs = c.languages || [c.lang];
        document.dispatchEvent(new CustomEvent('tcglens:collect', { detail: {
          id: c.id, lang: null, languageCandidates: langs, // language never proven in this mode
          name: c.name, setName: c.setName || c.setId, number: c.printedTotal ? `${c.localId}/${c.printedTotal}` : c.localId, image: c.image || null,
          market: m ? { center: m.center, currency: m.currency, source: m.source || null, from: Boolean(m.from) } : null,
        } }));
      }
    });
  }
}
