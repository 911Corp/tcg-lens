/**
 * v0.3.1 — Coverage audit + visual-index build + live candidate pool export.
 *
 *   DATABASE_URL=... npm run coverage:build -w @tcglens/ingestion-worker -- \
 *     [--as-of=YYYY-MM-DD] [--prerelease] [--out=../../data/reports/coverage-YYYY-MM-DD] \
 *     [--pool-out=../web-preview-live-repro/data]
 *
 * Steps (one transaction for the DB writes):
 *   1. per-printing facts (identity, variants, image probe, conflicts, market mappings, prices)
 *   2. per-set metrics -> readiness (pure policy, market-independent identity/visual level)
 *   3. per-printing pool eligibility -> visual_index_entries
 *   4. coverage_runs / set_coverage rows
 *   5. JSON / Markdown / CSV report + per-language candidate-pool manifests
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  CATALOG_POLICY_VERSION,
  DEFAULT_READINESS_THRESHOLDS,
  READINESS_ORDER,
  applyArtworkTwinPolicy,
  artworkTwinKey,
  computeSetReadiness,
  decidePrintingEligibility,
  releaseStatus,
  type ProductMedium,
  type Readiness,
  type ReleaseStatus,
  type SetCoverageMetrics
} from '../../../packages/ingestion/src/index.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const arg = (name: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const asOf = arg('as-of') ?? new Date().toISOString().slice(0, 10);
const includePrerelease = process.argv.includes('--prerelease');
const outDir = path.resolve(arg('out') ?? `../../data/reports/coverage-${asOf}`);
const poolOut = path.resolve(arg('pool-out') ?? '../web-preview-live-repro/data');
const PRICE_FRESHNESS_DAYS = Number(process.env.PRICE_FRESHNESS_DAYS ?? 14);
const RECENT_DAYS = Number(process.env.RECENT_SET_DAYS ?? 365);

interface PrintingFact {
  entity_id: string;
  set_id: string;
  language_code: string;
  tcgdex_card_id: string | null;
  name: string;
  illustrator: string | null;
  collector_number_raw: string;
  collector_number_normalized: string;
  active_canonical: boolean;
  has_open_conflict: boolean;
  has_market_conflict: boolean;
  variant_count: number;
  image_origin_id: string | null;
  image_url: string | null;
  printed_number?: string | null;
  probe_ok: boolean | null;
  probe_status: number | null;
  cardmarket_verified: string[] | null;
  tcgplayer_verified: string[] | null;
  cardmarket_asserted: string[] | null;
  tcgplayer_asserted: string[] | null;
  priced: boolean;
}

interface SetRow {
  set_id: string;
  language_code: string;
  official_set_code: string | null;
  official_name: string;
  official_abbreviation: string | null;
  series_external_id: string | null;
  series_name: string | null;
  release_date: string | null;
  release_status_override: ReleaseStatus | null;
  product_medium: ProductMedium;
  printed_card_count: number | null;
  total_card_count: number | null;
  source_expected_card_count: number | null;
  quarantined: number;
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  const sets = (await client.query(
    `WITH quarantined AS (
       SELECT cp2.set_id, count(*)::int AS n
         FROM source_records sr JOIN card_printings cp2 ON cp2.entity_id=sr.promoted_entity_id
        WHERE sr.promotion_status='QUARANTINED' GROUP BY cp2.set_id)
     SELECT cs.entity_id AS set_id, cs.language_code, cs.official_set_code, cs.official_name, cs.official_abbreviation,
            cs.series_external_id, cs.series_name, to_char(cs.release_date,'YYYY-MM-DD') AS release_date,
            cs.release_status_override, cs.product_medium, cs.printed_card_count, cs.total_card_count, cs.source_expected_card_count,
            COALESCE(q.n, 0) AS quarantined
       FROM card_sets cs
       JOIN catalog_entities ce ON ce.entity_id=cs.entity_id AND ce.status='ACTIVE'
       LEFT JOIN quarantined q ON q.set_id=cs.entity_id`
  )).rows as SetRow[];

  // Set-based aggregation (no per-printing correlated subqueries; scales to the full catalog).
  const facts = (await client.query(
    `WITH src AS (SELECT source_code, source_id FROM data_sources WHERE source_code IN ('tcgdex','cardmarket','tcgplayer')),
          td AS (SELECT source_id FROM src WHERE source_code='tcgdex'),
          -- Identity conflicts only. Market-mapping conflicts (EXTERNAL_ID_COLLISION from marketplace
          -- enrichment, MARKET_*) must never remove a printing from the identity candidate pool.
          open_conflicts AS (SELECT DISTINCT unnest(entity_ids) AS entity_id FROM data_conflicts
                              WHERE status='OPEN' AND conflict_type NOT LIKE 'MARKET\\_%' AND conflict_type <> 'EXTERNAL_ID_COLLISION'),
          market_conflicts AS (SELECT DISTINCT unnest(entity_ids) AS entity_id FROM data_conflicts
                              WHERE status='OPEN' AND (conflict_type LIKE 'MARKET\\_%' OR conflict_type = 'EXTERNAL_ID_COLLISION')),
          ext AS (
            SELECT ei.entity_id,
                   min(ei.external_value) FILTER (WHERE s.source_code='tcgdex' AND ei.namespace='cards') AS tcgdex_card_id,
                   array_agg(DISTINCT ei.external_value) FILTER (WHERE s.source_code='cardmarket' AND ei.namespace='products' AND ei.verified) AS cardmarket_verified,
                   array_agg(DISTINCT ei.external_value) FILTER (WHERE s.source_code='tcgplayer' AND ei.namespace='products' AND ei.verified) AS tcgplayer_verified
              FROM external_identifiers ei JOIN src s ON s.source_id=ei.source_id
             GROUP BY ei.entity_id),
          variants AS (
            SELECT cv.printing_id AS entity_id, count(DISTINCT cv.entity_id)::int AS variant_count,
                   array_agg(DISTINCT sa.value_json #>> '{}') FILTER (WHERE sa.field_path='tcgdex_asserted_cardmarket_product_id') AS cardmarket_asserted,
                   array_agg(DISTINCT sa.value_json #>> '{}') FILTER (WHERE sa.field_path='tcgdex_asserted_tcgplayer_product_id') AS tcgplayer_asserted
              FROM card_variants cv
              LEFT JOIN source_assertions sa ON sa.entity_id=cv.entity_id AND sa.status='ACTIVE'
                   AND sa.field_path IN ('tcgdex_asserted_cardmarket_product_id','tcgdex_asserted_tcgplayer_product_id')
             GROUP BY cv.printing_id),
          priced AS (
            SELECT DISTINCT entity_id FROM market_observations
             WHERE observed_at >= ($1::date - ($2::text || ' days')::interval) AND observed_at < ($1::date + interval '1 day')),
          -- v0.3.6: TCGdex reference first; a TCGplayer product image (gap import) when TCGdex has
          -- none or its image probes broken.
          tp AS (SELECT source_id FROM src WHERE source_code='tcgplayer'),
          ref_image AS (
            SELECT DISTINCT ON (ei.entity_id) ei.entity_id, io.image_origin_id, io.source_url
              FROM entity_images ei JOIN image_origins io ON io.image_id=ei.image_id
              LEFT JOIN image_probes ipr ON ipr.image_origin_id=io.image_origin_id
             WHERE ei.role='REFERENCE' AND (io.source_id IN (SELECT source_id FROM td) OR io.source_id IN (SELECT source_id FROM tp))
             ORDER BY ei.entity_id, (ipr.ok IS FALSE), (io.source_id IN (SELECT source_id FROM td)) DESC, io.first_seen_at),
          printed AS (
            SELECT DISTINCT ON (entity_id) entity_id, value_json #>> '{}' AS printed_number
              FROM source_assertions WHERE field_path='tcgplayer_printed_number' AND status='ACTIVE'
             ORDER BY entity_id, last_seen_at DESC)
     SELECT cp.entity_id, cp.set_id, cs.language_code, cp.name, cp.illustrator, cp.collector_number_raw, cp.collector_number_normalized,
            ext.tcgdex_card_id,
            (ce.status='ACTIVE' AND ce.resolution_state='CANONICAL') AS active_canonical,
            (oc.entity_id IS NOT NULL) AS has_open_conflict,
            (mc.entity_id IS NOT NULL) AS has_market_conflict,
            COALESCE(v.variant_count, 0) AS variant_count,
            ri.image_origin_id, ri.source_url AS image_url, ip.ok AS probe_ok, ip.http_status AS probe_status,
            ext.cardmarket_verified, ext.tcgplayer_verified, v.cardmarket_asserted, v.tcgplayer_asserted,
            (pr.entity_id IS NOT NULL) AS priced, pn.printed_number
       FROM card_printings cp
       JOIN card_sets cs ON cs.entity_id=cp.set_id
       JOIN catalog_entities ce ON ce.entity_id=cp.entity_id
       LEFT JOIN ext ON ext.entity_id=cp.entity_id
       LEFT JOIN variants v ON v.entity_id=cp.entity_id
       LEFT JOIN open_conflicts oc ON oc.entity_id=cp.entity_id
       LEFT JOIN market_conflicts mc ON mc.entity_id=cp.entity_id
       LEFT JOIN priced pr ON pr.entity_id=cp.entity_id
       LEFT JOIN ref_image ri ON ri.entity_id=cp.entity_id
       LEFT JOIN printed pn ON pn.entity_id=cp.entity_id
       LEFT JOIN image_probes ip ON ip.image_origin_id=ri.image_origin_id
      WHERE ce.status <> 'MERGED'`,
    [asOf, String(PRICE_FRESHNESS_DAYS)]
  )).rows as PrintingFact[];

  const factsBySet = new Map<string, PrintingFact[]>();
  for (const f of facts) {
    const list = factsBySet.get(f.set_id) ?? [];
    list.push(f);
    factsBySet.set(f.set_id, list);
  }

  // ---------------------------------------------------------------- per-set readiness
  interface SetResult {
    set: SetRow; status: ReleaseStatus; metrics: SetCoverageMetrics & Record<string, number | null>;
    readiness: Readiness; identityVisualReadiness: Readiness; blockers: string[]; ratios: Record<string, number | null>;
    missingImages: string[];
  }
  const setResults = new Map<string, SetResult>();
  for (const set of sets) {
    const list = factsBySet.get(set.set_id) ?? [];
    const status = releaseStatus(set.release_date, set.release_status_override, asOf);
    const indexable = (f: PrintingFact) => decidePrintingEligibility({
      productMedium: set.product_medium, releaseStatus: 'RELEASED', entityActiveCanonical: f.active_canonical,
      hasOpenConflict: f.has_open_conflict, imageProbeOk: f.probe_ok, hasReferenceImage: Boolean(f.image_origin_id), setIdentityVisualReadiness: 'VISUAL_COMPLETE'
    }).indexable;
    const assertedCm = list.filter(f => f.cardmarket_asserted?.length).length;
    const agreeCm = list.filter(f => f.cardmarket_asserted?.length && f.cardmarket_verified?.length && f.cardmarket_verified.some(v => f.cardmarket_asserted!.includes(v))).length;
    const disagreeCm = list.filter(f => f.cardmarket_asserted?.length && f.cardmarket_verified?.length && !f.cardmarket_verified.some(v => f.cardmarket_asserted!.includes(v))).length;
    const assertedTp = list.filter(f => f.tcgplayer_asserted?.length).length;
    const agreeTp = list.filter(f => f.tcgplayer_asserted?.length && f.tcgplayer_verified?.length && f.tcgplayer_verified.some(v => f.tcgplayer_asserted!.includes(v))).length;
    const disagreeTp = list.filter(f => f.tcgplayer_asserted?.length && f.tcgplayer_verified?.length && !f.tcgplayer_verified.some(v => f.tcgplayer_asserted!.includes(v))).length;
    const metrics = {
      expectedCards: set.source_expected_card_count ?? set.total_card_count ?? null,
      canonicalPrintings: list.filter(f => f.active_canonical).length,
      collectorNumberCovered: list.filter(f => f.active_canonical && f.collector_number_normalized).length,
      variantsCovered: list.filter(f => f.active_canonical && f.variant_count > 0).length,
      imagesListed: list.filter(f => f.image_origin_id).length,
      imagesProbed: list.filter(f => f.image_origin_id && f.probe_ok !== null).length,
      imagesOk: list.filter(f => f.probe_ok === true).length,
      visualIndexEligible: list.filter(indexable).length,
      cardmarketMapped: list.filter(f => f.cardmarket_verified?.length).length,
      tcgplayerMapped: list.filter(f => f.tcgplayer_verified?.length).length,
      priced: list.filter(f => f.priced).length,
      openConflicts: list.filter(f => f.has_open_conflict).length,
      quarantinedRecords: set.quarantined,
      marketMappingConflicts: list.filter(f => f.has_market_conflict).length,
      variantRows: list.reduce((n, f) => n + f.variant_count, 0),
      cardmarketAssertedByTcgdex: assertedCm, cardmarketAssertionAgrees: agreeCm, cardmarketAssertionDisagrees: disagreeCm,
      tcgplayerAssertedByTcgdex: assertedTp, tcgplayerAssertionAgrees: agreeTp, tcgplayerAssertionDisagrees: disagreeTp
    };
    const r = computeSetReadiness({ metrics, releaseStatus: status, productMedium: set.product_medium, thresholds: DEFAULT_READINESS_THRESHOLDS });
    const blockers = [...r.blockers];
    if (disagreeCm) blockers.push(`CARDMARKET_MAPPING_DISAGREES_WITH_TCGDEX:${disagreeCm}`);
    if (disagreeTp) blockers.push(`TCGPLAYER_MAPPING_DISAGREES_WITH_TCGDEX:${disagreeTp}`);
    const missingImages = list.filter(f => f.probe_ok !== true).map(f => f.tcgdex_card_id ?? f.collector_number_raw).sort();
    setResults.set(set.set_id, { set, status, metrics, readiness: r.readiness, identityVisualReadiness: r.identityVisualReadiness, blockers, ratios: r.ratios, missingImages });
  }

  // Upcoming sets already listed by external sources (e.g. TCGplayer groups via TCGCSV). Products of
  // these groups are never promoted to canonical printings and never enter the live pool.
  const externalUpcoming = (await client.query(
    `SELECT sr.scope_language_code AS lang, sr.external_key AS group_id, sr.normalized_payload->>'name' AS name,
            sr.normalized_payload->>'abbreviation' AS abbreviation, left(sr.normalized_payload->>'publishedOn',10) AS published_on,
            (SELECT count(*)::int FROM source_records p WHERE p.source_id=sr.source_id AND p.namespace='products'
                AND p.scope_language_code=sr.scope_language_code AND (p.normalized_payload->>'groupId')=sr.external_key) AS products_staged,
            (SELECT count(*)::int FROM source_records p WHERE p.source_id=sr.source_id AND p.namespace='products'
                AND p.scope_language_code=sr.scope_language_code AND (p.normalized_payload->>'groupId')=sr.external_key
                AND p.promotion_status='CANONICAL' AND EXISTS (SELECT 1 FROM card_printings cp WHERE cp.entity_id=p.promoted_entity_id)) AS printings_promoted,
            (SELECT count(*)::int FROM source_records p WHERE p.source_id=sr.source_id AND p.namespace='products'
                AND p.scope_language_code=sr.scope_language_code AND (p.normalized_payload->>'groupId')=sr.external_key
                AND p.promotion_status='CANONICAL' AND EXISTS (SELECT 1 FROM sealed_products sp WHERE sp.entity_id=p.promoted_entity_id)) AS sealed_promoted
       FROM source_records sr JOIN data_sources ds ON ds.source_id=sr.source_id AND ds.source_code='tcgcsv'
      WHERE sr.namespace='groups' AND left(sr.normalized_payload->>'publishedOn',10) > $1
      ORDER BY published_on`, [asOf]
  )).rows as Array<{ lang: string; group_id: string; name: string; abbreviation: string | null; published_on: string; products_staged: number; printings_promoted: number; sealed_promoted: number }>;

  // ---------------------------------------------------------------- DB writes
  await client.query('BEGIN');
  const build = await client.query(
    `INSERT INTO visual_index_builds(build_label,as_of,include_prerelease,descriptor_kind,descriptor_version,policy)
     VALUES ($1,$2,$3,'REFERENCE_IMAGE_URL','tcgdex-low-webp-v1',$4::jsonb) RETURNING build_id`,
    [`pool-${asOf}${includePrerelease ? '-prerelease' : ''}`, asOf, includePrerelease,
     JSON.stringify({ catalogPolicy: CATALOG_POLICY_VERSION, thresholds: DEFAULT_READINESS_THRESHOLDS, note: 'Embeddings are computed on-device from these reference images; no server-side descriptor yet (v0.4).' })]
  );
  const buildId = build.rows[0].build_id as string;

  interface PoolItem {
    id: string; entityId: string; name: string; localId: string; printedTotal: number | null; lang: string;
    setId: string | null; setName: string; setAbbreviation: string | null; releaseDate: string | null;
    image: string; printedNumber?: string; setReadiness: Readiness; visualOnlyLockAllowed: boolean;
    lockBlockedReason: string | null; artworkTwins: number;
  }
  // Eligibility for every printing, then artwork-twin groups (same language + name + illustrator).
  const eligibilityById = new Map<string, ReturnType<typeof decidePrintingEligibility>>();
  for (const f of facts) {
    const sr = setResults.get(f.set_id);
    if (!sr) continue;
    eligibilityById.set(f.entity_id, decidePrintingEligibility({
      productMedium: sr.set.product_medium, releaseStatus: sr.status, entityActiveCanonical: f.active_canonical,
      hasOpenConflict: f.has_open_conflict, imageProbeOk: f.probe_ok, hasReferenceImage: Boolean(f.image_origin_id), setIdentityVisualReadiness: sr.identityVisualReadiness, includePrerelease
    }));
  }
  const twinGroups = new Map<string, PrintingFact[]>();
  for (const f of facts) {
    const sr = setResults.get(f.set_id);
    if (!sr || sr.set.product_medium !== 'PHYSICAL' || !f.active_canonical) continue;
    const key = artworkTwinKey({ languageCode: f.language_code, name: f.name, illustrator: f.illustrator });
    if (!key) continue;
    const list = twinGroups.get(key) ?? [];
    list.push(f);
    twinGroups.set(key, list);
  }
  // v0.3.6: a printing is visually covered when any printing of the same TCGdex card (shared id, same
  // artwork — e.g. the English version of a French card) is in the live pool, since the Lens matches
  // printing families by that id.
  const familyIndexed = new Set<string>();
  for (const f of facts) if (f.tcgdex_card_id && eligibilityById.get(f.entity_id)?.inLivePool) familyIndexed.add(f.tcgdex_card_id);
  const visuallyCovered = (x: PrintingFact) => Boolean(eligibilityById.get(x.entity_id)?.inLivePool) || Boolean(x.tcgdex_card_id && familyIndexed.has(x.tcgdex_card_id));
  const twinsOf = (f: PrintingFact) => {
    const key = artworkTwinKey({ languageCode: f.language_code, name: f.name, illustrator: f.illustrator });
    const group = key ? (twinGroups.get(key) ?? []).filter(x => x.entity_id !== f.entity_id) : [];
    return { total: group.length, unindexed: group.filter(x => !visuallyCovered(x)).length };
  };
  let lockBlockedCount = 0;

  const poolByLang = new Map<string, PoolItem[]>();
  const exclusionCounts = new Map<string, number>();
  let poolCount = 0, visualOnlyCount = 0;
  const entryBatch: unknown[][] = [];
  const flush = async () => {
    if (!entryBatch.length) return;
    const values: unknown[] = [];
    const tuples = entryBatch.map((row, i) => {
      values.push(...row);
      const o = i * 10;
      return `(${Array.from({ length: 10 }, (_, k) => `$${o + k + 1}`).join(',')})`;
    });
    await client.query(
      `INSERT INTO visual_index_entries(build_id,entity_id,set_id,language_code,image_origin_id,eligible,exclusion_reason,visual_only_lock_allowed,lock_blocked_reason,artwork_twin_count)
       VALUES ${tuples.join(',')}`, values
    );
    entryBatch.length = 0;
  };
  for (const f of facts) {
    const sr = setResults.get(f.set_id);
    if (!sr) continue;
    const e = eligibilityById.get(f.entity_id)!;
    const twins = twinsOf(f);
    const twin = applyArtworkTwinPolicy(e, twins);
    if (twin.lockBlockedReason) lockBlockedCount++;
    entryBatch.push([buildId, f.entity_id, f.set_id, f.language_code, f.image_origin_id, e.inLivePool, e.inLivePool ? null : e.reason ?? 'UNSPECIFIED', twin.visualOnlyLockAllowed, twin.lockBlockedReason, twins.total]);
    if (entryBatch.length >= 500) await flush();
    if (!e.inLivePool) { exclusionCounts.set(e.reason ?? 'UNSPECIFIED', (exclusionCounts.get(e.reason ?? 'UNSPECIFIED') ?? 0) + 1); continue; }
    poolCount++;
    if (twin.visualOnlyLockAllowed) visualOnlyCount++;
    const list = poolByLang.get(f.language_code) ?? [];
    list.push({
      id: f.tcgdex_card_id ?? f.entity_id, entityId: f.entity_id, name: f.name, localId: f.collector_number_raw,
      printedTotal: sr.set.printed_card_count, lang: f.language_code, setId: sr.set.official_set_code, setName: sr.set.official_name,
      setAbbreviation: sr.set.official_abbreviation, releaseDate: sr.set.release_date,
      image: /\.(webp|png|jpe?g)$/i.test(f.image_url as string) ? (f.image_url as string) : `${(f.image_url as string).replace(/\/$/, '')}/low.webp`,
      ...(f.printed_number ? { printedNumber: f.printed_number } : {}), setReadiness: sr.readiness, visualOnlyLockAllowed: twin.visualOnlyLockAllowed,
      lockBlockedReason: twin.lockBlockedReason, artworkTwins: twins.total
    });
    poolByLang.set(f.language_code, list);
  }
  await flush();
  await client.query(`UPDATE visual_index_builds SET stats=$2::jsonb WHERE build_id=$1`, [buildId, JSON.stringify({
    printings: facts.length, inLivePool: poolCount, visualOnlyLockAllowed: visualOnlyCount, lockBlockedByUnindexedTwin: lockBlockedCount, exclusions: Object.fromEntries(exclusionCounts)
  })]);

  const coverage = await client.query(
    `INSERT INTO coverage_runs(as_of,visual_index_build_id,thresholds) VALUES ($1,$2,$3::jsonb) RETURNING coverage_run_id`,
    [asOf, buildId, JSON.stringify({ ...DEFAULT_READINESS_THRESHOLDS, priceFreshnessDays: PRICE_FRESHNESS_DAYS, policy: CATALOG_POLICY_VERSION })]
  );
  const coverageRunId = coverage.rows[0].coverage_run_id as string;
  for (const sr of setResults.values()) {
    await client.query(
      `INSERT INTO set_coverage(coverage_run_id,set_id,language_code,release_status,product_medium,readiness,metrics,blockers)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [coverageRunId, sr.set.set_id, sr.set.language_code, sr.status, sr.set.product_medium, sr.readiness, JSON.stringify({ ...sr.metrics, ratios: sr.ratios, identityVisualReadiness: sr.identityVisualReadiness }), sr.blockers]
    );
  }

  // ---------------------------------------------------------------- summaries
  const languages = [...new Set(sets.map(s => s.language_code))].sort();
  const summary: Record<string, unknown> = { asOf, includePrerelease, buildId, coverageRunId, policy: CATALOG_POLICY_VERSION, thresholds: DEFAULT_READINESS_THRESHOLDS, priceFreshnessDays: PRICE_FRESHNESS_DAYS, languages: {} };
  for (const lang of languages) {
    const rs = [...setResults.values()].filter(r => r.set.language_code === lang);
    const sum = (k: keyof SetCoverageMetrics | string) => rs.reduce((n, r) => n + Number((r.metrics as Record<string, number | null>)[k] ?? 0), 0);
    const physical = rs.filter(r => r.set.product_medium === 'PHYSICAL');
    const psum = (k: string) => physical.reduce((n, r) => n + Number((r.metrics as Record<string, number | null>)[k] ?? 0), 0);
    const readiness: Record<string, number> = {};
    for (const level of READINESS_ORDER) readiness[level] = rs.filter(r => r.readiness === level).length;
    (summary.languages as Record<string, unknown>)[lang] = {
      sets: rs.length, physicalSets: physical.length, digitalOnlySets: rs.length - physical.length,
      upcomingSets: rs.filter(r => r.status === 'UPCOMING').map(r => r.set.official_set_code),
      unknownReleaseSets: rs.filter(r => r.status === 'UNKNOWN').length,
      readiness,
      physical: {
        expectedCards: psum('expectedCards'), canonicalPrintings: psum('canonicalPrintings'), variantsCovered: psum('variantsCovered'), variantRows: psum('variantRows'),
        imagesListed: psum('imagesListed'), imagesProbed: psum('imagesProbed'), imagesOk: psum('imagesOk'), visualIndexEligible: psum('visualIndexEligible'),
        cardmarketMapped: psum('cardmarketMapped'), tcgplayerMapped: psum('tcgplayerMapped'), priced: psum('priced'), openConflicts: psum('openConflicts'),
        cardmarketAssertionDisagrees: psum('cardmarketAssertionDisagrees'), tcgplayerAssertionDisagrees: psum('tcgplayerAssertionDisagrees')
      },
      allCanonicalPrintings: sum('canonicalPrintings'),
      livePool: poolByLang.get(lang)?.length ?? 0,
      livePoolVisualOnlyLockAllowed: (poolByLang.get(lang) ?? []).filter(x => x.visualOnlyLockAllowed).length,
      livePoolLockBlocked: (poolByLang.get(lang) ?? []).filter(x => x.lockBlockedReason).length
    };
  }
  summary.externalUpcomingSets = externalUpcoming;
  summary.livePool = { total: poolCount, visualOnlyLockAllowed: visualOnlyCount, lockBlockedByUnindexedTwin: lockBlockedCount, exclusions: Object.fromEntries(exclusionCounts) };
  await client.query(`UPDATE coverage_runs SET summary=$2::jsonb WHERE coverage_run_id=$1`, [coverageRunId, JSON.stringify(summary)]);
  await client.query('COMMIT');

  // ---------------------------------------------------------------- files
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(poolOut, { recursive: true });
  const setRows = [...setResults.values()].sort((a, b) =>
    a.set.language_code.localeCompare(b.set.language_code) || String(b.set.release_date ?? '').localeCompare(String(a.set.release_date ?? '')) || String(a.set.official_set_code).localeCompare(String(b.set.official_set_code)));
  const setJson = setRows.map(r => ({
    lang: r.set.language_code, setId: r.set.official_set_code, name: r.set.official_name, series: r.set.series_external_id, abbreviation: r.set.official_abbreviation,
    releaseDate: r.set.release_date, releaseStatus: r.status, medium: r.set.product_medium, readiness: r.readiness, identityVisualReadiness: r.identityVisualReadiness,
    metrics: r.metrics, ratios: r.ratios, blockers: r.blockers, missingOrBrokenImages: r.missingImages.slice(0, 400)
  }));
  await fs.writeFile(path.join(outDir, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(outDir, 'coverage-by-set.json'), JSON.stringify(setJson, null, 2));

  const csvCols = ['lang', 'setId', 'name', 'series', 'releaseDate', 'releaseStatus', 'medium', 'readiness', 'expectedCards', 'canonicalPrintings', 'variantsCovered', 'imagesListed', 'imagesOk', 'visualIndexEligible', 'cardmarketMapped', 'tcgplayerMapped', 'priced', 'openConflicts', 'blockers'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [csvCols.join(',')].concat(setRows.map(r => [
    r.set.language_code, r.set.official_set_code, r.set.official_name, r.set.series_external_id, r.set.release_date, r.status, r.set.product_medium, r.readiness,
    r.metrics.expectedCards, r.metrics.canonicalPrintings, r.metrics.variantsCovered, r.metrics.imagesListed, r.metrics.imagesOk, r.metrics.visualIndexEligible,
    r.metrics.cardmarketMapped, r.metrics.tcgplayerMapped, r.metrics.priced, r.metrics.openConflicts, r.blockers.join(' | ')
  ].map(esc).join(',')));
  await fs.writeFile(path.join(outDir, 'coverage-by-set.csv'), csv.join('\n') + '\n');

  const pct = (n: number | null | undefined) => n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`;
  const md: string[] = [`# TCG Lens coverage report — as of ${asOf}`, '', `Policy \`${CATALOG_POLICY_VERSION}\`; visual-index build \`${buildId}\`; prerelease mode: ${includePrerelease}.`, ''];
  md.push('| Lang | Sets (phys/digital) | Printings (phys) | Images OK | Visual-indexed | Variants | Cardmarket | TCGplayer | Priced | Live pool | Visual-only lockable |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const lang of languages) {
    const s = (summary.languages as Record<string, any>)[lang];
    const p = s.physical;
    md.push(`| ${lang} | ${s.physicalSets}/${s.digitalOnlySets} | ${p.canonicalPrintings} | ${pct(p.imagesOk / (p.canonicalPrintings || 1))} | ${pct(p.visualIndexEligible / (p.canonicalPrintings || 1))} | ${pct(p.variantsCovered / (p.canonicalPrintings || 1))} | ${pct(p.cardmarketMapped / (p.canonicalPrintings || 1))} | ${pct(p.tcgplayerMapped / (p.canonicalPrintings || 1))} | ${pct(p.priced / (p.canonicalPrintings || 1))} | ${s.livePool} | ${s.livePoolVisualOnlyLockAllowed} |`);
  }
  md.push('', '## Readiness by language', '', `| Lang | ${READINESS_ORDER.join(' | ')} |`, `|---|${READINESS_ORDER.map(() => '---').join('|')}|`);
  for (const lang of languages) {
    const s = (summary.languages as Record<string, any>)[lang];
    md.push(`| ${lang} | ${READINESS_ORDER.map(l => s.readiness[l]).join(' | ')} |`);
  }
  const recentCutoff = new Date(Date.parse(asOf) - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  md.push('', `## Latest physical sets (released since ${recentCutoff}, plus staged)`, '', '| Lang | Set | Name | Release | Status | Readiness | Printings/expected | Images OK | CM | TP | Priced | Blockers |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of setRows.filter(r => r.set.product_medium === 'PHYSICAL' && ((r.set.release_date ?? '') >= recentCutoff || r.status !== 'RELEASED'))) {
    md.push(`| ${r.set.language_code} | ${r.set.official_set_code} | ${r.set.official_name} | ${r.set.release_date ?? '?'} | ${r.status} | **${r.readiness}** | ${r.metrics.canonicalPrintings}/${r.metrics.expectedCards ?? '?'} | ${pct(r.ratios.imagesOk)} | ${pct(r.ratios.cardmarket)} | ${pct(r.ratios.tcgplayer)} | ${pct(r.ratios.priced)} | ${r.blockers.slice(0, 4).join('; ')} |`);
  }
  md.push('', '## Upcoming sets listed by external sources (staged, excluded from the live pool)', '', '| Lang | Source group | Name | Abbrev. | Release | Products staged | Card printings promoted | Sealed products catalogued |', '|---|---|---|---|---|---|---|---|');
  for (const u of externalUpcoming) md.push(`| ${u.lang} | tcgplayer:${u.group_id} | ${u.name} | ${u.abbreviation ?? ''} | ${u.published_on} | ${u.products_staged} | ${u.printings_promoted} | ${u.sealed_promoted} |`);
  if (!externalUpcoming.length) md.push('| - | - | none | - | - | - | - | - |');
  md.push('', 'Card printings of upcoming sets must stay at 0. Sealed pre-order products are catalogued for the market layer only; sealed release staging is not modelled yet (sealed scanning is out of scope).');
  md.push('', '## Artwork-twin lock blocks', '', `${lockBlockedCount} pool printings share name + illustrator with a printing that has no usable reference image (e.g. 30th-c Classic Collection reprints). They stay in the pool but can never lock until the twin is indexed.`, '');
  for (const lang of languages) {
    const blocked = (poolByLang.get(lang) ?? []).filter(x => x.lockBlockedReason);
    if (blocked.length) md.push(`- ${lang}: ${blocked.length} (e.g. ${blocked.slice(0, 6).map(x => `${x.setId} #${x.localId} ${x.name}`).join(', ')})`);
  }
  md.push('', '## Live-pool exclusions', '', ...[...exclusionCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- \`${k}\`: ${v}`));
  md.push('', 'Market coverage never affects pool membership or visual-only lock permission (identity/visual metrics only).');
  await fs.writeFile(path.join(outDir, 'COVERAGE_REPORT.md'), md.join('\n') + '\n');

  for (const [lang, items] of poolByLang) {
    items.sort((a, b) => String(b.releaseDate ?? '').localeCompare(String(a.releaseDate ?? '')) || String(a.setId).localeCompare(String(b.setId)) || a.localId.localeCompare(b.localId, undefined, { numeric: true }));
    await fs.writeFile(path.join(poolOut, `candidate-pool-${lang}.json`), JSON.stringify({
      schema: 'tcg-lens-candidate-pool-v1', asOf, buildId, coverageRunId, includePrerelease, policy: CATALOG_POLICY_VERSION, lang, count: items.length, items
    }));
  }
  console.log(md.slice(0, 20).join('\n'));
  console.log(`\nreport: ${outDir}\npool: ${poolOut}`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
