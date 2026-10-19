/**
 * v0.3.1 — Apply the Cardmarket crosswalk (TCGdex-asserted idProduct, confirmed by the Cardmarket
 * catalog) and write VERIFIED Cardmarket mappings for canonical printings.
 *
 *   DATABASE_URL=... npm run cardmarket:crosswalk -w @tcglens/ingestion-worker -- [--catalog=path/to/products_singles_6.json]
 *
 * Afterwards re-run `npm run import:cardmarket -- prices` so the price guide attaches to the new links.
 */
import fs from 'node:fs/promises';
import pg from 'pg';
import {
  CardmarketClient,
  decideCardmarketCrosswalk,
  type CardmarketProduct,
  type CrosswalkDecision
} from '../../../packages/ingestion/src/index.js';
import { finishSyncRun, getSourceId, startSyncRun, upsertSourceRecord } from './source-record.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const catalogArg = process.argv.find(v => v.startsWith('--catalog='))?.slice('--catalog='.length);

const pool = new Pool({ connectionString: databaseUrl });
const stats: Record<string, number> = { printingsWithAssertion: 0, assertions: 0, autoMatched: 0, candidates: 0, conflicts: 0 };
const byRule: Record<string, number> = {};

try {
  const catalog = catalogArg
    ? JSON.parse(await fs.readFile(catalogArg, 'utf8')) as { createdAt?: string; products: CardmarketProduct[] }
    : await new CardmarketClient().fetchSingles();
  const products = new Map<number, CardmarketProduct>(catalog.products.map(p => [p.idProduct, p]));
  const cardmarketSourceId = await getSourceId(pool, 'cardmarket');
  const syncRunId = await startSyncRun(pool, cardmarketSourceId);

  const rows = (await pool.query(
    `SELECT cp.entity_id, cp.set_id, cs.language_code, cp.name,
            (SELECT ei.external_value FROM external_identifiers ei JOIN data_sources ds ON ds.source_id=ei.source_id
              WHERE ei.entity_id=cp.entity_id AND ds.source_code='tcgdex' AND ei.namespace='cards' LIMIT 1) AS tcgdex_id,
            array_agg(DISTINCT (sa.value_json #>> '{}')::bigint) AS asserted
       FROM card_printings cp
       JOIN card_sets cs ON cs.entity_id=cp.set_id
       JOIN catalog_entities ce ON ce.entity_id=cp.entity_id AND ce.status='ACTIVE' AND ce.resolution_state='CANONICAL'
       JOIN card_variants cv ON cv.printing_id=cp.entity_id
       JOIN source_assertions sa ON sa.entity_id=cv.entity_id AND sa.field_path='tcgdex_asserted_cardmarket_product_id' AND sa.status='ACTIVE'
      GROUP BY cp.entity_id, cp.set_id, cs.language_code, cp.name`
  )).rows as Array<{ entity_id: string; set_id: string; language_code: string; name: string; tcgdex_id: string | null; asserted: Array<string | number> }>;

  // Indexes for context.
  const enByTcgdexId = new Map<string, { name: string; asserted: Set<number> }>();
  const claims = new Map<string, Set<string>>(); // `${lang}|${idProduct}` -> printing ids
  const setExpansions = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const asserted = row.asserted.map(Number);
    if (row.language_code === 'en' && row.tcgdex_id) enByTcgdexId.set(row.tcgdex_id, { name: row.name, asserted: new Set(asserted) });
    for (const id of asserted) {
      const key = `${row.language_code}|${id}`;
      if (!claims.has(key)) claims.set(key, new Set());
      claims.get(key)!.add(row.entity_id);
      const exp = products.get(id)?.idExpansion;
      if (exp != null) {
        const m = setExpansions.get(row.set_id) ?? new Map<number, number>();
        m.set(exp, (m.get(exp) ?? 0) + 1);
        setExpansions.set(row.set_id, m);
      }
    }
  }
  const modeOf = (setId: string): { mode: number | null; share: number } => {
    const m = setExpansions.get(setId);
    if (!m || !m.size) return { mode: null, share: 0 };
    let best: [number, number] = [0, 0], total = 0;
    for (const [k, v] of m) { total += v; if (v > best[1]) best = [k, v]; }
    return { mode: best[0], share: best[1] / total };
  };

  for (const row of rows) {
    stats.printingsWithAssertion++;
    const { mode, share } = modeOf(row.set_id);
    const sibling = row.tcgdex_id ? enByTcgdexId.get(row.tcgdex_id) : undefined;
    for (const idProduct of row.asserted.map(Number)) {
      stats.assertions++;
      const product = products.get(idProduct);
      const decision: CrosswalkDecision = decideCardmarketCrosswalk(
        { entityId: row.entity_id, languageCode: row.language_code, name: row.name, englishSiblingName: sibling?.name ?? null, englishSiblingAssertsSameProduct: sibling?.asserted.has(idProduct) ?? false },
        product ? { idProduct, name: product.name, idCategory: product.idCategory, idExpansion: product.idExpansion } : undefined,
        { setExpansionMode: mode, setExpansionModeShare: share, printingsAssertingSameProductInLanguage: claims.get(`${row.language_code}|${idProduct}`)?.size ?? 0 }
      );
      byRule[decision.ruleId] = (byRule[decision.ruleId] ?? 0) + 1;
      if (!product) { stats.candidates++; continue; }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sourceRecordId = await upsertSourceRecord(client, {
          sourceId: cardmarketSourceId, syncRunId, namespace: 'products', externalKey: String(idProduct),
          rawPayload: product, normalizedPayload: { idProduct, name: product.name, idExpansion: product.idExpansion, idMetacard: product.idMetacard }, normalizationVersion: 'cardmarket-crosswalk-v0.3.1'
        });
        await client.query(
          `INSERT INTO resolution_decisions(source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json)
           VALUES ($1,$2,$3,$4,'cardmarket-crosswalk-v0.3.1',1,$5,$6::jsonb,'[]'::jsonb)`,
          [sourceRecordId, decision.status, decision.status === 'AUTO_MATCH' ? row.entity_id : null, decision.ruleId, decision.confidence,
           JSON.stringify({ enrichment_only: true, printing: row.entity_id, language: row.language_code, tcgdexAsserted: true })]
        );
        if (decision.status !== 'CONFLICT') {
          // A previously recorded mapping conflict for this (printing, product) no longer applies.
          await client.query(
            `UPDATE data_conflicts SET status='RESOLVED',resolved_at=now()
              WHERE conflict_type='MARKET_MAPPING_CONFLICT' AND status='OPEN' AND entity_ids=ARRAY[$1]::uuid[] AND (evidence->>'idProduct')::bigint=$2`,
            [row.entity_id, idProduct]
          );
        }
        if (decision.status === 'AUTO_MATCH') {
          stats.autoMatched++;
          await client.query(
            `INSERT INTO source_entity_links(reported_by_source_id,origin_source_id,namespace,external_value,entity_id,scope_language_code,mapping_status,mapping_method,confidence,source_record_id,evidence)
             VALUES ($1,$1,'products',$2,$3,$4,'VERIFIED',$5,$6,$7,$8::jsonb)
             ON CONFLICT(reported_by_source_id,namespace,external_value,entity_id)
             DO UPDATE SET mapping_status='VERIFIED',mapping_method=EXCLUDED.mapping_method,confidence=EXCLUDED.confidence,source_record_id=EXCLUDED.source_record_id,scope_language_code=EXCLUDED.scope_language_code,updated_at=now()`,
            [cardmarketSourceId, String(idProduct), row.entity_id, row.language_code, decision.ruleId, decision.confidence, sourceRecordId, JSON.stringify({ deterministic: true, tcgdexAsserted: true })]
          );
          await client.query(
            `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
             VALUES ($1,$2,'products',$3,$4,$5,true)
             ON CONFLICT(source_id,namespace,scope_language_code,external_value) DO NOTHING`,
            [row.entity_id, cardmarketSourceId, String(idProduct), row.language_code, sourceRecordId]
          );
        } else if (decision.status === 'CONFLICT') {
          stats.conflicts++;
          // MARKET_* conflicts are excluded from identity checks: market mapping never affects identity.
          await client.query(
            `INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status)
             SELECT $1,'MARKET_MAPPING_CONFLICT','MEDIUM',ARRAY[$2]::uuid[],$3::jsonb,'OPEN'
              WHERE NOT EXISTS (SELECT 1 FROM data_conflicts WHERE conflict_type='MARKET_MAPPING_CONFLICT' AND status='OPEN'
                                  AND entity_ids=ARRAY[$2]::uuid[] AND (evidence->>'idProduct')::bigint=($3::jsonb->>'idProduct')::bigint)`,
            [sourceRecordId, row.entity_id, JSON.stringify({ ruleId: decision.ruleId, idProduct, cardmarketName: product.name, printingName: row.name, language: row.language_code })]
          );
        } else stats.candidates++;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }
  await finishSyncRun(pool, syncRunId, 'SUCCESS', { ...stats, byRule, catalogCreatedAt: catalog.createdAt ?? null });
  console.log(JSON.stringify({ ...stats, byRule }, null, 2));
} finally {
  await pool.end();
}
