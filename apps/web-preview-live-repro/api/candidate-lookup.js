// v0.3.1 — Canonical printings matching a printed collector number (and printed total when read).
// Corroboration input only: the Lens never locks from this lookup alone.
import { POOL_LANGS, loadCandidatePool, normalizeNumber, poolUnavailable, publicItem } from './_candidate-pool.js';

export default async function handler(req, res) {
  try {
    const raw = String(req.query.lang || '');
    if (raw === 'auto') return multiLang(req, res);
    const lang = POOL_LANGS.has(raw) ? raw : 'fr';
    const number = String(req.query.number || '').trim();
    const q = String(req.query.q || '').trim();
    if (!number && q.length < 2) return res.status(400).json({ error: 'number or q required' });
    const total = req.query.total != null && req.query.total !== '' ? Number(req.query.total) : null;
    const pool = await loadCandidatePool(lang);
    if (!pool) return poolUnavailable(res, lang);
    // Name search (catalogue): accent/case-insensitive substring over canonical names, newest first.
    if (!number) {
      const needle = fold(q);
      const items = pool.items.filter(item => fold(item.name).includes(needle));
      const exact = items.filter(item => fold(item.name) === needle);
      const ranked = [...exact, ...items.filter(item => fold(item.name) !== needle)];
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      return res.status(200).json({ lang, buildId: pool.buildId, count: ranked.length, truncated: ranked.length > 60, items: ranked.slice(0, 60).map(publicItem) });
    }
    let items = pool.byNumber.get(normalizeNumber(number)) || [];
    if (Number.isFinite(total) && total > 0) items = items.filter(item => item.printedTotal === total || Number(String(item.printedNumber || '').split('/')[1]) === total);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ lang, buildId: pool.buildId, count: items.length, truncated: items.length > 120, items: items.slice(0, 120).map(publicItem) });
  } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
}

// lang=auto: the printed number is looked up in every language pool (camera scan without a
// language choice). Each item keeps its own `lang`.
async function multiLang(req, res) {
  const number = String(req.query.number || '').trim();
  if (!number) return res.status(400).json({ error: 'number required for lang=auto' });
  const total = req.query.total != null && req.query.total !== '' ? Number(req.query.total) : null;
  const all = [];
  for (const lang of POOL_LANGS) {
    const pool = await loadCandidatePool(lang);
    if (!pool) continue;
    let items = pool.byNumber.get(normalizeNumber(number)) || [];
    if (Number.isFinite(total) && total > 0) items = items.filter(item => item.printedTotal === total || Number(String(item.printedNumber || '').split('/')[1]) === total);
    all.push(...items.slice(0, 60).map(publicItem));
  }
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ lang: 'auto', count: all.length, items: all.slice(0, 180) });
}

function fold(value) { return String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim(); }
