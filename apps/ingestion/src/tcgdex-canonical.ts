import { createHash } from 'node:crypto';
import { buildTcgdexCanonicalPlan, normalizeTextV1, type NormalizedTcgdexCard } from '../../../packages/ingestion/src/index.js';

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface PromotionResult {
  status: 'AUTO_MATCH' | 'CONFLICT' | 'NEW_ENTITY';
  entityId?: string;
  setId?: string;
  ruleId: string;
}

export async function promoteTcgdexCard(
  db: SqlClient,
  input: { sourceId: string; sourceRecordId: string; normalized: NormalizedTcgdexCard }
): Promise<PromotionResult> {
  const plan = buildTcgdexCanonicalPlan(input.normalized);

  const external = await db.query<{ entity_id: string }>(
    `SELECT entity_id
       FROM external_identifiers
      WHERE source_id=$1 AND namespace='cards' AND scope_language_code=$2 AND external_value=$3`,
    [input.sourceId, plan.scopeLanguageCode, plan.externalCardId]
  );

  if (external.rows[0]) {
    const entityId = external.rows[0].entity_id;
    const mismatch = await mappedIdentityMismatch(db, entityId, plan);
    if (mismatch.length) {
      await recordConflict(db, input.sourceRecordId, entityId, { type: 'VERIFIED_EXTERNAL_ID_DRIFT', mismatches: mismatch });
      await recordDecision(db, input.sourceRecordId, 'CONFLICT', entityId, 'TCGDEX_VERIFIED_EXTERNAL_ID_DRIFT', 1, 1, mismatch);
      await markPromoted(db, input.sourceRecordId, 'QUARANTINED', entityId);
      return { status: 'CONFLICT', entityId, ruleId: 'TCGDEX_VERIFIED_EXTERNAL_ID_DRIFT' };
    }
    await persistCardEvidence(db, { ...input, entityId, plan });
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', entityId, 'TCGDEX_VERIFIED_EXTERNAL_ID', 0.999, 1);
    await markPromoted(db, input.sourceRecordId, 'CANONICAL', entityId);
    return { status: 'AUTO_MATCH', entityId, ruleId: 'TCGDEX_VERIFIED_EXTERNAL_ID' };
  }

  const setId = await ensureSet(db, input.sourceId, input.sourceRecordId, plan);
  const printing = await db.query<{ entity_id: string; name: string }>(
    `SELECT entity_id, name
       FROM card_printings
      WHERE set_id=$1 AND collector_number_normalized=$2 AND printing_discriminator=$3`,
    [setId, plan.collectorNumberNormalized, plan.printingDiscriminator]
  );

  if (printing.rows[0]) {
    const current = printing.rows[0];
    if (normalizeTextV1(current.name) !== plan.normalizedName) {
      await recordConflict(db, input.sourceRecordId, current.entity_id, {
        type: 'IDENTITY_COLLISION',
        incomingName: plan.name,
        canonicalName: current.name,
        setId,
        collectorNumber: plan.collectorNumberNormalized,
        languageCode: plan.scopeLanguageCode
      });
      await recordDecision(db, input.sourceRecordId, 'CONFLICT', current.entity_id, 'TCGDEX_NAME_IDENTITY_COLLISION', 1, 1, [
        `canonical name ${current.name} differs from incoming ${plan.name}`
      ]);
      await markPromoted(db, input.sourceRecordId, 'QUARANTINED', current.entity_id);
      return { status: 'CONFLICT', entityId: current.entity_id, setId, ruleId: 'TCGDEX_NAME_IDENTITY_COLLISION' };
    }

    await persistCardEvidence(db, { ...input, entityId: current.entity_id, plan });
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', current.entity_id, 'TCGDEX_SET_NUMBER_LANGUAGE_EXACT', 0.995, 1);
    await markPromoted(db, input.sourceRecordId, 'CANONICAL', current.entity_id);
    return { status: 'AUTO_MATCH', entityId: current.entity_id, setId, ruleId: 'TCGDEX_SET_NUMBER_LANGUAGE_EXACT' };
  }

  const entity = await db.query<{ entity_id: string }>(
    `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
     VALUES ('CARD_PRINTING',$1,'CANONICAL','BOOTSTRAP_TCGDEX',$2)
     ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()
     RETURNING entity_id`,
    [plan.cardCanonicalKey, input.sourceId]
  );
  const entityId = entity.rows[0]?.entity_id;
  if (!entityId) throw new Error(`Unable to allocate canonical entity for ${plan.cardCanonicalKey}`);

  const insertedPrinting = await db.query<{ entity_id: string }>(
    `INSERT INTO card_printings(
       entity_id,set_id,collector_number_raw,collector_number_normalized,printing_discriminator,name,rarity,illustrator
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(set_id,collector_number_normalized,printing_discriminator) DO NOTHING
     RETURNING entity_id`,
    [entityId, setId, plan.collectorNumberRaw, plan.collectorNumberNormalized, plan.printingDiscriminator, plan.name, plan.rarity ?? null, plan.illustrator ?? null]
  );

  if (!insertedPrinting.rows[0]) {
    // A concurrent bootstrap created the identity between candidate lookup and insert.
    const concurrent = await db.query<{ entity_id: string; name: string }>(
      `SELECT entity_id,name FROM card_printings
        WHERE set_id=$1 AND collector_number_normalized=$2 AND printing_discriminator=$3`,
      [setId, plan.collectorNumberNormalized, plan.printingDiscriminator]
    );
    const winner = concurrent.rows[0];
    if (!winner) throw new Error('Concurrent TCGdex bootstrap lost identity without a canonical winner');
    if (winner.entity_id !== entityId) {
      await db.query(`UPDATE catalog_entities SET status='MERGED', merged_into_id=$2, updated_at=now() WHERE entity_id=$1`, [entityId, winner.entity_id]);
    }
    if (normalizeTextV1(winner.name) !== plan.normalizedName) {
      await recordConflict(db, input.sourceRecordId, winner.entity_id, { type: 'IDENTITY_COLLISION', incomingName: plan.name, canonicalName: winner.name });
      await recordDecision(db, input.sourceRecordId, 'CONFLICT', winner.entity_id, 'TCGDEX_CONCURRENT_IDENTITY_COLLISION', 1, 1);
      await markPromoted(db, input.sourceRecordId, 'QUARANTINED', winner.entity_id);
      return { status: 'CONFLICT', entityId: winner.entity_id, setId, ruleId: 'TCGDEX_CONCURRENT_IDENTITY_COLLISION' };
    }
    await persistCardEvidence(db, { ...input, entityId: winner.entity_id, plan });
    await recordDecision(db, input.sourceRecordId, 'AUTO_MATCH', winner.entity_id, 'TCGDEX_CONCURRENT_DETERMINISTIC_IDENTITY', 0.995, 1);
    await markPromoted(db, input.sourceRecordId, 'CANONICAL', winner.entity_id);
    return { status: 'AUTO_MATCH', entityId: winner.entity_id, setId, ruleId: 'TCGDEX_CONCURRENT_DETERMINISTIC_IDENTITY' };
  }

  await persistCardEvidence(db, { ...input, entityId, plan });
  await recordDecision(db, input.sourceRecordId, 'NEW_ENTITY', entityId, 'TCGDEX_BOOTSTRAP_CREATE', 0.98, 0);
  await markPromoted(db, input.sourceRecordId, 'CANONICAL', entityId);
  return { status: 'NEW_ENTITY', entityId, setId, ruleId: 'TCGDEX_BOOTSTRAP_CREATE' };
}


