/**
 * v0.3.1 — TCGdex set metadata (release date, series, medium, expected count) and
 * CARD_PRINTING -> CARD_VARIANT promotion.
 *
 * Variant rows are source assertions about which finishes/stamps exist for a printing. They do not
 * make the Lens claim a variant: the scanner only displays a variant when it is physically proven.
 * Marketplace IDs embedded by TCGdex are stored as provenance-only assertions, never as verified
 * external identifiers (verified mappings come from Cardmarket / TCGCSV enrichment).
 */
import { createHash } from 'node:crypto';
import {
  buildTcgdexVariantPlan,
  classifyTcgdexSetMedium,
  normalizeTextV1,
  type TcgdexCard,
  type TcgdexLanguage,
  type TcgdexSet,
  type TcgdexVariantDetail
} from '../../../packages/ingestion/src/index.js';
import type { SqlClient } from './tcgdex-canonical.js';

export async function applyTcgdexSetMetadata(db: SqlClient, input: {
  sourceId: string;
  language: TcgdexLanguage;
  set: TcgdexSet;
  sourceRecordId?: string;
}): Promise<{ setId: string; created: boolean }> {
  const { set, language } = input;
  const medium = classifyTcgdexSetMedium(set);
  const listed = Array.isArray(set.cards) ? set.cards.length : null;
  const expected = Math.max(listed ?? 0, set.cardCount?.total ?? 0) || null;
  const releaseDate = typeof set.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(set.releaseDate) ? set.releaseDate.slice(0, 10) : null;
  const abbreviation = typeof set.abbreviation?.official === 'string' ? set.abbreviation.official : null;

  const mapped = await db.query<{ entity_id: string }>(
    `SELECT entity_id FROM external_identifiers WHERE source_id=$1 AND namespace='sets' AND scope_language_code=$2 AND external_value=$3`,
    [input.sourceId, language, set.id]
  );
  let setId = mapped.rows[0]?.entity_id;
  let created = false;
  if (!setId) {
    const existing = await db.query<{ entity_id: string }>(`SELECT entity_id FROM card_sets WHERE language_code=$1 AND official_set_code=$2`, [language, set.id]);
    setId = existing.rows[0]?.entity_id;
  }
  if (!setId) {
    // A set discovered from the set listing before any of its cards (e.g. a set TCGdex lists with 0 cards).
    const keyPart = normalizeTextV1(set.id).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
    const entity = await db.query<{ entity_id: string }>(
      `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
       VALUES ('SET',$1,'CANONICAL','BOOTSTRAP_TCGDEX',$2)
       ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()
       RETURNING entity_id`,
      [`set:${language}:${keyPart}`, input.sourceId]
    );
    setId = entity.rows[0]?.entity_id;
    if (!setId) throw new Error(`Unable to allocate set ${language}:${set.id}`);
    await db.query(
      `INSERT INTO card_sets(entity_id,language_code,official_name,official_set_code,printed_card_count,total_card_count)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(entity_id) DO NOTHING`,
      [setId, language, set.name, set.id, set.cardCount?.official ?? null, set.cardCount?.total ?? null]
    );
    created = true;
  }
  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
     VALUES ($1,$2,'sets',$3,$4,$5,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value) DO UPDATE SET verified=true`,
    [setId, input.sourceId, set.id, language, input.sourceRecordId ?? null]
  );
  await db.query(
    `UPDATE card_sets SET
        official_name=$2,
        release_date=$3,
        series_external_id=$4,
        series_name=$5,
        official_abbreviation=$6,
        product_medium=$7,
        printed_card_count=COALESCE($8,printed_card_count),
        total_card_count=COALESCE($9,total_card_count),
        source_expected_card_count=$10,
        metadata_refreshed_at=now()
      WHERE entity_id=$1`,
    [setId, set.name, releaseDate, set.serie?.id ?? null, set.serie?.name ?? null, abbreviation, medium,
     set.cardCount?.official ?? null, set.cardCount?.total ?? null, expected]
  );
  return { setId, created };
}

export async function promoteTcgdexVariants(db: SqlClient, input: {
  sourceId: string;
  sourceRecordId: string;
  printingEntityId: string;
  card: TcgdexCard & { variants_detailed?: TcgdexVariantDetail[] };
}): Promise<number> {
  const plans = buildTcgdexVariantPlan(input.card);
  const printing = await db.query<{ canonical_key: string }>(`SELECT canonical_key FROM catalog_entities WHERE entity_id=$1`, [input.printingEntityId]);
  const printingKey = printing.rows[0]?.canonical_key;
  if (!printingKey) throw new Error(`Printing ${input.printingEntityId} not found`);
  let written = 0;
  for (const plan of plans) {
    const variantKey = `variant:${printingKey.replace(/^card:/, '')}:${plan.variantCode}`;
    const existing = await db.query<{ entity_id: string }>(
      `SELECT entity_id FROM card_variants WHERE printing_id=$1 AND variant_code=$2`, [input.printingEntityId, plan.variantCode]
    );
    let variantId = existing.rows[0]?.entity_id;
    if (!variantId) {
      const entity = await db.query<{ entity_id: string }>(
        `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
         VALUES ('CARD_VARIANT',$1,'CANONICAL','BOOTSTRAP_TCGDEX',$2)
         ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()
         RETURNING entity_id`,
        [variantKey, input.sourceId]
      );
      variantId = entity.rows[0]?.entity_id;
      if (!variantId) throw new Error(`Unable to allocate variant ${variantKey}`);
      await db.query(
        `INSERT INTO card_variants(entity_id,printing_id,variant_code,finish,edition_mark,stamp,foil_pattern,variant_fingerprint,source_variant_id,size_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(printing_id,variant_code) DO NOTHING`,
        [variantId, input.printingEntityId, plan.variantCode, plan.finish, plan.editionMark, plan.stamp, plan.foilPattern, plan.fingerprint, plan.sourceVariantId, plan.sizeCode]
      );
      written++;
    } else {
      await db.query(`UPDATE card_variants SET source_variant_id=COALESCE($2,source_variant_id) WHERE entity_id=$1`, [variantId, plan.sourceVariantId]);
    }
    const asserted: Record<string, unknown> = {
      tcgdex_variant_id: plan.sourceVariantId,
      tcgdex_asserted_cardmarket_product_id: plan.assertedCardmarketId,
      tcgdex_asserted_tcgplayer_product_id: plan.assertedTcgplayerId
    };
    for (const [field, value] of Object.entries(asserted)) {
      if (value == null) continue;
      const hash = createHash('sha256').update(`${field}|${JSON.stringify(value)}`).digest();
      await db.query(
        `INSERT INTO source_assertions(entity_id,source_record_id,field_path,value_json,normalized_value,value_hash,confidence)
         VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,$5,0.80)
         ON CONFLICT(source_record_id,entity_id,field_path,value_hash) DO UPDATE SET last_seen_at=now(),status='ACTIVE'`,
        [variantId, input.sourceRecordId, field, JSON.stringify(value), hash]
      );
    }
  }
  return written;
}
