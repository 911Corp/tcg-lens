const money = (value, currency = 'EUR') => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: Number(value) >= 100 ? 0 : 2 }).format(Number(value)); }
  catch { return `${Number(value).toFixed(2)} ${currency}`; }
};

export class MarketOverlay {
  constructor(root, { onOpen = null } = {}) { this.root = root; this.onOpen = onOpen; this.current = null; }

  clear() { this.current = null; if (this.root) { this.root.hidden = true; this.root.innerHTML = ''; } }

  pending(state, label = '') {
    if (!this.root) return;
    this.root.hidden = false;
    this.root.className = 'lens-result-overlay is-status';
    this.root.innerHTML = `<div class="result-status"><span class="state-dot"></span><b>${escapeHtml(state)}</b>${label ? `<small>${escapeHtml(label)}</small>` : ''}</div>`;
  }

  async showLocked(identity, confidence) {
    if (!identity?.id) return;
    let card = identity;
    try {
      const response = await fetch(`/api/card?id=${encodeURIComponent(identity.id)}&lang=${encodeURIComponent(identity.lang || 'fr')}`);
      if (response.ok) card = await response.json();
    } catch {}
    this.current = card;
    if (!this.root) return;
    const market = card.market || {}, heat = card.heat || {};
    const setName = card.set?.name || card.set?.id || 'Set inconnu';
    const variant = card.variantLabel || card.variant || null;
    const trend = heat.trend === 'HEATING' ? '↗' : heat.trend === 'COOLING' ? '↘' : '→';
    const heatText = heat.score == null ? 'Heat · N/A' : `Heat Beta ${heat.score} · ${heat.label || 'N/A'}`;
    const tension = card.supplyDemand?.label ? `Tension · ${card.supplyDemand.label}` : 'Tension · Beta N/A';
    this.root.hidden = false; this.root.className = 'lens-result-overlay is-locked';
    this.root.innerHTML = `
      <button class="result-card" type="button">
        <div class="result-head"><div><strong>${escapeHtml(card.name || identity.name || 'Carte')}</strong><small>${escapeHtml(setName)} · #${escapeHtml(card.localId || identity.localId || '')} · ${escapeHtml((card.lang || identity.lang || '').toUpperCase())}${variant ? ` · ${escapeHtml(variant)}` : ''}</small></div><span class="confidence">${Math.round((confidence || 0) * 100)}%</span></div>
        <div class="result-market"><b>${money(market.center, market.currency || 'EUR')}</b><span>${trend} ${escapeHtml(heat.trend || 'MARKET')}</span></div>
        <div class="result-signals"><span>${escapeHtml(heatText)}</span><span>${escapeHtml(tension)}</span></div>
      </button>`;
    this.root.querySelector('.result-card')?.addEventListener('click', () => this.onOpen?.(card));
  }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
