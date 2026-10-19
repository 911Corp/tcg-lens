// v0.3.1 — Paged reference cards for the on-device visual index, from the canonical candidate pool.
// Ordered newest release first. Cursor is a plain item offset.
import { POOL_LANGS, loadCandidatePool, poolUnavailable, publicItem } from './_candidate-pool.js';

export default async function handler(req, res) {
  try {
    const lang = POOL_LANGS.has(String(req.query.lang || '')) ? String(req.query.lang) : 'fr';
    const size = Math.max(8, Math.min(80, Number(req.query.size) || 40));
    const offset = Math.max(0, Number.parseInt(String(req.query.cursor || '0'), 10) || 0);
    const pool = await loadCandidatePool(lang);
    if (!pool) return poolUnavailable(res, lang);
    const items = pool.items.slice(offset, offset + size).map(publicItem);
    const next = offset + size < pool.items.length ? String(offset + size) : String(offset + size);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ lang, buildId: pool.buildId, asOf: pool.asOf, total: pool.items.length, cursor: String(offset), nextCursor: next, exhausted: offset + size >= pool.items.length, items });
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
}
