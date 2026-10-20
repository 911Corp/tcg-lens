// v0.3.1 — Canonical candidate pool loader (built by apps/ingestion coverage:build).
// The live pool is never read from raw TCGdex: it contains only released, physical, canonical,
// conflict-free printings with a probed-OK reference image. Upcoming sets are staged out.
import fs from 'node:fs/promises';

export const POOL_LANGS = new Set(['fr', 'en', 'ja']);
const cache = new Map();
export function clearCandidatePoolCache() { cache.clear(); }

export async function loadCandidatePool(lang) {
  if (!POOL_LANGS.has(lang)) return null;
  if (cache.has(lang)) return cache.get(lang);
  try {
    const dir = process.env.TCG_LENS_POOL_DIR;
    const target = dir ? `${dir.replace(/\/$/, '')}/candidate-pool-${lang}.json` : new URL(`../data/candidate-pool-${lang}.json`, import.meta.url);
    const pool = JSON.parse(await fs.readFile(target, 'utf8'));
    if (pool?.schema !== 'tcg-lens-candidate-pool-v1' || !Array.isArray(pool.items)) return null;
    const byNumber = new Map();
    for (const item of pool.items) {
      // Index by the number printed on the card too (Classic Collection "4/102").
      const printed = item.printedNumber ? normalizeNumber(String(item.printedNumber).split('/')[0]) : null;
      if (printed && printed !== normalizeNumber(item.localId)) { if (!byNumber.has(printed)) byNumber.set(printed, []); byNumber.get(printed).push(item); }
      const key = normalizeNumber(item.localId);
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(item);
    }
    const loaded = { ...pool, byNumber };
    cache.set(lang, loaded);
    return loaded;
  } catch {
    return null;
  }
}

export function normalizeNumber(value) {
  const s = String(value ?? '').trim().toUpperCase();
  const m = s.match(/^([A-Z]{0,4})0*(\d{1,4})([A-Z]?)$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : s.replace(/\s+/g, '');
}

export function publicItem(item) {
  return {
    id: item.id, entityId: item.entityId, name: item.name, localId: item.localId, printedTotal: item.printedTotal, printedNumber: item.printedNumber || null,
    lang: item.lang, setId: item.setId, setName: item.setName, setAbbreviation: item.setAbbreviation,
    releaseDate: item.releaseDate, image: item.image, setReadiness: item.setReadiness, visualOnlyLockAllowed: item.visualOnlyLockAllowed === true,
    lockBlockedReason: item.lockBlockedReason || null, artworkTwins: item.artworkTwins ?? 0,
  };
}

export function poolUnavailable(res, lang) {
  return res.status(503).json({ error: 'candidate_pool_unavailable', lang, hint: 'run npm run build:coverage to export the canonical candidate pool' });
}
