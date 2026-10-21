// v0.3.9 — collection panel: quantities, value, sort, CSV export, price refresh, one-tap add from the scanner.
import { addItem, setQty, removeItem, totals, sorted, toCSV, migrate } from './lens/collectionModel.js';
import { t, money as fmtMoney, uiLang } from './lens/i18nRef.js';

const KEY = 'collection';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const read = () => { try { return migrate(JSON.parse(localStorage.getItem(KEY)) || []); } catch { return []; } };
const write = list => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} };
const money = (v, c = 'EUR') => fmtMoney(v, c);
const toast = msg => window.toast?.(msg);
// `state` is a top-level const of app-1.js (global lexical scope, not a window property).
const shellState = () => (typeof state !== 'undefined' ? state : null); // eslint-disable-line no-undef
const LANG = { fr: 'FR', en: 'EN', ja: 'JA' };
// Re-render on app-language change.
document.addEventListener('tcglens:uilang', () => { if (shellState()?.screen === 'collection') render(); });
let sortBy = (() => { try { return localStorage.getItem('collectionSort') || 'recent'; } catch { return 'recent'; } })();

function numberLabel(localId, total) {
  if (!localId) return '';
  return total ? `${localId}/${/^\d+$/.test(String(localId)) ? String(total).padStart(String(localId).length, '0') : total}` : String(localId);
}

/** Entry from the card / sealed detail being shown (state.current). */
function entryFromCurrent(c) {
  if (c.kind === 'sealed') return { kind: 'sealed', id: c.id, name: c.name, setName: c.expansion || c.type || '', image: c.image || null, market: c.price?.center != null ? { center: c.price.center, currency: c.price.currency || 'EUR', source: c.price.source || 'Cardmarket' } : null };
  return { kind: 'card', id: c.id, lang: c.lang || null, name: c.name, setName: c.set?.name || c.set?.id || '', number: numberLabel(c.localId, c.set?.cardCount?.official), image: c.image || null, market: c.market };
}

function add(entry, qty = 1) {
  const { list, item, added } = addItem(read(), entry, qty);
  write(list);
  toast(added ? t('Ajouté à la collection') : `${t('Ajouté à la collection')} (×${item.qty})`);
  if (shellState()?.screen === 'collection') render();
  return item;
}

window.addCurrent = function addCurrent() {
  const c = shellState()?.current; if (!c) return;
  add(entryFromCurrent(c));
};

// One tap from the scanner result sheet (lens/MarketOverlay.js dispatches the identified printing).
document.addEventListener('tcglens:collect', e => {
  const d = e.detail || {}; if (!d.id) return;
  add({ kind: 'card', id: d.id, lang: d.lang || null, languageCandidates: d.languageCandidates, name: d.name, setName: d.setName, number: d.number, image: d.image, market: d.market });
});

function langLabel(x) {
  if (x.kind === 'sealed') return '';
  if (x.lang) return LANG[x.lang] || x.lang;
  return x.languageCandidates?.length ? `${x.languageCandidates.map(l => LANG[l] || l).join('/')} ?` : '';
}

