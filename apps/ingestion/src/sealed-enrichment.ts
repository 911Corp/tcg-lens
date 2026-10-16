import { createHash } from 'node:crypto';
import { normalizeTextV1, type NormalizedSealedProduct } from '../../../packages/ingestion/src/index.js';
import type { SqlClient } from './tcgdex-canonical.js';

export type SealedResolutionStatus = 'AUTO_MATCH' | 'CANDIDATE_MATCH' | 'CONFLICT' | 'NEW_ENTITY';
export interface SealedEnrichmentResult { status: SealedResolutionStatus; entityIds: string[]; ruleId: string }

export async function enrichSealedProduct(db: SqlClient, input: {
  reportedBySourceId: string;
  originSourceId: string;
  sourceRecordId: string;
  product: NormalizedSealedProduct;
}): Promise<SealedEnrichmentResult> {
  const scopeLanguage = input.product.languageCode ?? '';
  const existing = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM external_identifiers
      WHERE source_id=$1 AND namespace='products' AND scope_language_code=$2 AND external_value=$3`,
    [input.originSourceId, scopeLanguage, input.product.externalKey]
  );
  if (existing.rows[0]) {
    const entityId = existing.rows[0].entity_id;
    const current = await sealedByEntityId(db, entityId);
    if (!current || (current.matching_fingerprint && current.matching_fingerprint !== input.product.matchingFingerprint)) {
      await recordConflict(db, input.sourceRecordId, [entityId], 'EXTERNAL_ID_COLLISION', {
        incoming: input.product.matchingFingerprint,
        current: current?.matching_fingerprint,
        externalKey: input.product.externalKey
      });
      await markSourceRecord(db, input.sourceRecordId, 'QUARANTINED', entityId);
      await recordDecision(db, input.sourceRecordId, 'CONFLICT', entityId, 'SEALED_VERIFIED_EXTERNAL_ID_DRIFT', 1, 1);
      return { status: 'CONFLICT', entityIds: [entityId], ruleId: 'SEALED_VERIFIED_EXTERNAL_ID_DRIFT' };
    }
    await persistEvidence(db, input, entityId, 'SEALED_VERIFIED_EXTERNAL_ID');
    await maybePromoteCanonical(db, entityId);
    await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', entityId);
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', entityId, 'SEALED_VERIFIED_EXTERNAL_ID', 0.999, 1);
    return { status: 'AUTO_MATCH', entityIds: [entityId], ruleId: 'SEALED_VERIFIED_EXTERNAL_ID' };
  }

  const candidates = await candidatesByMatchingFingerprint(db, input.product.matchingFingerprint);
  const compatible = candidates.filter(c => compatibleScope(c, input.product));
  if (compatible.length === 1) {
    const entityId = compatible[0].entity_id;
    await persistEvidence(db, input, entityId, 'SEALED_STRUCTURAL_MATCH');
    await maybePromoteCanonical(db, entityId);
    await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', entityId);
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', entityId, 'SEALED_STRUCTURAL_MATCH', 0.96, 1);
    return { status: 'AUTO_MATCH', entityIds: [entityId], ruleId: 'SEALED_STRUCTURAL_MATCH' };
  }
  if (compatible.length > 1) {
    await persistCandidateLinks(db, input, compatible.map(x => x.entity_id));
    await recordDecision(db, input.sourceRecordId, 'CANDIDATE_MATCH', undefined, 'SEALED_STRUCTURAL_AMBIGUITY', 0.72, compatible.length);
    return { status: 'CANDIDATE_MATCH', entityIds: compatible.map(x => x.entity_id), ruleId: 'SEALED_STRUCTURAL_AMBIGUITY' };
  }

  const entityId = await createStagedSealed(db, input);
  await persistEvidence(db, input, entityId, 'SEALED_SOURCE_BOOTSTRAP');
  await markSourceRecord(db, input.sourceRecordId, 'CANONICAL', entityId);
  await recordDecision(db, input.sourceRecordId, 'NEW_ENTITY', entityId, 'SEALED_CREATE_STAGED', 0.82, 0);
  return { status: 'NEW_ENTITY', entityIds: [entityId], ruleId: 'SEALED_CREATE_STAGED' };
}

async function createStagedSealed(db: SqlClient, input: {
  reportedBySourceId: string; originSourceId: string; sourceRecordId: string; product: NormalizedSealedProduct;
}): Promise<string> {
  const familyKey = `sealed-family:${hashShort(`${input.product.productType}|${input.product.normalizedSetHint ?? input.product.normalizedName}`)}`;
  const familyEntity = await db.query<{ entity_id: string }>(
    `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
     VALUES ('SEALED_FAMILY',$1,'STAGED','SEALED_MARKET_BOOTSTRAP',$2)
     ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()
     RETURNING entity_id`,
    [familyKey, input.originSourceId]
  );
  const familyId = familyEntity.rows[0]?.entity_id;
  if (!familyId) throw new Error('Unable to allocate sealed family');
  await db.query(
    `INSERT INTO sealed_families(entity_id,canonical_name,product_type)
     VALUES ($1,$2,$3)
     ON CONFLICT(entity_id) DO UPDATE SET canonical_name=EXCLUDED.canonical_name,product_type=EXCLUDED.product_type`,
    [familyId, input.product.setHint ?? input.product.name, input.product.productType]
  );

  const key = `sealed:${input.product.sourceCode}:${input.product.languageCode ?? 'und'}:${input.product.externalKey}`;
  const entity = await db.query<{ entity_id: string }>(
    `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
     VALUES ('SEALED_PRODUCT',$1,'STAGED','SEALED_MARKET_BOOTSTRAP',$2)
     ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()
     RETURNING entity_id`,
    [key, input.originSourceId]
  );
  const entityId = entity.rows[0]?.entity_id;
  if (!entityId) throw new Error('Unable to allocate sealed product');
  await db.query(
    `INSERT INTO sealed_products(
       entity_id,family_id,language_code,region_code,official_name,normalized_name,packaging_variant,
       manufacturer,manufacturer_sku,structural_fingerprint,matching_fingerprint,source_confidence
     ) VALUES ($1,$2,$3,$4,$5,$6,'standard',$7,$8,$9,$10,0.82)
     ON CONFLICT(entity_id) DO UPDATE SET
       official_name=EXCLUDED.official_name,normalized_name=EXCLUDED.normalized_name,
       structural_fingerprint=EXCLUDED.structural_fingerprint,matching_fingerprint=EXCLUDED.matching_fingerprint,
       source_confidence=GREATEST(COALESCE(sealed_products.source_confidence,0),EXCLUDED.source_confidence)`,
    [entityId, familyId, input.product.languageCode ?? null, input.product.regionCode ?? null,
     input.product.name, input.product.normalizedName, input.product.manufacturer ?? null,
     input.product.manufacturerSku ?? null, input.product.structuralFingerprint, input.product.matchingFingerprint]
  );
  return entityId;
}

async function persistEvidence(db: SqlClient, input: {
  reportedBySourceId: string; originSourceId: string; sourceRecordId: string; product: NormalizedSealedProduct;
}, entityId: string, method: string): Promise<void> {
  const lang = input.product.languageCode ?? '';
  await db.query(
    `INSERT INTO source_entity_links(
       reported_by_source_id,origin_source_id,namespace,external_value,entity_id,scope_language_code,scope_region_code,
       mapping_status,mapping_method,confidence,source_record_id,evidence
     ) VALUES ($1,$2,'products',$3,$4,$5,$6,'VERIFIED',$7,0.96,$8,$9::jsonb)
     ON CONFLICT(reported_by_source_id,namespace,external_value,entity_id)
     DO UPDATE SET mapping_status='VERIFIED',mapping_method=EXCLUDED.mapping_method,confidence=EXCLUDED.confidence,
                   source_record_id=EXCLUDED.source_record_id,scope_language_code=EXCLUDED.scope_language_code,
                   scope_region_code=EXCLUDED.scope_region_code,updated_at=now()`,
    [input.reportedBySourceId,input.originSourceId,input.product.externalKey,entityId,lang,input.product.regionCode ?? null,
     method,input.sourceRecordId,JSON.stringify({ structuralFingerprint: input.product.structuralFingerprint, matchingFingerprint: input.product.matchingFingerprint })]
  );
  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,scope_region_code,source_record_id,verified)
     VALUES ($1,$2,'products',$3,$4,$5,$6,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value)
     DO UPDATE SET source_record_id=EXCLUDED.source_record_id,verified=true,scope_region_code=EXCLUDED.scope_region_code`,
    [entityId,input.originSourceId,input.product.externalKey,lang,input.product.regionCode ?? null,input.sourceRecordId]
  );
  await db.query(
    `UPDATE sealed_products
        SET language_code=COALESCE(language_code,$2),
            region_code=COALESCE(region_code,$3),
            structural_fingerprint=CASE WHEN language_code IS NULL AND $2 IS NOT NULL THEN $4 ELSE structural_fingerprint END,
            source_confidence=GREATEST(COALESCE(source_confidence,0),0.96)
      WHERE entity_id=$1`,
    [entityId,input.product.languageCode ?? null,input.product.regionCode ?? null,input.product.structuralFingerprint]
  );
  const assertions: Record<string, unknown> = {
    sealed_product_type: input.product.productType,
    sealed_name: input.product.name,
    set_hint: input.product.setHint,
    structural_fingerprint: input.product.structuralFingerprint,
    matching_fingerprint: input.product.matchingFingerprint
  };
  for (const [field,value] of Object.entries(assertions)) {
    if (value == null) continue;
    const hash = createHash('sha256').update(`${field}|${JSON.stringify(value)}`).digest();
    await db.query(
      `INSERT INTO source_assertions(entity_id,source_record_id,field_path,value_json,normalized_value,value_hash,confidence)
       VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,$5,0.95)
       ON CONFLICT(source_record_id,entity_id,field_path,value_hash) DO UPDATE SET last_seen_at=now(),status='ACTIVE'`,
      [entityId,input.sourceRecordId,field,JSON.stringify(value),hash]
    );
  }
  if (input.product.imageUrl) await persistImage(db, input.reportedBySourceId, input.sourceRecordId, entityId, input.product.imageUrl);
}

