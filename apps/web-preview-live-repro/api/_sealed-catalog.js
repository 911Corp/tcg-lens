// Canonical sealed-product catalogue (data/sealed-catalog.json, exported from PostgreSQL by
// tools/export-sealed-catalog.mjs) and barcode helpers shared by /api/sealed and /api/barcode.
import fs from 'node:fs/promises';

let cache = null;
const dataFile = name => (process.env.TCG_LENS_POOL_DIR ? `${process.env.TCG_LENS_POOL_DIR.replace(/\/$/, '')}/${name}` : new URL(`../data/${name}`, import.meta.url));

export const TYPE_LABELS = Object.freeze({
  ETB: 'Coffret Dresseur d’Élite', BOOSTER_BOX: 'Display', DISPLAY: 'Display', BOOSTER_PACK: 'Booster', BOOSTER_BUNDLE: 'Bundle de boosters',
  BLISTER: 'Blister', TIN: 'Pokébox (tin)', COLLECTION_BOX: 'Coffret collection', DECK: 'Deck', CASE: 'Carton', OTHER: 'Autre produit',
});

export const fold = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const STOP = new Set(['pokemon', 'pok', 'mon', 'trading', 'card', 'cards', 'game', 'tcg', 'the', 'and', 'of', 'with', 'scarlet', 'violet', 'sv', 'english', 'version', 'new', 'sealed', 'factory', 'official', 'company', 'international']);
export const tokens = s => fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !STOP.has(t) && t.length > 1);

export async function loadSealedCatalog() {
  if (cache) return cache;
  const raw = JSON.parse(await fs.readFile(dataFile('sealed-catalog.json'), 'utf8'));
  const col = Object.fromEntries(raw.columns.map((c, i) => [c, i]));
  // Cardmarket and TCGplayer list the same physical product separately (both STAGED until
  // corroborated). For display they are grouped by name + type + language-compatibility, keeping
  // both provider ids and both prices; canonical identities are untouched.
  const groups = new Map();
  for (const r of raw.items) {
    const it = Object.fromEntries(raw.columns.map(c => [c, r[col[c]]]));
    const key = `${it.type}|${fold(it.name).replace(/[^a-z0-9]+/g, ' ').trim()}|${it.lang === 'ja' ? 'ja' : 'x'}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...it, entityIds: [it.entityId] }); continue; }
    g.entityIds.push(it.entityId);
    for (const k of ['cardmarketId', 'tcgplayerId', 'cmTrendEur', 'cmLowEur', 'tpMarketUsd', 'tpLowUsd', 'releaseDate', 'lang']) if (g[k] == null && it[k] != null) g[k] = it[k];
  }
  const items = [...groups.values()].map(it => { it.tokens = tokens(it.name); it.folded = fold(it.name); return it; });
  let verified = {};
  try { verified = JSON.parse(await fs.readFile(dataFile('barcodes.json'), 'utf8')).verified || {}; } catch {}
  const byId = new Map(); for (const it of items) for (const id of it.entityIds) byId.set(id, it);
  cache = { asOf: raw.asOf, items, byId, verified };
  return cache;
}

export function publicSealed(it, extra = {}) {
  return {
    id: it.entityId, name: it.name, type: it.type, typeLabel: TYPE_LABELS[it.type] || 'Produit scellé', lang: it.lang, releaseDate: it.releaseDate,
    cardmarketId: it.cardmarketId, tcgplayerId: it.tcgplayerId,
    image: it.tcgplayerId ? `https://tcgplayer-cdn.tcgplayer.com/product/${it.tcgplayerId}_in_400x400.jpg` : null,
    price: it.cmTrendEur != null ? { center: it.cmTrendEur, low: it.cmLowEur, currency: 'EUR', source: 'Cardmarket' }
      : it.tpMarketUsd != null ? { center: it.tpMarketUsd, low: it.tpLowUsd, currency: 'USD', source: 'TCGplayer' } : null,
    altPrice: it.cmTrendEur != null && it.tpMarketUsd != null ? { center: it.tpMarketUsd, currency: 'USD', source: 'TCGplayer' } : null,
    ...extra,
  };
}

/** Product type from a free-text title (retailer / UPC database wording, EN + FR). */
export function classifyTitle(title) {
  const n = fold(title);
  if (/elite trainer|\betb\b|dresseur d.?elite/.test(n)) return 'ETB';
  if (/booster box|display|36 (booster|pack)/.test(n)) return 'BOOSTER_BOX';
  if (/booster bundle|bundle/.test(n)) return 'BOOSTER_BUNDLE';
  if (/blister|checklane|sleeved booster/.test(n)) return 'BLISTER';
  if (/\btin\b|pokebox/.test(n)) return 'TIN';
  if (/\bdeck\b|battle deck|theme deck/.test(n)) return 'DECK';
  if (/booster pack|\bbooster\b/.test(n)) return 'BOOSTER_PACK';
  if (/collection|premium|box|coffret/.test(n)) return 'COLLECTION_BOX';
  return null;
}

/** Rank catalogue products against a title: token coverage + type agreement. */
export function rankByTitle(items, title, { limit = 5 } = {}) {
  const q = tokens(title); if (!q.length) return [];
  const qs = new Set(q), type = classifyTitle(title);
  const out = [];
  for (const it of items) {
    let hit = 0; for (const t of it.tokens) if (qs.has(t)) hit++;
    if (!hit) continue;
    const recall = hit / it.tokens.length, precision = hit / qs.size;
    let score = 0.6 * recall + 0.4 * precision;
    if (type) score += type === it.type || (type === 'BOOSTER_BOX' && it.type === 'DISPLAY') ? 0.1 : -0.2;
    out.push({ it, score });
  }
  // Raw scores keep extra words ("Case", "Pokémon Center") below the exact product.
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(x => ({ ...x, score: Math.max(0, Math.min(1, x.score / 1.1)) }));
}

/** EAN-8 / UPC-A / EAN-13 / JAN / GTIN-14 → GTIN-14 with checksum validation. */
export function toGtin14(code) {
  const d = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const g = d.padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(g[13]) ? g : null;
}
