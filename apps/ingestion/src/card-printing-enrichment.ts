import { createHash } from 'node:crypto';
import {
  normalizeTextV1,
  type NormalizedCardmarketProduct,
  type NormalizedCardmarketPrice,
  type NormalizedTcgcsvProduct,
  type NormalizedTcgcsvPrice,
  decideCardmarketEnrichment,
  decideTcgcsvEnrichment,
  type CanonicalCardCandidate
} from '../../../packages/ingestion/src/index.js';
import type { SqlClient } from './tcgdex-canonical.js';

export type EnrichmentStatus = 'AUTO_MATCH' | 'CANDIDATE_MATCH' | 'CONFLICT' | 'NEW_ENTITY';
export interface EnrichmentResult { status: EnrichmentStatus; entityIds: string[]; ruleId: string }

type CardCandidate = CanonicalCardCandidate;

export async function enrichCardmarketPrinting(db: SqlClient, input: {
  cardmarketSourceId: string;
  sourceRecordId: string;
  product: NormalizedCardmarketProduct;
}): Promise<EnrichmentResult> {
  if (input.product.productGroup !== 'single' || !input.product.collectorNumberNormalized) {
    await recordDecision(db, input.sourceRecordId, 'CANDIDATE_MATCH', undefined, 'CARDMARKET_INSUFFICIENT_CARD_IDENTITY', 0.2, 0);
    return { status: 'CANDIDATE_MATCH', entityIds: [], ruleId: 'CARDMARKET_INSUFFICIENT_CARD_IDENTITY' };
  }

  const already = await linksFor(db, input.cardmarketSourceId, 'products', input.product.externalKey);
  if (already.length) {
    const mapped = await candidatesByEntityIds(db, already);
    const mismatches = mapped.filter(candidate =>
      candidate.collector_number_normalized !== input.product.collectorNumberNormalized ||
      normalizeTextV1(candidate.name) !== input.product.normalizedName
    );
    if (mismatches.length) {
      await recordConflict(db, input.sourceRecordId, already, 'EXTERNAL_ID_COLLISION', {
        source: 'cardmarket', productId: input.product.idProduct, incomingName: input.product.name,
        incomingNumber: input.product.collectorNumberNormalized, mismatchedEntities: mismatches.map(x => x.entity_id)
      });
      await markSourceRecord(db, input.sourceRecordId, 'QUARANTINED', already[0]);
      await recordDecision(db, input.sourceRecordId, 'CONFLICT', already[0], 'CARDMARKET_VERIFIED_LINK_DRIFT', 1, already.length);
      return { status: 'CONFLICT', entityIds: already, ruleId: 'CARDMARKET_VERIFIED_LINK_DRIFT' };
    }
    for (const entityId of already) await persistCardmarketEvidence(db, input, entityId, 'EXISTING_VERIFIED_LINK');
    if (already.length === 1) await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', already[0]);
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', already[0], 'CARDMARKET_VERIFIED_PRODUCT_LINK', 0.995, already.length);
    return { status: 'AUTO_MATCH', entityIds: already, ruleId: 'CARDMARKET_VERIFIED_PRODUCT_LINK' };
  }

  const candidates = await candidatePrintings(db, input.product.collectorNumberNormalized);
  const decision = decideCardmarketEnrichment(input.product, candidates);
  if (decision.status === 'AUTO_MATCH' && decision.matches[0]) {
    const candidate = decision.matches[0];
    await persistCardmarketEvidence(db, input, candidate.entity_id, decision.ruleId, candidate.language_code);
    await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', candidate.entity_id);
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', candidate.entity_id, decision.ruleId, decision.confidence, 1);
    return { status: 'AUTO_MATCH', entityIds: [candidate.entity_id], ruleId: decision.ruleId };
  }
  await persistCandidates(db, input.sourceRecordId, decision.matches, decision.ruleId, decision.status);
  return { status: decision.status, entityIds: decision.matches.map(x => x.entity_id), ruleId: decision.ruleId };
}