function render() {
  const body = $('#collectionBody'); if (!body) return;
  const list = read();
  if (!list.length) {
    body.innerHTML = `<div class="collection-empty">${esc(t('Votre collection est vide.'))}<br>${uiLang() === 'en' ? 'Scan a card and tap <b>＋</b> on the result, or open a card and tap “Add to collection”.' : 'Scannez une carte puis touchez <b>＋</b> sur le résultat, ou ouvrez une fiche et touchez « Ajouter à la collection ».'}</div>`;
    return;
  }
  const tot = totals(list);
  const value = Object.entries(tot.byCurrency).map(([c, v]) => money(v, c)).join(' + ') || '—';
  body.innerHTML = `
    <div class="coll-summary">
      <div><span class="coll-k">${esc(t('Cartes et produits'))}</span><b>${tot.count}</b></div>
      <div><span class="coll-k">${esc(t('Valeur estimée'))}</span><b>${esc(value)}</b>${tot.priced < tot.count ? `<small>${esc(t('{n} sans prix', { n: tot.count - tot.priced }))}</small>` : ''}</div>
    </div>
    <div class="coll-tools">
      <select id="collSort" aria-label="${esc(t('Trier'))}">
        ${[['recent', 'Plus récents'], ['value', 'Valeur'], ['name', 'Nom'], ['set', 'Extension']].map(([k, l]) => `<option value="${k}"${k === sortBy ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}
      </select>
      <button type="button" class="chip" id="collRefresh">${esc(t('Actualiser les prix'))}</button>
      <button type="button" class="chip" id="collExport">${esc(t('Exporter (CSV)'))}</button>
    </div>
    <ul class="coll-list">${sorted(list, sortBy).map(x => `
      <li class="coll-item" data-key="${esc(x.key)}">
        <button type="button" class="coll-open" aria-label="Ouvrir ${esc(x.name)}">${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy">` : '<span class="coll-noimg"></span>'}</button>
        <div class="coll-info">
          <b>${esc(x.name)}</b>
          <small>${esc([x.setName, x.number, langLabel(x)].filter(Boolean).join(' · '))}</small>
          <span class="coll-price">${x.market?.center != null ? `${x.market.estimated ? `<small>${esc(t('Estimation'))}</small> ≈ ` : ''}${esc(x.market.from ? t('dès {price}', { price: money(x.market.center, x.market.currency) }) : money(x.market.center, x.market.currency))}${x.qty > 1 ? ` <small>× ${x.qty} = ${esc(money(Math.round(x.market.center * x.qty * 100) / 100, x.market.currency))}</small>` : ''}` : `<small>${esc(t('Prix n.d.'))}</small>`}</span>
        </div>
        <div class="coll-qty" role="group" aria-label="${esc(t('Quantité'))}">
          <button type="button" data-q="-1" aria-label="${esc(t('Retirer un exemplaire'))}">−</button><span>${x.qty}</span><button type="button" data-q="1" aria-label="${esc(t('Ajouter un exemplaire'))}">+</button>
        </div>
      </li>`).join('')}
    </ul>`;
  $('#collSort').onchange = e => { sortBy = e.target.value; try { localStorage.setItem('collectionSort', sortBy); } catch {} render(); };
  $('#collExport').onclick = exportCSV;
  $('#collRefresh').onclick = refreshPrices;
  body.querySelectorAll('.coll-item').forEach(li => {
    const key = li.dataset.key, item = list.find(x => x.key === key);
    li.querySelector('.coll-open').onclick = () => { if (item.kind === 'card') window.openCard?.(item.id, item.lang || item.languageCandidates?.[0] || 'fr'); else window.openSealed?.(item); };
    li.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      const q = item.qty + Number(b.dataset.q);
      if (q <= 0) { write(removeItem(read(), key)); toast(t('Retiré de la collection')); } else write(setQty(read(), key, q));
      render();
    });
  });
}
window.renderCollection = render;

function exportCSV() {
  const blob = new Blob([toCSV(read(), { lang: uiLang() })], { type: 'text/csv;charset=utf-8' });
  const name = `tcg-lens-collection-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = typeof File === 'function' ? new File([blob], name, { type: 'text/csv' }) : null;
  if (file && navigator.canShare?.({ files: [file] })) { navigator.share({ files: [file], title: uiLang() === 'en' ? 'TCG Lens collection' : 'Collection TCG Lens' }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function refreshPrices() {
  const btn = $('#collRefresh'); if (btn) { btn.disabled = true; btn.textContent = t('Actualisation…'); }
  const cards = read().filter(x => x.kind === 'card');
  let updated = 0;
  for (let i = 0; i < cards.length; i += 4) {
    await Promise.all(cards.slice(i, i + 4).map(async x => {
      try {
        const langs = x.languageCandidates?.join(',') || '';
        const r = await fetch(`/api/card?id=${encodeURIComponent(x.id)}&lang=${encodeURIComponent(x.lang || x.languageCandidates?.[0] || 'fr')}${langs ? `&langs=${encodeURIComponent(langs)}` : ''}&market=${uiLang() === 'en' ? 'us' : 'eu'}`);
        if (!r.ok) return;
        const c = await r.json();
        if (c.market?.center == null) return;
        const list = read(), k = list.findIndex(y => y.key === x.key);
        if (k < 0) return;
        list[k] = { ...list[k], market: { center: c.market.center, currency: c.market.currency || 'EUR', source: c.market.source || null, from: Boolean(c.market.from), estimated: Boolean(c.market.estimated), estimatedFrom: c.market.estimatedFrom || null }, priceAt: Date.now() };
        write(list); updated++;
      } catch {}
    }));
  }
  toast(updated ? (uiLang() === 'en' ? `${updated} price${updated > 1 ? 's' : ''} refreshed` : `${updated} prix actualisé${updated > 1 ? 's' : ''}`) : t('Aucun prix à actualiser'));
  render();
}
