/**
 * v0.3.9 — collection model (pure, testable). Items live on the device (localStorage, see collection.js).
 *
 * Item: { key, kind: 'card'|'sealed', id, lang, languageCandidates?, name, setName, number, image,
 *         qty, market: { center, currency, source?, from? } | null, priceAt, addedAt }
 * A card is keyed by printing family + language ("card:<id>:<lang>"); while the language is not proven
 * the item keeps lang = null and its candidate languages, and is never merged with a proven one.
 */
export const cardKey = (id, lang) => `card:${id}:${lang || '?'}`;

export function normalize(list) {
  return (Array.isArray(list) ? list : []).filter(x => x && x.key).map(x => ({ ...x, qty: Math.max(1, Math.round(Number(x.qty) || 1)) }));
}

/** Adds one (or `qty`) copy; returns { list, item, added } — a new list, the input is not modified. */
export function addItem(list, entry, qty = 1, now = Date.now()) {
  const items = normalize(list);
  const key = entry.key || (entry.kind === 'sealed' ? `sealed:${entry.id}` : cardKey(entry.id, entry.lang));
  const i = items.findIndex(x => x.key === key);
  if (i >= 0) {
    const item = { ...items[i], qty: items[i].qty + qty, ...(entry.market?.center != null ? { market: entry.market, priceAt: now } : {}) };
    items[i] = item;
    return { list: items, item, added: false };
  }
  const item = {
    key, kind: entry.kind || 'card', id: entry.id, lang: entry.lang || null,
    ...(entry.languageCandidates?.length ? { languageCandidates: entry.languageCandidates } : {}),
    name: entry.name || 'Carte', setName: entry.setName || '', number: entry.number || '', image: entry.image || null,
    qty, market: entry.market?.center != null ? { center: entry.market.center, currency: entry.market.currency || 'EUR', source: entry.market.source || null, from: Boolean(entry.market.from) } : null,
    priceAt: entry.market?.center != null ? now : null, addedAt: now,
  };
  return { list: [item, ...items], item, added: true };
}

export function setQty(list, key, qty) {
  const q = Math.round(Number(qty) || 0);
  return normalize(list).flatMap(x => (x.key !== key ? [x] : q > 0 ? [{ ...x, qty: q }] : []));
}

export function removeItem(list, key) { return normalize(list).filter(x => x.key !== key); }

/** Total value per currency (EUR and USD are never converted into each other). */
export function totals(list) {
  const out = { count: 0, priced: 0, byCurrency: {} };
  for (const x of normalize(list)) {
    out.count += x.qty;
    if (x.market?.center != null) { out.priced += x.qty; const c = x.market.currency || 'EUR'; out.byCurrency[c] = Math.round(((out.byCurrency[c] || 0) + x.market.center * x.qty) * 100) / 100; }
  }
  return out;
}

export const SORTS = Object.freeze({
  recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  value: (a, b) => (b.market?.center || 0) * b.qty - (a.market?.center || 0) * a.qty,
  name: (a, b) => String(a.name).localeCompare(String(b.name), 'fr'),
  set: (a, b) => String(a.setName).localeCompare(String(b.setName), 'fr') || String(a.number).localeCompare(String(b.number), 'fr', { numeric: true }),
});
export function sorted(list, by = 'recent') { return [...normalize(list)].sort(SORTS[by] || SORTS.recent); }

const LANG = { fr: 'FR', en: 'EN', ja: 'JA' };
const csvCell = (v, sep) => { const s = v == null ? '' : String(v); return s.includes(sep) || /["\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/**
 * CSV in the app language: French → semicolons and decimal commas (French spreadsheets); English → commas and
 * decimal points, English headers.
 */
export function toCSV(list, { lang = 'fr' } = {}) {
  const en = lang === 'en', sep = en ? ',' : ';', dec = v => (en ? String(v) : String(v).replace('.', ','));
  const head = en ? ['Name', 'Type', 'Set', 'Number', 'Language', 'Quantity', 'Unit price', 'Currency', 'Value', 'Price source', 'Price date', 'Added', 'ID']
    : ['Nom', 'Type', 'Extension', 'Numéro', 'Langue', 'Quantité', 'Prix unitaire', 'Devise', 'Valeur', 'Source du prix', 'Prix du', 'Ajouté le', 'Identifiant'];
  const rows = normalize(list).map(x => {
    const p = x.market?.center ?? null;
    return [x.name, x.kind === 'sealed' ? (en ? 'Sealed product' : 'Produit scellé') : (en ? 'Card' : 'Carte'), x.setName, x.number,
      x.lang ? LANG[x.lang] || x.lang : x.languageCandidates?.length ? `${x.languageCandidates.map(l => LANG[l] || l).join('/')} ?` : '',
      x.qty, p != null ? dec(p) : '', p != null ? x.market.currency : '', p != null ? dec(Math.round(p * x.qty * 100) / 100) : '',
      x.market?.source || '', x.priceAt ? new Date(x.priceAt).toISOString().slice(0, 10) : '', x.addedAt ? new Date(x.addedAt).toISOString().slice(0, 10) : '', x.id];
  });
  return '﻿' + [head, ...rows].map(r => r.map(v => csvCell(v, sep)).join(sep)).join('\r\n');
}

/** Old v0.3.x items ({ key: 'card:<id>', expansion, localId, market }) → current shape. */
export function migrate(list) {
  return normalize((Array.isArray(list) ? list : []).map(x => (x.setName !== undefined ? x : {
    ...x, key: x.kind === 'card' ? cardKey(x.id, x.lang) : x.key, setName: x.expansion || '', number: x.localId || '', qty: x.qty || 1,
  })));
}