export async function enrichTcgcsvPrinting(db: SqlClient, input: {
  tcgcsvSourceId: string;
  tcgplayerSourceId: string;
  sourceRecordId: string;
  product: NormalizedTcgcsvProduct;
}): Promise<EnrichmentResult> {
  if (!input.product.collectorNumberNormalized) {
    await recordDecision(db, input.sourceRecordId, 'CANDIDATE_MATCH', undefined, 'TCGCSV_MISSING_COLLECTOR_NUMBER', 0.2, 0);
    return { status: 'CANDIDATE_MATCH', entityIds: [], ruleId: 'TCGCSV_MISSING_COLLECTOR_NUMBER' };
  }

  const ext = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM external_identifiers
      WHERE source_id=$1 AND namespace='products' AND scope_language_code=$2 AND external_value=$3`,
    [input.tcgplayerSourceId, input.product.languageCode, input.product.externalKey]
  );
  if (ext.rows[0]) {
    const mapped = (await candidatesByEntityIds(db, [ext.rows[0].entity_id]))[0];
    if (!mapped || mapped.language_code !== input.product.languageCode ||
        mapped.collector_number_normalized !== input.product.collectorNumberNormalized ||
        normalizeTextV1(mapped.name) !== input.product.normalizedName) {
      await recordConflict(db, input.sourceRecordId, [ext.rows[0].entity_id], 'EXTERNAL_ID_COLLISION', {
        source: 'tcgplayer', productId: input.product.productId, incomingName: input.product.name,
        incomingNumber: input.product.collectorNumberNormalized, incomingLanguage: input.product.languageCode
      });
      await markSourceRecord(db, input.sourceRecordId, 'QUARANTINED', ext.rows[0].entity_id);
      await recordDecision(db, input.sourceRecordId, 'CONFLICT', ext.rows[0].entity_id, 'TCGPLAYER_VERIFIED_ID_DRIFT', 1, 1);
      return { status: 'CONFLICT', entityIds: [ext.rows[0].entity_id], ruleId: 'TCGPLAYER_VERIFIED_ID_DRIFT' };
    }
    await persistTcgcsvEvidence(db, input, ext.rows[0].entity_id, 'EXISTING_TCGPLAYER_ID');
    await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', ext.rows[0].entity_id);
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', ext.rows[0].entity_id, 'TCGPLAYER_VERIFIED_PRODUCT_ID', 0.999, 1);
    return { status: 'AUTO_MATCH', entityIds: [ext.rows[0].entity_id], ruleId: 'TCGPLAYER_VERIFIED_PRODUCT_ID' };
  }

  const candidates = await candidatePrintings(db, input.product.collectorNumberNormalized, input.product.languageCode);
  const decision = decideTcgcsvEnrichment(input.product, candidates);
  if (decision.status === 'AUTO_MATCH' && decision.matches[0]) {
    const entityId = decision.matches[0].entity_id;
    await persistTcgcsvEvidence(db, input, entityId, decision.ruleId);
    await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', entityId);
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', entityId, decision.ruleId, decision.confidence, 1);
    return { status: 'AUTO_MATCH', entityIds: [entityId], ruleId: decision.ruleId };
  }
  await persistCandidates(db, input.sourceRecordId, decision.matches, decision.ruleId, decision.status);
  return { status: decision.status, entityIds: decision.matches.map(x => x.entity_id), ruleId: decision.ruleId };
}

export async function persistCardmarketPrice(db: SqlClient, input: {
  cardmarketSourceId: string;
  venueId: string;
  sourceRecordId: string;
  price: NormalizedCardmarketPrice;
}): Promise<number> {
  const links = await linksFor(db, input.cardmarketSourceId, 'products', String(input.price.idProduct));
  let inserted = 0;
  for (const entityId of links) {
    for (const metric of input.price.metrics) {
      await insertObservation(db, {
        entityId,
        reportedBySource: input.cardmarketSourceId,
        originSource: input.cardmarketSourceId,
        venueId: input.venueId,
        sourceRecordId: input.sourceRecordId,
        observedAt: input.price.observedAt,
        metricType: metric.metricType,
        currency: input.price.currency,
        amount: metric.amount,
        precisionScope: metric.precisionScope,
        metadata: { ...metric.metadata, cardmarket_product_id: input.price.idProduct }
      });
      inserted++;
    }
  }
  return inserted;
}

export async function persistTcgcsvPrice(db: SqlClient, input: {
  tcgcsvSourceId: string;
  tcgplayerSourceId: string;
  venueId: string;
  sourceRecordId: string;
  price: NormalizedTcgcsvPrice;
}): Promise<number> {
  const ext = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM external_identifiers
      WHERE source_id=$1 AND namespace='products' AND scope_language_code=$2 AND external_value=$3`,
    [input.tcgplayerSourceId, input.price.languageCode, String(input.price.productId)]
  );
  const entityIds = ext.rows.map(row => row.entity_id);
  let inserted = 0;
  for (const entityId of entityIds) {
    for (const metric of input.price.metrics) {
      await insertObservation(db, {
        entityId,
        reportedBySource: input.tcgcsvSourceId,
        originSource: input.tcgplayerSourceId,
        venueId: input.venueId,
        sourceRecordId: input.sourceRecordId,
        observedAt: input.price.observedAt,
        metricType: metric.metricType,
        currency: input.price.currency,
        amount: metric.amount,
        languageCode: input.price.languageCode,
        precisionScope: metric.precisionScope,
        metadata: { ...metric.metadata, tcgplayer_product_id: input.price.productId }
      });
      inserted++;
    }
  }
  return inserted;
}

