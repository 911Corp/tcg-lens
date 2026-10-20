/**
 * v0.3.8 — versioned recognition assets. `data/index-version.json` (content hash of the index files, written
 * by tools/stamp-index-version.mjs at deploy) is fetched network-first; every index request then carries
 * `?v=<hash>`. The service worker keeps those files cache-first, so a new index is downloaded exactly once
 * after an update and old and new files are never mixed (row counts must match across files).
 */
const versions = new Map();

export function indexVersion(base = '/data', fetchImpl = (...a) => fetch(...a)) {
  if (!versions.has(base)) versions.set(base, fetchImpl(`${base}/index-version.json`, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null)).then(j => (typeof j?.version === 'string' ? j.version : null)).catch(() => null));
  return versions.get(base);
}

/** fetch() wrapper adding the index version to requests under `base`. */
export function versionedFetch(base = '/data', fetchImpl = (...a) => fetch(...a)) {
  return async (url, init) => {
    const v = String(url).startsWith(`${base}/`) ? await indexVersion(base, fetchImpl) : null;
    return fetchImpl(v ? `${url}${String(url).includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}` : url, init);
  };
}
