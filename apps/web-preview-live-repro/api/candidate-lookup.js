// v0.3.1 — Canonical printings matching a printed collector number (and printed total when read).
// Corroboration input only: the Lens never locks from this lookup alone.
import { POOL_LANGS, loadCandidatePool, normalizeNumber, poolUnavailable, publicItem } from './_candidate-pool.js';

export default async function handler(req, res) {
  try {
    const lang = POOL_LANGS.has(String(req.query.lang || '')) ? String(req.query.lang) : 'fr';
    const number = String(req.query.number || '').trim();
    if (!number) return res.status(400).json({ error: 'number required' });
    const total = req.query.total != null && req.query.total !== '' ? Number(req.query.total) : null;
    const pool = await loadCandidatePool(lang);
    if (!pool) return poolUnavailable(res, lang);
    let items = pool.byNumber.get(normalizeNumber(number)) || [];
    if (Number.isFinite(total) && total > 0) items = items.filter(item => item.printedTotal === total);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ lang, buildId: pool.buildId, count: items.length, truncated: items.length > 120, items: items.slice(0, 120).map(publicItem) });
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
}
