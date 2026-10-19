/**
 * v0.3.1 end-to-end: snapshot import -> image probes -> coverage build -> candidate pool export.
 * Requires TEST_DATABASE_URL pointing at a migrated (0001-0008) database. Offline: probes are
 * written directly instead of performing HTTP HEAD requests.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP v031-pipeline-postgres.integration: TEST_DATABASE_URL is not set');
  process.exit(0);
}
const here = path.resolve('test');
const snapshot = path.join(here, 'fixtures', 'v031-snapshot');
const out = path.join(here, '..', '..', '..', '.tmp-v031-it');
const run = (script: string, args: string[]) =>
  execFileSync('npx', ['tsx', script, ...args], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }).toString();

const pool = new pg.Pool({ connectionString: url });
try {
  run('src/tcgdex-import.ts', ['en', `--snapshot=${snapshot}`]);
  // Re-import must be idempotent (no new printings / variants).
  const second = run('src/tcgdex-import.ts', ['en', `--snapshot=${snapshot}`]);
  assert.match(second, /0 new, 8 matched, 0 conflicts, 0 fetch failures, 0 variants/);

  const sets = (await pool.query(
    `SELECT official_set_code, product_medium, to_char(release_date,'YYYY-MM-DD') AS release_date, source_expected_card_count
       FROM card_sets WHERE official_set_code LIKE 'it%' AND language_code='en' ORDER BY 1`
  )).rows;
  assert.deepEqual(sets.map((s: any) => [s.official_set_code, s.product_medium, s.release_date]), [
    ['itgap', 'PHYSICAL', '2026-09-16'], ['itnext', 'PHYSICAL', '2026-11-06'], ['itpocket', 'DIGITAL_ONLY', '2026-08-01'], ['itrel', 'PHYSICAL', '2026-09-16']
  ]);
  const variants = (await pool.query(
    `SELECT count(*)::int AS n FROM card_variants cv JOIN card_printings cp ON cp.entity_id=cv.printing_id JOIN card_sets cs ON cs.entity_id=cp.set_id WHERE cs.official_set_code LIKE 'it%'`
  )).rows[0].n;
  assert.equal(variants, 8);

  // Offline probes: every listed image OK.
  await pool.query(
    `INSERT INTO image_probes(image_origin_id,probe_url,http_status,content_type,content_length,ok)
     SELECT io.image_origin_id, io.source_url || '/low.webp', 200, 'image/webp', 20000, true
       FROM image_origins io WHERE io.source_url LIKE 'https://assets.tcgdex.net/en/%/it%'
     ON CONFLICT (image_origin_id) DO UPDATE SET ok=true`
  );

  run('src/coverage-build.ts', ['--as-of=2026-10-20', `--out=${out}/report`, `--pool-out=${out}/pool`]);
  const poolFile = JSON.parse(await fs.readFile(path.join(out, 'pool', 'candidate-pool-en.json'), 'utf8'));
  const items = poolFile.items.filter((x: any) => String(x.setId).startsWith('it'));
  const byId = Object.fromEntries(items.map((x: any) => [x.id, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['itgap-001', 'itrel-001', 'itrel-002'], 'only released physical printings with usable images');
  assert.equal(byId['itrel-001'].visualOnlyLockAllowed, true, 'complete released set may lock visual-only');
  assert.equal(byId['itrel-001'].printedTotal, 2);
  assert.equal(byId['itrel-001'].setAbbreviation, 'ITR');
  assert.equal(byId['itgap-001'].visualOnlyLockAllowed, false, 'a set with a missing image never permits visual-only locks');

  const coverage = JSON.parse(await fs.readFile(path.join(out, 'report', 'coverage-by-set.json'), 'utf8'));
  const bySet = Object.fromEntries(coverage.filter((x: any) => String(x.setId).startsWith('it')).map((x: any) => [x.setId, x]));
  assert.equal(bySet.itrel.identityVisualReadiness, 'VISUAL_COMPLETE');
  assert.equal(bySet.itgap.readiness, 'IDENTITY_COMPLETE');
  assert.ok(bySet.itgap.blockers.includes('MISSING_OR_BROKEN_IMAGES:1'));
  assert.equal(bySet.itnext.releaseStatus, 'UPCOMING');
  assert.ok(bySet.itnext.blockers.includes('RELEASE_STATUS:UPCOMING'));
  assert.equal(bySet.itpocket.readiness, 'EXCLUDED');

  const entries = (await pool.query(
    `SELECT vie.exclusion_reason, count(*)::int AS n FROM visual_index_entries vie
       JOIN card_sets cs ON cs.entity_id=vie.set_id
      WHERE vie.build_id=$1 AND cs.official_set_code LIKE 'it%' GROUP BY 1 ORDER BY 1 NULLS FIRST`, [poolFile.buildId]
  )).rows;
  assert.deepEqual(entries.map((e: any) => [e.exclusion_reason, e.n]), [[null, 3], ['DIGITAL_ONLY_PRODUCT', 2], ['NO_REFERENCE_IMAGE', 1], ['STAGED_UPCOMING', 2]]);
  console.log('PASS v031-pipeline-postgres.integration');
} finally {
  await pool.end();
  await fs.rm(out, { recursive: true, force: true });
}