async function persistCardmarketEvidence(
  db: SqlClient,
  input: { cardmarketSourceId: string; sourceRecordId: string; product: NormalizedCardmarketProduct },
  entityId: string,
  method: string,
  languageCode = ''
): Promise<void> {
  await upsertSourceLink(db, input.cardmarketSourceId, input.cardmarketSourceId, input.sourceRecordId, input.product.externalKey, entityId, languageCode, method, 0.97);
  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
     VALUES ($1,$2,'products',$3,$4,$5,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value)
     DO UPDATE SET source_record_id=EXCLUDED.source_record_id,verified=true`,
    [entityId, input.cardmarketSourceId, input.product.externalKey, languageCode, input.sourceRecordId]
  );
  await assertProductFields(db, entityId, input.sourceRecordId, {
    cardmarket_product_id: input.product.idProduct,
    cardmarket_expansion_id: input.product.expansionId,
    cardmarket_metacard_id: input.product.metacardId,
    rarity: input.product.rarity
  });
}

async function persistTcgcsvEvidence(
  db: SqlClient,
  input: { tcgcsvSourceId: string; tcgplayerSourceId: string; sourceRecordId: string; product: NormalizedTcgcsvProduct },
  entityId: string,
  method: string
): Promise<void> {
  await upsertSourceLink(db, input.tcgcsvSourceId, input.tcgplayerSourceId, input.sourceRecordId, input.product.externalKey, entityId, input.product.languageCode, method, 0.98);
  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
     VALUES ($1,$2,'products',$3,$4,$5,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value)
     DO UPDATE SET source_record_id=EXCLUDED.source_record_id,verified=true`,
    [entityId, input.tcgplayerSourceId, input.product.externalKey, input.product.languageCode, input.sourceRecordId]
  );
  await assertProductFields(db, entityId, input.sourceRecordId, {
    tcgplayer_product_id: input.product.productId,
    tcgplayer_group_id: input.product.groupId,
    rarity: input.product.rarity
  });
  if (input.product.imageUrl) await persistImage(db, input.tcgcsvSourceId, input.sourceRecordId, entityId, input.product.imageUrl);
}

async function candidatesByEntityIds(db: SqlClient, entityIds: string[]): Promise<CardCandidate[]> {
  if (!entityIds.length) return [];
  const result = await db.query<CardCandidate>(
    `SELECT cp.entity_id,cp.name,cp.collector_number_normalized,cs.language_code,
            cs.official_name AS set_name,cs.official_set_code AS set_code
       FROM card_printings cp
       JOIN card_sets cs ON cs.entity_id=cp.set_id
      WHERE cp.entity_id = ANY($1::uuid[])`,
    [entityIds]
  );
  return result.rows;
}

