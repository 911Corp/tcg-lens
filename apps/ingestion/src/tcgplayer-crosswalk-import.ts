/**
 * v0.3.1 — TCGplayer crosswalk: TCGdex-asserted TCGplayer productId, verified against products staged
 * by the TCGCSV importer. Then attaches already-staged TCGCSV price records to the new mappings.
 *
 *   DATABASE_URL=... npm run tcgplayer:crosswalk -w @tcglens/ingestion-worker
 *
 * Run after `import:tcgcsv` (products and prices must be staged).
 */
import pg from 'pg';
import { decideTcgplayerCrosswalk, type NormalizedTcgcsvPrice } from '../../../packages/ingestion/src/index.js';
import { persistTcgcsvPrice } from './card-printing-enrichment.js';
import { finishSyncRun, getSourceId, getVenueId, startSyncRun } from './source-record.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
const stats: Record<string, number> = { assertions: 0, autoMatched: 0, candidates: 0, conflicts: 0, priceRecords: 0, observationsWritten: 0 };
const byRule: Record<string, number> = {};

try {
  const tcgcsvSourceId = await getSourceId(pool, 'tcgcsv');
  const tcgplayerSourceId = await getSourceId(pool, 'tcgplayer');
  const venueId = await getVenueId(pool, 'tcgplayer');
  const syncRunId = await startSyncRun(pool, tcgcsvSourceId);

  const rows = (await pool.query(
    `SELECT cp.entity_id, cp.set_id, cs.language_code, cp.name, cp.collector_number_normalized,
            array_agg(DISTINCT (sa.value_json #>> '{}')) AS asserted
       FROM card_printings cp
       JOIN card_sets cs ON cs.entity_id=cp.set_id AND cs.product_medium='PHYSICAL'
       JOIN catalog_entities ce ON ce.entity_id=cp.entity_id AND ce.status='ACTIVE' AND ce.resolution_state='CANONICAL'
       JOIN card_variants cv ON cv.printing_id=cp.entity_id
       JOIN source_assertions sa ON sa.entity_id=cv.entity_id AND sa.field_path='tcgdex_asserted_tcgplayer_product_id' AND sa.status='ACTIVE'
      GROUP BY 1,2,3,4,5`
  )).rows as Array<{ entity_id: string; set_id: string; language_code: string; name: string; collector_number_normalized: string; asserted: string[] }>;

  const products = new Map<string, { source_record_id: string; lang: string; name: string; number: string | null; groupId: number }>();
  for (const p of (await pool.query(
    `SELECT source_record_id, external_key, scope_language_code AS lang, normalized_payload->>'name' AS name,
            normalized_payload->>'collectorNumberNormalized' AS number, (normalized_payload->>'groupId')::int AS group_id
       FROM source_records WHERE source_id=$1 AND namespace='products'`, [tcgcsvSourceId]
  )).rows as any[]) {
    products.set(`${p.lang}|${p.external_key}`, { source_record_id: p.source_record_id, lang: p.lang, name: p.name, number: p.number, groupId: p.group_id });
  }

  const claims = new Map<string, Set<string>>();
  const groups = new Map<string, Map<number, number>>();
  for (const row of rows) for (const id of row.asserted) {
    const key = `${row.language_code}|${id}`;
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key)!.add(row.entity_id);
    const product = products.get(key);
    if (product) {
      const m = groups.get(row.set_id) ?? new Map<number, number>();
      m.set(product.groupId, (m.get(product.groupId) ?? 0) + 1);
      groups.set(row.set_id, m);
    }
  }
  const modeOf = (setId: string) => {
    const m = groups.get(setId); if (!m?.size) return { mode: null as number | null, share: 0 };
    let best: [number, number] = [0, 0], total = 0;
    for (const [k, v] of m) { total += v; if (v > best[1]) best = [k, v]; }
    return { mode: best[0], share: best[1] / total };
  };

  const newlyMapped: Array<{ productId: string; lang: string }> = [];
  for (const row of rows) {
    const { mode, share } = modeOf(row.set_id);
    for (const productId of row.asserted) {
      stats.assertions++;
      const product = products.get(`${row.language_code}|${productId}`) ?? [...['en', 'ja']].map(l => products.get(`${l}|${productId}`)).find(Boolean);
      const decision = decideTcgplayerCrosswalk(
        { entityId: row.entity_id, languageCode: row.language_code, name: row.name, collectorNumber: row.collector_number_normalized },
        product ? { productId: Number(productId), languageCode: product.lang, name: product.name, collectorNumber: product.number, groupId: product.groupId } : undefined,
        { setGroupMode: mode, setGroupModeShare: share, printingsAssertingSameProductInLanguage: claims.get(`${row.language_code}|${productId}`)?.size ?? 0 }
      );
      byRule[decision.ruleId] = (byRule[decision.ruleId] ?? 0) + 1;
      if (decision.status === 'CANDIDATE_MATCH') { stats.candidates++; continue; }
      if (!product) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO resolution_decisions(source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json)
           VALUES ($1,$2,$3,$4,'tcgplayer-crosswalk-v0.3.1',1,$5,$6::jsonb,'[]'::jsonb)`,
          [product.source_record_id, decision.status, decision.status === 'AUTO_MATCH' ? row.entity_id : null, decision.ruleId, decision.confidence,
           JSON.stringify({ enrichment_only: true, printing: row.entity_id, language: row.language_code, tcgdexAsserted: true })]
        );
        if (decision.status === 'AUTO_MATCH') {
          const existing = await client.query(
            `SELECT entity_id FROM external_identifiers WHERE source_id=$1 AND namespace='products' AND scope_language_code=$2 AND external_value=$3`,
            [tcgplayerSourceId, row.language_code, productId]
          );
          if (existing.rows[0] && existing.rows[0].entity_id !== row.entity_id) {
            stats.conflicts++;
            await client.query(
              `INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status)
               SELECT $1,'MARKET_MAPPING_CONFLICT','MEDIUM',ARRAY[$2,$3]::uuid[],$4::jsonb,'OPEN'
                WHERE NOT EXISTS (SELECT 1 FROM data_conflicts WHERE conflict_type='MARKET_MAPPING_CONFLICT' AND status='OPEN' AND source_record_id=$1)`,
              [product.source_record_id, row.entity_id, existing.rows[0].entity_id, JSON.stringify({ ruleId: 'TP_XWALK_EXISTING_MAPPING_DISAGREES', productId })]
            );
          } else {
            if (!existing.rows[0]) newlyMapped.push({ productId, lang: row.language_code });
            stats.autoMatched++;
            await client.query(
              `INSERT INTO source_entity_links(reported_by_source_id,origin_source_id,namespace,external_value,entity_id,scope_language_code,mapping_status,mapping_method,confidence,source_record_id,evidence)
               VALUES ($1,$2,'products',$3,$4,$5,'VERIFIED',$6,$7,$8,$9::jsonb)
               ON CONFLICT(reported_by_source_id,namespace,external_value,entity_id)
               DO UPDATE SET mapping_status='VERIFIED',mapping_method=EXCLUDED.mapping_method,confidence=EXCLUDED.confidence,updated_at=now()`,
              [tcgcsvSourceId, tcgplayerSourceId, productId, row.entity_id, row.language_code, decision.ruleId, decision.confidence, product.source_record_id, JSON.stringify({ deterministic: true, tcgdexAsserted: true })]
            );
            await client.query(
              `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
               VALUES ($1,$2,'products',$3,$4,$5,true)
               ON CONFLICT(source_id,namespace,scope_language_code,external_value) DO NOTHING`,
              [row.entity_id, tcgplayerSourceId, productId, row.language_code, product.source_record_id]
            );
          }
        } else {
          stats.conflicts++;
          await client.query(
            `INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status)
             SELECT $1,'MARKET_MAPPING_CONFLICT','MEDIUM',ARRAY[$2]::uuid[],$3::jsonb,'OPEN'
              WHERE NOT EXISTS (SELECT 1 FROM data_conflicts WHERE conflict_type='MARKET_MAPPING_CONFLICT' AND status='OPEN' AND source_record_id=$1 AND entity_ids=ARRAY[$2]::uuid[])`,
            [product.source_record_id, row.entity_id, JSON.stringify({ ruleId: decision.ruleId, productId, language: row.language_code })]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  // Attach already-staged TCGCSV price snapshots to the newly mapped products.
  for (const { productId, lang } of newlyMapped) {
    const prices = (await pool.query(
      `SELECT source_record_id, normalized_payload FROM source_records
        WHERE source_id=$1 AND namespace='prices' AND scope_language_code=$2 AND external_key LIKE $3`,
      [tcgcsvSourceId, lang, `${productId}%`]
    )).rows as Array<{ source_record_id: string; normalized_payload: NormalizedTcgcsvPrice }>;
    for (const p of prices) {
      if (String(p.normalized_payload.productId) !== productId) continue;
      stats.priceRecords++;
      stats.observationsWritten += await persistTcgcsvPrice(pool, { tcgcsvSourceId, tcgplayerSourceId, venueId, sourceRecordId: p.source_record_id, price: p.normalized_payload });
    }
  }
  await finishSyncRun(pool, syncRunId, 'SUCCESS', { ...stats, byRule, kind: 'tcgplayer-crosswalk-v0.3.1' });
  console.log(JSON.stringify({ ...stats, byRule }, null, 2));
} finally {
  await pool.end();
}