async function mappedIdentityMismatch(db: SqlClient, entityId: string, plan: ReturnType<typeof buildTcgdexCanonicalPlan>): Promise<string[]> {
  const result = await db.query<{ name: string; collector_number_normalized: string; language_code: string; official_set_code: string | null }>(
    `SELECT cp.name,cp.collector_number_normalized,cs.language_code,cs.official_set_code
       FROM card_printings cp
       JOIN card_sets cs ON cs.entity_id=cp.set_id
      WHERE cp.entity_id=$1`,
    [entityId]
  );
  const current = result.rows[0];
  if (!current) return ['mapped external ID does not point to a CARD_PRINTING'];
  const mismatches: string[] = [];
  if (current.language_code !== plan.scopeLanguageCode) mismatches.push(`language ${current.language_code} != ${plan.scopeLanguageCode}`);
  if (current.collector_number_normalized !== plan.collectorNumberNormalized) mismatches.push(`collector ${current.collector_number_normalized} != ${plan.collectorNumberNormalized}`);
  if (current.official_set_code && current.official_set_code !== plan.set.officialSetCode) mismatches.push(`set ${current.official_set_code} != ${plan.set.officialSetCode}`);
  if (normalizeTextV1(current.name) !== plan.normalizedName) mismatches.push(`name ${current.name} != ${plan.name}`);
  return mismatches;
}

