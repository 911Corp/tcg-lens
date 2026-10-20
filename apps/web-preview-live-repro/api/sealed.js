// Sealed-product search over the canonical catalogue (Cardmarket + TCGplayer, EN/FR/JA):
// ETB, displays, boosters, bundles, tins, blisters, decks, collection boxes…
import { loadSealedCatalog, publicSealed, tokens, fold, TYPE_LABELS } from './_sealed-catalog.js';

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || '');
    const id = String(req.query.id || '');
    const cat = await loadSealedCatalog();
    if (id) {
      const it = cat.byId.get(id);
      return it ? res.status(200).json(publicSealed(it)) : res.status(404).json({ error: 'not found' });
    }
    if (q.length < 2) return res.status(400).json({ error: 'q too short' });
    const qt = tokens(q), fq = fold(q);
    const scored = [];
    for (const it of cat.items) {
      if (type && it.type !== type) continue;
      const all = qt.length ? qt.every(t => it.folded.includes(t)) : it.folded.includes(fq);
      if (!all) continue;
      scored.push({ it, s: (it.folded.startsWith(fq) ? 2 : 0) + (it.cmTrendEur != null || it.tpMarketUsd != null ? 1 : 0) });
    }
    scored.sort((a, b) => b.s - a.s || String(b.it.releaseDate || '').localeCompare(String(a.it.releaseDate || '')));
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ asOf: cat.asOf, count: scored.length, types: TYPE_LABELS, items: scored.slice(0, 40).map(x => publicSealed(x.it)) });
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
}
