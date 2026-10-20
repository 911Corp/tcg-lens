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
  const price = money(market.center, market.currency || 'EUR');
  const trend = TREND_LABELS[heat.trend] || null;
  return {
    name: c.name || identity.name || 'Carte',
    setName: identity.setName || c.set?.name || c.set?.id || 'Extension inconnue',
    // Printed form: the total is zero-padded like the number ("001/084").
    number: total ? `${number}/${/^\d+$/.test(number) ? String(total).padStart(number.length, '0') : total}` : number,
    // Language only when proven; otherwise say so (FR and EN share the printing).
    language: identity.languageUnverified
      ? `Langue à confirmer${identity.languageCandidates?.length > 1 ? ` (${identity.languageCandidates.map(l => l.toUpperCase()).join(' / ')})` : ''}`
      : LANG[identity.lang || c.lang] || (identity.lang || '').toUpperCase(),
    variant: identity.variantProven ? (identity.variantLabel || null) : null,
    confidence: Math.round((confidence || 0) * 100),
    loadingMarket: card == null,
    price,
    priceSource: market.currency === 'USD' ? 'TCGplayer' : price ? 'Cardmarket' : null,
    trend,
    heat: heat.score == null ? null : { label: HEAT_LABELS[heat.label] || heat.label, score: heat.score, beta: heat.beta !== false },
    supplyDemand: c.supplyDemand?.score == null ? null : c.supplyDemand.label,
  };
}

export class MarketOverlay {
  constructor(root, { onOpen = null } = {}) { this.root = root; this.onOpen = onOpen; this.current = null; this.seq = 0; }

  clear() { this.seq++; this.current = null; if (this.root) { this.root.hidden = true; this.root.innerHTML = ''; this.root.classList.remove('is-dim'); } }

  dim(on) { this.root?.classList.toggle('is-dim', Boolean(on)); }

  /** Kept for compatibility; status text now lives in the HUD. */
  pending() {}

  async showLocked(identity, confidence) {
    if (!identity?.id) return;
    const seq = ++this.seq;
    this.current = identity;
    this._paint(lockedSheetModel(identity, null, confidence), identity);
    let card = null;
    try {
      const response = await fetch(`/api/card?id=${encodeURIComponent(identity.id)}&lang=${encodeURIComponent(identity.lang || identity.languageCandidates?.[0] || 'fr')}`);
      if (response.ok) card = await response.json();
    } catch {}
    if (seq !== this.seq) return; // a newer card (or a clear) happened meanwhile
    this.current = card || identity;
    this._paint(lockedSheetModel(identity, card || {}, confidence), identity);
  }

  _paint(m, identity) {
    if (!this.root) return;
    this.root.hidden = false;
    this.root.classList.remove('is-dim');
    const signals = [
      m.trend ? `<li><span class="sig-key">Tendance</span><span class="sig-val">${m.trend.arrow} ${esc(m.trend.text)}</span></li>` : '',
      `<li><span class="sig-key">Heat${m.heat?.beta ? ' <i>bêta</i>' : ''}</span><span class="sig-val">${m.heat ? `${esc(m.heat.label)} ${m.heat.score}` : 'Non disponible'}</span></li>`,
      `<li><span class="sig-key">Offre / demande</span><span class="sig-val">${m.supplyDemand ? esc(m.supplyDemand) : 'Non disponible'}</span></li>`,
    ].join('');
    this.root.innerHTML = `
      <button class="sheet" type="button" aria-label="Ouvrir la fiche de ${esc(m.name)}">
        <span class="sheet-foil" aria-hidden="true"></span>
        <span class="sheet-head">
          <span class="sheet-name">${esc(m.name)}</span>
          <span class="sheet-confidence" title="Confiance de l’identification"><b>${m.confidence}</b> %</span>
        </span>
        <span class="sheet-id">
          <span class="sheet-set">${esc(m.setName)}</span>
          <span class="sheet-number">${esc(m.number)}</span>
          <span class="sheet-lang">${esc(m.language)}</span>
          ${m.variant ? `<span class="sheet-lang">${esc(m.variant)}</span>` : ''}
        </span>
        <span class="sheet-price ${m.loadingMarket ? 'is-loading' : m.price ? '' : 'is-missing'}">
          <span class="sheet-amount">${m.loadingMarket ? '&nbsp;' : m.price ? esc(m.price) : 'Prix non disponible'}</span>
          ${m.priceSource ? `<span class="sheet-source">tendance ${esc(m.priceSource)}</span>` : ''}
        </span>
        ${m.loadingMarket ? '' : `<ul class="sheet-signals">${signals}</ul>`}
        <span class="sheet-open">Voir la fiche complète</span>
      </button>`;
    this.root.querySelector('.sheet')?.addEventListener('click', () => this.onOpen?.(this.current?.id ? this.current : identity));
  }
}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
