/**
 * Locked-card sheet. Identity comes from the canonical candidate pool and is shown immediately;
 * market data is loaded only after LOCK and never influences identity. Every async load carries a
 * sequence token so a late response can never paint a previous card's price onto a new card.
 */
const money = (value, currency = 'EUR') => {
  if (value == null || !Number.isFinite(Number(value))) return null;
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: Number(value) >= 100 ? 0 : 2 }).format(Number(value)); }
  catch { return `${Number(value).toFixed(2)} ${currency}`; }
};

export const HEAT_LABELS = Object.freeze({ COLD: 'Froid', COOL: 'Frais', WARM: 'Tiède', HOT: 'Chaud', SURGING: 'En flambée' });
export const TREND_LABELS = Object.freeze({ HEATING: { arrow: '↗', text: 'En hausse' }, COOLING: { arrow: '↘', text: 'En baisse' }, STABLE: { arrow: '→', text: 'Stable' } });
const LANG = { fr: 'Français', en: 'Anglais', ja: 'Japonais' };

/** Pure view model for the sheet (testable). */
export function lockedSheetModel(identity = {}, card = null, confidence = 0) {
  const c = card || {};
  const market = c.market || {};
  const heat = c.heat || {};
  const number = identity.localId || c.localId || '';
  const total = identity.printedTotal ?? c.set?.cardCount?.official ?? null;
  const amount = money(market.center, market.currency || 'EUR');
  // Several TCGplayer finishes priced and the finish not proven: lowest price, shown as "dès …".
  const price = amount && market.from && !identity.variantProven ? `dès ${amount}` : amount;
  const source = market.source || (market.currency === 'USD' ? 'TCGplayer' : amount ? 'Cardmarket' : null);
  // Price of another language's printing (language not proven yet): say which one.
  const priceLangNote = c.priceLang && (identity.languageUnverified || (identity.lang && c.priceLang !== identity.lang)) ? ` (${String(c.priceLang).toUpperCase()})` : '';
  const trend = TREND_LABELS[heat.trend] || null;
  return {
    // The identity name stays (no flip once the market data arrives in another language).
    name: identity.name || c.name || 'Carte',
    setName: identity.setName || c.set?.name || c.set?.id || 'Extension inconnue',
    // Printed form: the total is zero-padded like the number ("001/084").
    number: total ? `${number}/${/^\d+$/.test(number) ? String(total).padStart(number.length, '0') : total}` : number,
    // Language only when proven; otherwise say so (FR and EN share the printing).
    language: identity.languageUnverified
      ? (identity.languageCandidates?.length > 1 ? `${identity.languageCandidates.map(l => l.toUpperCase()).join('/')} ?` : 'Langue ?')
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
  constructor(root, { onOpen = null, onDismiss = null, onCollect = null } = {}) { this.root = root; this.onOpen = onOpen; this.onDismiss = onDismiss; this.onCollect = onCollect; this.current = null; this.seq = 0; }

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
      const langs = (identity.languageCandidates || []).join(',');
      const response = await fetch(`/api/card?id=${encodeURIComponent(identity.id)}&lang=${encodeURIComponent(identity.lang || identity.languageCandidates?.[0] || 'fr')}${langs ? `&langs=${encodeURIComponent(langs)}` : ''}`);
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
    const signals = [
      m.trend ? `${m.trend.arrow} ${esc(m.trend.text)}` : null,
      m.heat ? `Heat ${m.heat.score}${m.heat.beta ? ' β' : ''}` : null,
      m.priceSource ? esc(m.priceSource) : null,
    ].filter(Boolean).join(' · ');
    const price = m.loadingMarket ? '<span class="sheet-amount is-loading">&nbsp;</span>' : `<span class="sheet-amount${m.price ? '' : ' is-missing'}">${m.price ? esc(m.price) : 'Prix n.d.'}</span>`;
    this.root.innerHTML = `
      <div class="sheet lite" role="group" aria-label="${esc(m.name)}">
        <span class="sheet-grab" aria-hidden="true"></span>
        <button class="sheet-x" type="button" aria-label="Masquer le résultat">×</button>
        <button class="sheet-add" type="button" aria-label="Ajouter ${esc(m.name)} à la collection">＋</button>
        <button class="sheet-main" type="button" aria-label="Ouvrir la fiche de ${esc(m.name)}">
          <span class="sheet-row"><span class="sheet-name">${esc(m.name)}</span>${price}</span>
          <span class="sheet-meta">${meta}</span>
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