async function maybePromoteCanonical(db: SqlClient, entityId: string): Promise<void> {
  const origins = await db.query<{ n: number }>(
    `SELECT count(DISTINCT origin_source_id)::int AS n
       FROM source_entity_links
      WHERE entity_id=$1 AND namespace='products' AND mapping_status='VERIFIED'`, [entityId]
  );
  if ((origins.rows[0]?.n ?? 0) >= 2) {
    await db.query(`UPDATE catalog_entities SET resolution_state='CANONICAL',updated_at=now() WHERE entity_id=$1`, [entityId]);
    await db.query(`UPDATE catalog_entities SET resolution_state='CANONICAL',updated_at=now() WHERE entity_id=(SELECT family_id FROM sealed_products WHERE entity_id=$1)`, [entityId]);
  }
}

export async function attachVerifiedBarcode(db: SqlClient, input: {
  entityId: string; barcodeId: string; sourceRecordId: string; confidence?: number;
}): Promise<'VERIFIED' | 'CONFLICT'> {
  const existing = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM entity_barcodes WHERE barcode_id=$1 AND status='VERIFIED'`, [input.barcodeId]
  );
  if (existing.rows[0] && existing.rows[0].entity_id !== input.entityId) return 'CONFLICT';
  await db.query(
    `INSERT INTO entity_barcodes(entity_id,barcode_id,source_record_id,status,confidence,last_verified_at)
     VALUES ($1,$2,$3,'VERIFIED',$4,now())
     ON CONFLICT(entity_id,barcode_id) DO UPDATE SET status='VERIFIED',confidence=GREATEST(entity_barcodes.confidence,EXCLUDED.confidence),last_verified_at=now(),source_record_id=EXCLUDED.source_record_id`,
    [input.entityId,input.barcodeId,input.sourceRecordId,input.confidence ?? 1]
  );
  await db.query(`UPDATE catalog_entities SET resolution_state='CANONICAL',updated_at=now() WHERE entity_id=$1 AND entity_type='SEALED_PRODUCT'`, [input.entityId]);
  return 'VERIFIED';
}

async function candidatesByMatchingFingerprint(db: SqlClient, fp: string) {
  const result = await db.query<{ entity_id: string; language_code: string | null; region_code: string | null; matching_fingerprint: string | null }>(
    `SELECT sp.entity_id,sp.language_code,sp.region_code,sp.matching_fingerprint
       FROM sealed_products sp JOIN catalog_entities ce ON ce.entity_id=sp.entity_id
      WHERE sp.matching_fingerprint=$1 AND ce.status='ACTIVE'`, [fp]
  );
  return result.rows;
}
async function sealedByEntityId(db: SqlClient, entityId: string) {
  const r = await db.query<{ entity_id: string; matching_fingerprint: string | null }>(`SELECT entity_id,matching_fingerprint FROM sealed_products WHERE entity_id=$1`,[entityId]);
  return r.rows[0];
}
function compatibleScope(c: { language_code: string | null; region_code: string | null }, p: NormalizedSealedProduct): boolean {
  if (c.language_code && p.languageCode && c.language_code !== p.languageCode) return false;
  if (c.region_code && p.regionCode && c.region_code !== p.regionCode) return false;
  return true;
}
async function persistCandidateLinks(db: SqlClient, input: { reportedBySourceId:string;originSourceId:string;sourceRecordId:string;product:NormalizedSealedProduct }, entityIds:string[]) {
  for (const entityId of entityIds) await db.query(
    `INSERT INTO source_entity_links(reported_by_source_id,origin_source_id,namespace,external_value,entity_id,scope_language_code,scope_region_code,mapping_status,mapping_method,confidence,source_record_id,evidence)
     VALUES ($1,$2,'products',$3,$4,$5,$6,'CANDIDATE','SEALED_STRUCTURAL_AMBIGUITY',0.72,$7,$8::jsonb)
     ON CONFLICT(reported_by_source_id,namespace,external_value,entity_id) DO UPDATE SET mapping_status='CANDIDATE',updated_at=now()`,
    [input.reportedBySourceId,input.originSourceId,input.product.externalKey,entityId,input.product.languageCode ?? '',input.product.regionCode ?? null,input.sourceRecordId,JSON.stringify({matchingFingerprint:input.product.matchingFingerprint})]
  );
}
async function persistImage(db: SqlClient, sourceId:string, sourceRecordId:string, entityId:string, url:string) {
  const existing=await db.query<{image_id:string}>(`SELECT image_id FROM image_origins WHERE source_id=$1 AND source_url=$2`,[sourceId,url]);
  let imageId=existing.rows[0]?.image_id;
  if(!imageId){ const i=await db.query<{image_id:string}>(`INSERT INTO images DEFAULT VALUES RETURNING image_id`); imageId=i.rows[0]?.image_id; if(!imageId) throw new Error('Unable to allocate image'); await db.query(`INSERT INTO image_origins(image_id,source_id,source_record_id,source_url,rights_status,redistribution_status,indexing_allowed,display_allowed) VALUES ($1,$2,$3,$4,'UNKNOWN','UNKNOWN',false,false) ON CONFLICT(source_id,source_url) DO NOTHING`,[imageId,sourceId,sourceRecordId,url]); }
  await db.query(`INSERT INTO entity_images(entity_id,image_id,role,view_type,is_primary,sort_order) VALUES ($1,$2,'MARKETPLACE','FRONT',false,10) ON CONFLICT DO NOTHING`,[entityId,imageId]);
}
async function recordDecision(db:SqlClient,sourceRecordId:string,status:SealedResolutionStatus,entityId:string|undefined,ruleId:string,confidence:number,candidateCount:number){ await db.query(`INSERT INTO resolution_decisions(source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json) VALUES ($1,$2,$3,$4,'sealed-enrichment-v0.1',$5,$6,$7::jsonb,'[]'::jsonb)`,[sourceRecordId,status,entityId??null,ruleId,candidateCount,confidence,JSON.stringify({sealed:true})]); }
async function recordConflict(db:SqlClient,sourceRecordId:string,entityIds:string[],type:string,evidence:Record<string,unknown>){ await db.query(`INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status) VALUES ($1,$2,'CRITICAL',$3::uuid[],$4::jsonb,'OPEN')`,[sourceRecordId,type,entityIds,JSON.stringify(evidence)]); }
async function markSourceRecord(db:SqlClient,sourceRecordId:string,status:'CANONICAL'|'QUARANTINED',entityId:string){ await db.query(`UPDATE source_records SET promotion_status=$2,promoted_entity_id=$3,promoted_at=now(),last_seen_at=now() WHERE source_record_id=$1`,[sourceRecordId,status,entityId]); }
function hashShort(value:string){ return createHash('sha256').update(value).digest('hex').slice(0,24); }