async function candidatePrintings(db: SqlClient, collectorNumber: string, languageCode?: string): Promise<CardCandidate[]> {
  const values: unknown[] = [collectorNumber];
  const languageSql = languageCode ? ` AND cs.language_code=$2` : '';
  if (languageCode) values.push(languageCode);
  const result = await db.query<CardCandidate>(
    `SELECT cp.entity_id,cp.name,cp.collector_number_normalized,cs.language_code,
            cs.official_name AS set_name,cs.official_set_code AS set_code
       FROM card_printings cp
       JOIN card_sets cs ON cs.entity_id=cp.set_id
       JOIN catalog_entities ce ON ce.entity_id=cp.entity_id
      WHERE cp.collector_number_normalized=$1${languageSql}
        AND ce.status='ACTIVE' AND ce.resolution_state='CANONICAL'`,
    values
  );
  return result.rows;
}

async function linksFor(db: SqlClient, sourceId: string, namespace: string, externalValue: string): Promise<string[]> {
  const links = await db.query<{ entity_id: string }>(
    `SELECT DISTINCT entity_id FROM source_entity_links
      WHERE origin_source_id=$1 AND namespace=$2 AND external_value=$3 AND mapping_status='VERIFIED'`,
    [sourceId, namespace, externalValue]
  );
  if (links.rows.length) return links.rows.map(row => row.entity_id);
  const ext = await db.query<{ entity_id: string }>(
    `SELECT DISTINCT entity_id FROM external_identifiers
      WHERE source_id=$1 AND namespace=$2 AND external_value=$3 AND verified=true`,
    [sourceId, namespace, externalValue]
  );
  return ext.rows.map(row => row.entity_id);
}

async function upsertSourceLink(
  db: SqlClient,
  reportedBy: string,
  origin: string,
  sourceRecordId: string,
  externalValue: string,
  entityId: string,
  languageCode: string,
  method: string,
  confidence: number
): Promise<void> {
  await db.query(
    `INSERT INTO source_entity_links(
       reported_by_source_id,origin_source_id,namespace,external_value,entity_id,scope_language_code,
       mapping_status,mapping_method,confidence,source_record_id,evidence
     ) VALUES ($1,$2,'products',$3,$4,$5,'VERIFIED',$6,$7,$8,$9::jsonb)
     ON CONFLICT(reported_by_source_id,namespace,external_value,entity_id)
     DO UPDATE SET mapping_status='VERIFIED',mapping_method=EXCLUDED.mapping_method,
                   confidence=EXCLUDED.confidence,source_record_id=EXCLUDED.source_record_id,
                   scope_language_code=EXCLUDED.scope_language_code,updated_at=now()`,
    [reportedBy, origin, externalValue, entityId, languageCode, method, confidence, sourceRecordId, JSON.stringify({ deterministic: true })]
  );
}

async function assertProductFields(db: SqlClient, entityId: string, sourceRecordId: string, fields: Record<string, unknown>): Promise<void> {
  for (const [field, value] of Object.entries(fields)) {
    if (value == null) continue;
    const normalized = typeof value === 'string' ? normalizeTextV1(value) : value;
    const hash = createHash('sha256').update(`${field}|${JSON.stringify(normalized)}`).digest();
    await db.query(
      `INSERT INTO source_assertions(entity_id,source_record_id,field_path,value_json,normalized_value,value_hash,confidence)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,0.95)
       ON CONFLICT(source_record_id,entity_id,field_path,value_hash)
       DO UPDATE SET last_seen_at=now(),status='ACTIVE'`,
      [entityId, sourceRecordId, field, JSON.stringify(value), JSON.stringify(normalized), hash]
    );
  }
}

async function persistImage(db: SqlClient, sourceId: string, sourceRecordId: string, entityId: string, url: string): Promise<void> {
  const existing = await db.query<{ image_id: string }>(`SELECT image_id FROM image_origins WHERE source_id=$1 AND source_url=$2`, [sourceId, url]);
  let imageId = existing.rows[0]?.image_id;
  if (!imageId) {
    const image = await db.query<{ image_id: string }>(`INSERT INTO images DEFAULT VALUES RETURNING image_id`);
    imageId = image.rows[0]?.image_id;
    if (!imageId) throw new Error('Unable to allocate image');
    await db.query(
      `INSERT INTO image_origins(image_id,source_id,source_record_id,source_url,rights_status,redistribution_status,indexing_allowed,display_allowed)
       VALUES ($1,$2,$3,$4,'UNKNOWN','UNKNOWN',false,false)
       ON CONFLICT(source_id,source_url) DO NOTHING`,
      [imageId, sourceId, sourceRecordId, url]
    );
  }
  await db.query(
    `INSERT INTO entity_images(entity_id,image_id,role,view_type,is_primary,sort_order)
     VALUES ($1,$2,'MARKETPLACE','FRONT',false,10)
     ON CONFLICT DO NOTHING`,
    [entityId, imageId]
  );
}

