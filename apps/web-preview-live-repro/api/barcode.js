// Barcode (EAN / UPC / JAN) → sealed product.
//  1. GTIN-14 normalisation with checksum (invalid reads are rejected, never guessed).
//  2. Verified registry (data/barcodes.json, exported from entity_barcodes VERIFIED) → VERIFIED.
//  3. Otherwise the product title from the UPCitemdb public database is matched against the
//     canonical sealed catalogue → CANDIDATE only: the user confirms once, the app remembers it.
import { loadSealedCatalog, publicSealed, rankByTitle, toGtin14 } from './_sealed-catalog.js';

const titleCache = new Map();

async function lookupTitle(gtin) {
  if (titleCache.has(gtin)) return titleCache.get(gtin);
  const upc = gtin.replace(/^0+(?=\d{12,})/, '');
  let found = null;
  try {
    const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const j = await r.json();
      const item = (j.items || [])[0];
      if (item?.title) found = { title: item.title, brand: item.brand || null, source: 'UPCitemdb' };
    } else if (r.status === 429) found = { error: 'rate_limited' };
  } catch {}
  if (found && !found.error) titleCache.set(gtin, found);
  return found;
}

export default async function handler(req, res) {
  try {
    const gtin = toGtin14(req.query.code);
    if (!gtin) return res.status(400).json({ status: 'INVALID', error: 'checksum' });
    const cat = await loadSealedCatalog();
    const verifiedId = cat.verified[gtin];
    if (verifiedId && cat.byId.has(verifiedId)) {
      res.setHeader('Cache-Control', 's-maxage=86400');
      return res.status(200).json({ gtin14: gtin, status: 'VERIFIED', product: publicSealed(cat.byId.get(verifiedId)), candidates: [] });
    }
    const info = await lookupTitle(gtin);
    if (!info || info.error) return res.status(200).json({ gtin14: gtin, status: 'UNKNOWN', reason: info?.error || 'not_in_public_database', candidates: [] });
    const isPokemon = /pok[eé]mon/i.test(`${info.title} ${info.brand || ''}`);
    const ranked = isPokemon ? rankByTitle(cat.items, info.title) : [];
    const top = ranked[0], second = ranked[1];
    const strong = Boolean(top && top.score >= 0.75 && top.score - (second?.score ?? 0) >= 0.08);
    res.setHeader('Cache-Control', 's-maxage=2592000, stale-while-revalidate=2592000');
    return res.status(200).json({
      gtin14: gtin, status: ranked.length ? 'CANDIDATE' : 'UNMATCHED', strong, title: info.title, titleSource: info.source, pokemon: isPokemon,
      candidates: ranked.map(x => publicSealed(x.it, { matchScore: Math.round(x.score * 100) / 100 })),
    });
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
}
