/**
 * Locked-card sheet. Identity comes from the canonical candidate pool and is shown immediately;
 * market data is loaded only after LOCK and never influences identity. Every async load carries a
 * sequence token so a late response can never paint a previous card's price onto a new card.
 */
import { t, money, uiLang } from './i18nRef.js';

const HEAT_FR = { COLD: 'Froid', COOL: 'Frais', WARM: 'Tiède', HOT: 'Chaud', SURGING: 'En flambée' };
export const HEAT_LABELS = new Proxy(HEAT_FR, { get: (o, k) => (k in o ? t(o[k]) : undefined) });
const TREND_FR = { HEATING: { arrow: '↗', text: 'En hausse' }, COOLING: { arrow: '↘', text: 'En baisse' }, STABLE: { arrow: '→', text: 'Stable' } };
export const TREND_LABELS = new Proxy(TREND_FR, { get: (o, k) => (k in o ? { ...o[k], text: t(o[k].text) } : undefined) });
const LANG_FR = { fr: 'Français', en: 'Anglais', ja: 'Japonais' };
const LANG = new Proxy(LANG_FR, { get: (o, k) => (k in o ? t(o[k]) : undefined) });

/** Pure view model for the sheet (testable). */
export function lockedSheetModel(identity = {}, card = null, confidence = 0) {
  const c = card || {};
  const market = c.market || {};
  const heat = c.heat || {};
  const number = identity.localId || c.localId || '';
  const total = identity.printedTotal ?? c.set?.cardCount?.official ?? null;
  const amount = money(market.center, market.currency || 'EUR');
  // Several TCGplayer finishes priced and the finish not proven: lowest price, shown as "dès …".
  const price = amount && market.from && !identity.variantProven ? t('dès {price}', { price: amount }) : amount;
  const source = market.source || (market.currency === 'USD' ? 'TCGplayer' : amount ? 'Cardmarket' : null);
  // Price of another language's printing (language not proven yet): say which one.
  const priceLangNote = c.priceLang && (identity.languageUnverified || (identity.lang && c.priceLang !== identity.lang)) ? ` (${String(c.priceLang).toUpperCase()})` : '';
  const trend = TREND_LABELS[heat.trend] || null;
  return {
    // The identity name stays (no flip once the market data arrives in another language).
    name: identity.name || c.name || t('Carte'),
    setName: identity.setName || c.set?.name || c.set?.id || t('Extension inconnue'),
    // Printed form: the total is zero-padded like the number ("001/084").
    number: identity.printedNumber || (total ? `${number}/${/^\d+$/.test(number) ? String(total).padStart(number.length, '0') : total}` : number),
    // Language only when proven; otherwise say so (FR and EN share the printing).
    language: identity.languageUnverified
      ? (identity.languageCandidates?.length > 1 ? `${identity.languageCandidates.map(l => l.toUpperCase()).join('/')} ?` : t('Langue ?'))
      : LANG[identity.lang || c.lang] || (identity.lang || '').toUpperCase(),
    variant: identity.variantProven ? (identity.variantLabel || null) : null,
    confidence: Math.round((confidence || 0) * 100),
    loadingMarket: card == null,
    price,
    priceSource: amount && source ? `${source}${priceLangNote}` : null,
    trend,
    heat: heat.score == null ? null : { label: HEAT_LABELS[heat.label] || heat.label, score: heat.score, beta: heat.beta !== false },
    supplyDemand: c.supplyDemand?.score == null ? null : c.supplyDemand.label,
  };
}

export class MarketOverlay {
  constructor(root, { onOpen = null, onDismiss = null, onCollect = null, onConfirm = null, onReject = null } = {}) { this.root = root; this.onOpen = onOpen; this.onDismiss = onDismiss; this.onCollect = onCollect; this.onConfirm = onConfirm; this.onReject = onReject; this.current = null; this.seq = 0; }

  clear() { this.seq++; this.current = null; if (this.root) { this.root.hidden = true; this.root.innerHTML = ''; this.root.classList.remove('is-dim'); } }