async function persistCandidates(
  db: SqlClient,
  sourceRecordId: string,
  candidates: CardCandidate[],
  ruleId: string,
  status: EnrichmentStatus = 'CANDIDATE_MATCH'
): Promise<void> {
  const decision = await db.query<{ decision_id: string }>(
    `INSERT INTO resolution_decisions(
       source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json
     ) VALUES ($1,$2,NULL,$3,'market-enrichment-v0.1',$4,$5,$6::jsonb,'[]'::jsonb)
     RETURNING decision_id`,
    [sourceRecordId, status, ruleId, candidates.length, status === 'NEW_ENTITY' ? 0.5 : 0.7, JSON.stringify({ enrichment_only: true })]
  );
  const decisionId = decision.rows[0]?.decision_id;
  if (!decisionId) return;
  let rank = 1;
  for (const candidate of candidates.slice(0, 20)) {
    await db.query(
      `INSERT INTO resolution_candidates(decision_id,entity_id,candidate_rank,candidate_score,evidence_json,contradictions_json)
       VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb) ON CONFLICT DO NOTHING`,
      [decisionId, candidate.entity_id, rank++, 70, JSON.stringify(['collector_number_match'])]
    );
  }
}

async function recordDecision(
  db: SqlClient,
  sourceRecordId: string,
  status: EnrichmentStatus,
  entityId: string | undefined,
  ruleId: string,
  confidence: number,
  candidateCount: number
): Promise<void> {
  await db.query(
    `INSERT INTO resolution_decisions(
       source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json
     ) VALUES ($1,$2,$3,$4,'market-enrichment-v0.1',$5,$6,$7::jsonb,'[]'::jsonb)`,
    [sourceRecordId, status, entityId ?? null, ruleId, candidateCount, confidence, JSON.stringify({ enrichment_only: true })]
  );
}


async function recordConflict(
  db: SqlClient,
  sourceRecordId: string,
  entityIds: string[],
  conflictType: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await db.query(
    `INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status)
     VALUES ($1,$2,'HIGH',$3::uuid[],$4::jsonb,'OPEN')`,
    [sourceRecordId, conflictType, entityIds, JSON.stringify(evidence)]
  );
}

async function markSourceRecord(db: SqlClient, sourceRecordId: string, status: 'CANONICAL' | 'QUARANTINED', entityId: string): Promise<void> {
  await db.query(
    `UPDATE source_records
        SET promotion_status=$2,promoted_entity_id=$3,promoted_at=now(),last_seen_at=now()
      WHERE source_record_id=$1`,
    [sourceRecordId, status, entityId]
  );
}

async function insertObservation(db: SqlClient, input: {
  entityId: string;
  reportedBySource: string;
  originSource: string;
  venueId: string;
  sourceRecordId: string;
  observedAt: string;
  metricType: string;
  currency: string;
  amount: number;
  languageCode?: string;
  precisionScope: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const hashPayload = [
    input.entityId,input.reportedBySource,input.originSource,input.venueId,input.observedAt,
    input.metricType,input.currency,input.amount,input.languageCode ?? '',input.precisionScope,JSON.stringify(input.metadata)
  ].join('|');
  const hash = createHash('sha256').update(hashPayload).digest();
  await db.query(
    `INSERT INTO market_observations(
       entity_id,reported_by_source,origin_source,venue_id,source_record_id,observed_at,
       metric_type,currency,amount,language_code,precision_scope,confidence,observation_hash,metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0.95,$12,$13::jsonb)
     ON CONFLICT(observation_hash) DO NOTHING`,
    [input.entityId,input.reportedBySource,input.originSource,input.venueId,input.sourceRecordId,input.observedAt,
     input.metricType,input.currency,input.amount,input.languageCode ?? null,input.precisionScope,hash,JSON.stringify(input.metadata)]
  );
}