async function ensureSet(db: SqlClient, sourceId: string, sourceRecordId: string, plan: ReturnType<typeof buildTcgdexCanonicalPlan>): Promise<string> {
  const mapped = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM external_identifiers
      WHERE source_id=$1 AND namespace='sets' AND scope_language_code=$2 AND external_value=$3`,
    [sourceId, plan.scopeLanguageCode, plan.set.externalId]
  );
  if (mapped.rows[0]) return mapped.rows[0].entity_id;

  const existing = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM card_sets WHERE language_code=$1 AND official_set_code=$2`,
    [plan.scopeLanguageCode, plan.set.officialSetCode]
  );
  let setId = existing.rows[0]?.entity_id;

  if (!setId) {
    const entity = await db.query<{ entity_id: string }>(
      `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
       VALUES ('SET',$1,'CANONICAL','BOOTSTRAP_TCGDEX',$2)
       ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()
       RETURNING entity_id`,
      [plan.set.canonicalKey, sourceId]
    );
    setId = entity.rows[0]?.entity_id;
    if (!setId) throw new Error(`Unable to allocate set ${plan.set.canonicalKey}`);

    await db.query(
      `INSERT INTO card_sets(entity_id,language_code,official_name,official_set_code,printed_card_count,total_card_count)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(entity_id) DO UPDATE SET
         official_name=EXCLUDED.official_name,
         printed_card_count=COALESCE(EXCLUDED.printed_card_count,card_sets.printed_card_count),
         total_card_count=COALESCE(EXCLUDED.total_card_count,card_sets.total_card_count)`,
      [setId, plan.scopeLanguageCode, plan.set.officialName, plan.set.officialSetCode, plan.set.printedCardCount ?? null, plan.set.totalCardCount ?? null]
    );
  }

  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
     VALUES ($1,$2,'sets',$3,$4,$5,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value)
     DO UPDATE SET verified=true`,
    [setId, sourceId, plan.set.externalId, plan.scopeLanguageCode, sourceRecordId]
  );
  return setId;
}

async function persistCardEvidence(
  db: SqlClient,
  input: { sourceId: string; sourceRecordId: string; entityId: string; normalized: NormalizedTcgdexCard; plan: ReturnType<typeof buildTcgdexCanonicalPlan> }
): Promise<void> {
  const { sourceId, sourceRecordId, entityId, plan } = input;

  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
     VALUES ($1,$2,'cards',$3,$4,$5,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value)
     DO UPDATE SET verified=true, source_record_id=EXCLUDED.source_record_id`,
    [entityId, sourceId, plan.externalCardId, plan.scopeLanguageCode, sourceRecordId]
  );

  for (const alias of plan.aliases) {
    await db.query(
      `INSERT INTO entity_aliases(entity_id,language_code,alias,alias_normalized,alias_type,source_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [entityId, alias.languageCode, alias.raw, alias.normalized, alias.aliasType, sourceId]
    );
  }

  for (const fp of plan.fingerprints) {
    await db.query(
      `INSERT INTO entity_fingerprints(entity_id,fingerprint_type,fingerprint_version,canonical_payload,fingerprint_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(entity_id,fingerprint_type,fingerprint_version)
       DO UPDATE SET canonical_payload=EXCLUDED.canonical_payload,fingerprint_hash=EXCLUDED.fingerprint_hash`,
      [entityId, fp.type, fp.version, fp.payload, Buffer.from(fp.sha256, 'hex')]
    );
  }

  for (const assertion of plan.assertions) {
    await db.query(
      `INSERT INTO source_assertions(
         entity_id,source_record_id,field_path,value_json,normalized_value,value_hash,confidence
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
       ON CONFLICT(source_record_id,entity_id,field_path,value_hash)
       DO UPDATE SET last_seen_at=now(),status='ACTIVE',confidence=EXCLUDED.confidence`,
      [
        entityId,
        sourceRecordId,
        assertion.fieldPath,
        JSON.stringify(assertion.value),
        JSON.stringify(assertion.normalizedValue),
        Buffer.from(assertion.valueHashHex, 'hex'),
        assertion.confidence
      ]
    );
  }

  if (plan.imageUrl) {
    const existing = await db.query<{ image_id: string }>(
      `SELECT image_id FROM image_origins WHERE source_id=$1 AND source_url=$2`,
      [sourceId, plan.imageUrl]
    );
    let imageId = existing.rows[0]?.image_id;
    if (!imageId) {
      const image = await db.query<{ image_id: string }>(`INSERT INTO images DEFAULT VALUES RETURNING image_id`);
      imageId = image.rows[0]?.image_id;
      if (!imageId) throw new Error('Unable to allocate image row');
      await db.query(
        `INSERT INTO image_origins(
           image_id,source_id,source_record_id,source_url,rights_status,redistribution_status,indexing_allowed,display_allowed
         ) VALUES ($1,$2,$3,$4,'UNKNOWN','UNKNOWN',false,false)
         ON CONFLICT(source_id,source_url) DO NOTHING`,
        [imageId, sourceId, sourceRecordId, plan.imageUrl]
      );
      const winner = await db.query<{ image_id: string }>(`SELECT image_id FROM image_origins WHERE source_id=$1 AND source_url=$2`, [sourceId, plan.imageUrl]);
      imageId = winner.rows[0]?.image_id ?? imageId;
    }
    await db.query(
      `INSERT INTO entity_images(entity_id,image_id,role,view_type,is_primary,sort_order)
       VALUES ($1,$2,'REFERENCE','FRONT',false,0)
       ON CONFLICT(entity_id,image_id,role,view_type) DO NOTHING`,
      [entityId, imageId]
    );
  }
}

async function recordDecision(
  db: SqlClient,
  sourceRecordId: string,
  status: 'AUTO_MATCH' | 'CONFLICT' | 'NEW_ENTITY',
  matchedEntityId: string | undefined,
  ruleId: string,
  confidence: number,
  candidateCount: number,
  contradictions: string[] = []
): Promise<void> {
  await db.query(
    `INSERT INTO resolution_decisions(
       source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [sourceRecordId, status, matchedEntityId ?? null, ruleId, 'tcgdex-bootstrap-v0.1', candidateCount, confidence, JSON.stringify({ source: 'tcgdex' }), JSON.stringify(contradictions)]
  );
}

async function recordConflict(db: SqlClient, sourceRecordId: string, entityId: string, evidence: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status)
     VALUES ($1,'IDENTITY_COLLISION','HIGH',ARRAY[$2]::uuid[],$3::jsonb,'OPEN')`,
    [sourceRecordId, entityId, JSON.stringify(evidence)]
  );
}

async function markPromoted(db: SqlClient, sourceRecordId: string, status: 'CANONICAL' | 'QUARANTINED', entityId: string): Promise<void> {
  await db.query(
    `UPDATE source_records
        SET promotion_status=$2,promoted_entity_id=$3,promoted_at=now(),last_seen_at=now()
      WHERE source_record_id=$1`,
    [sourceRecordId, status, entityId]
  );
}

export function payloadHash(payload: unknown): unknown {
  return createHash('sha256').update(JSON.stringify(payload)).digest();
}