  dim(on) { this.root?.classList.toggle('is-dim', Boolean(on)); }

  /** Kept for compatibility; status text now lives in the HUD. */
  pending() {}

  async showLocked(identity, confidence) {
    if (!identity?.id) return;
    const seq = ++this.seq;
    this.current = identity; this.lastCard = null;
    this._paint(lockedSheetModel(identity, null, confidence), identity);
    let card = null;
    try {
      const cl = identity.languageCandidates || [];
      const langs = [...cl].sort((a, b) => (b === uiLang()) - (a === uiLang())).join(',');
      const response = await fetch(`/api/card?id=${encodeURIComponent(identity.id)}&lang=${encodeURIComponent(identity.lang || (cl.includes(uiLang()) ? uiLang() : cl[0]) || 'fr')}${langs ? `&langs=${encodeURIComponent(langs)}` : ''}&market=${uiLang() === 'en' ? 'us' : 'eu'}`);
      if (response.ok) card = await response.json();
    } catch {}
    if (seq !== this.seq) return; // a newer card (or a clear) happened meanwhile
    this.current = card || identity; this.lastCard = card;
    this._paint(lockedSheetModel(identity, card || {}, confidence), identity);
  }

  _paint(m, identity) {
    if (!this.root) return;
    this.root.hidden = false;
    this.root.classList.remove('is-dim');
    // v0.3.7: three short lines over the live camera — name + price, set · number · language, trend.
    const meta = [m.setName, m.number, m.language, m.variant].filter(Boolean).map(esc).join(' · ');
    const confirmedNote = identity?.userConfirmed ? `<span class="sheet-confirmed">${esc(t('Confirmée par vous'))}</span>` : '';
    const signals = [
      m.trend ? `${m.trend.arrow} ${esc(m.trend.text)}` : null,
      m.heat ? `Heat ${m.heat.score}${m.heat.beta ? ' β' : ''}` : null,
      m.priceSource ? esc(m.priceSource) : null,
    ].filter(Boolean).join(' · ');
    const price = m.loadingMarket ? '<span class="sheet-amount is-loading">&nbsp;</span>' : `<span class="sheet-amount${m.price ? '' : ' is-missing'}">${m.price ? esc(m.price) : esc(t('Prix n.d.'))}</span>`;
    this.root.innerHTML = `
      <div class="sheet lite" role="group" aria-label="${esc(m.name)}">
        <span class="sheet-grab" aria-hidden="true"></span>
        <button class="sheet-x" type="button" aria-label="${esc(t('Masquer le résultat'))}">×</button>
        <button class="sheet-add" type="button" aria-label="${esc(t('Ajouter {name} à la collection', { name: m.name }))}">＋</button>
        <button class="sheet-main" type="button" aria-label="${esc(t('Ouvrir la fiche de {name}', { name: m.name }))}">
          <span class="sheet-row"><span class="sheet-name">${esc(m.name)}</span>${price}</span>
          <span class="sheet-meta">${meta}</span>${confirmedNote}
          ${signals ? `<span class="sheet-signal">${signals}</span>` : ''}
        </button>
      </div>`;
    const sheet = this.root.querySelector('.sheet');
    sheet.querySelector('.sheet-main').addEventListener('click', () => this.onOpen?.(this.current?.id ? this.current : identity));
    sheet.querySelector('.sheet-x').addEventListener('click', e => { e.stopPropagation(); this.dismiss(); });
    // v0.3.9: one tap adds the identified printing to the collection (the sheet stays, so a pile can be scanned quickly).
    sheet.querySelector('.sheet-add').addEventListener('click', e => {
      e.stopPropagation();
      const b = e.currentTarget; b.classList.remove('done'); void b.offsetWidth; b.classList.add('done');
      this.collect(identity, m);
    });
    // Swipe down (or sideways) to dismiss.
    let x0 = null, y0 = null;
    sheet.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (y0 == null) return;
      const dy = Math.max(0, e.touches[0].clientY - y0), dx = e.touches[0].clientX - x0;
      sheet.style.transform = `translate(${Math.abs(dx) > dy ? dx : 0}px, ${Math.abs(dx) > dy ? 0 : dy}px)`;
      sheet.style.opacity = String(Math.max(0.2, 1 - Math.max(dy, Math.abs(dx)) / 220));
    }, { passive: true });
    sheet.addEventListener('touchend', e => {
      if (y0 == null) return;
      const t = e.changedTouches[0], dy = t.clientY - y0, dx = t.clientX - x0;
      x0 = y0 = null;
      if (dy > 60 || Math.abs(dx) > 90) this.dismiss(); else { sheet.style.transform = ''; sheet.style.opacity = ''; }
    });
  }

  /**
   * v0.4.1 — proposals (nothing identified yet): up to 3 printings with their picture so the user can compare,
   * strength in plain words, tap = confirm, "None of these" = reject. Never shows a price (not identified).
   */
  showProposals(items) {
    if (!this.root || !items?.length) return;
    this.seq++; this.current = null; this.lastCard = null;
    this.root.hidden = false; this.root.classList.remove('is-dim');
    const label = x => x.numberMatch ? t('Numéro concordant') : x.remembered ? t('Déjà confirmée par vous') : x.twin ? t('Même illustration') : x.p >= 0.85 ? t('Très probable') : t('Probable');
    const num = x => { const n = x.printedNumber || (x.printedTotal ? `${x.localId}/${/^\d+$/.test(String(x.localId)) ? String(x.printedTotal).padStart(String(x.localId).length, '0') : x.printedTotal}` : x.localId); return n || ''; };
    const langs = x => (x.languages?.length > 1 ? `${x.languages.map(l => l.toUpperCase()).join('/')} ?` : (x.languages?.[0] || x.lang || '').toUpperCase());
    this.root.innerHTML = `
      <div class="sheet lite proposals" role="group" aria-label="${esc(t('Est-ce cette carte ?'))}">
        <span class="sheet-grab" aria-hidden="true"></span>
        <span class="prop-title">${esc(t('Est-ce cette carte ?'))}</span>
        <ul class="prop-list">${items.map((x, i) => `
          <li><button type="button" class="prop-item${x.numberMatch ? ' is-number' : ''}" data-i="${i}">
            ${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy" decoding="async">` : '<span class="prop-noimg"></span>'}
            <span class="prop-text"><b>${esc(x.name)}</b><small>${esc([x.setName || x.setId, num(x), langs(x)].filter(Boolean).join(' · '))}</small></span>
            <span class="prop-p p-${x.numberMatch ? 'number' : x.p >= 0.85 ? 'high' : 'good'}">${esc(label(x))}</span>
          </button></li>`).join('')}
        </ul>
        <button type="button" class="prop-none">${esc(t('Aucune de ces cartes'))}</button>
      </div>`;
    this.root.querySelectorAll('.prop-item').forEach(b => b.addEventListener('click', () => { const x = items[Number(b.dataset.i)]; if (x) this.onConfirm?.(x.id); }));
    this.root.querySelector('.prop-none').addEventListener('click', () => this.onReject?.());
  }

  /** Collection entry for the identified printing (language stays unproven if it is). */
  collect(identity, m) {
    const card = this.lastCard || {};
    const detail = {
      id: identity.id, lang: identity.languageUnverified ? null : identity.lang || null,
      languageCandidates: identity.languageUnverified ? identity.languageCandidates || [] : undefined,
      name: m.name, setName: m.setName, number: m.number, image: identity.image || null,
      market: card.market?.center != null ? { center: card.market.center, currency: card.market.currency || 'EUR', source: card.market.source || null, from: Boolean(card.market.from) && !identity.variantProven } : null,
    };
    if (this.onCollect) this.onCollect(detail);
    else if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('tcglens:collect', { detail }));
  }

  /** User closed the result. */
  dismiss() {
    if (this.onDismiss) this.onDismiss(); else this.clear();
  }
}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
