-- v0.3.1 maintenance (idempotent): demote TCGplayer mappings that were AUTO_MATCHed only by the
-- retired rule TCGCSV_NUMBER_NAME_LANGUAGE_UNIQUE (name + number + language, no set/group agreement)
-- and never confirmed by a set-anchored rule. Removes their price observations, rejects the links and
-- records an audit decision. Run `npm run import:tcgplayer:crosswalk` afterwards to re-add mappings
-- that TCGdex's asserted TCGplayer IDs confirm.
BEGIN;

CREATE TEMP TABLE weak_tp_mappings ON COMMIT DROP AS
SELECT DISTINCT rd.matched_entity_id AS entity_id, sr.external_key AS product_id, sr.scope_language_code AS lang, sr.source_record_id
  FROM resolution_decisions rd
  JOIN source_records sr ON sr.source_record_id = rd.source_record_id
  JOIN data_sources ds ON ds.source_id = sr.source_id AND ds.source_code = 'tcgcsv'
 WHERE rd.rule_id = 'TCGCSV_NUMBER_NAME_LANGUAGE_UNIQUE' AND rd.resolution_status = 'AUTO_MATCH'
   AND NOT EXISTS (
     SELECT 1 FROM resolution_decisions strong
      WHERE strong.source_record_id = rd.source_record_id
        AND strong.matched_entity_id = rd.matched_entity_id
        AND strong.resolution_status = 'AUTO_MATCH'
        AND strong.rule_id IN ('TCGCSV_NUMBER_NAME_GROUP_EXACT', 'TP_XWALK_ID_NUMBER_NAME_CONFIRMED', 'TP_XWALK_ID_NUMBER_GROUP_CONFIRMED'));

DELETE FROM market_observations mo
 USING weak_tp_mappings w, data_sources tp
 WHERE tp.source_code = 'tcgplayer' AND mo.origin_source = tp.source_id
   AND mo.entity_id = w.entity_id AND mo.metadata->>'tcgplayer_product_id' = w.product_id;

UPDATE source_entity_links sel SET mapping_status = 'REJECTED', updated_at = now()
  FROM weak_tp_mappings w, data_sources tc
 WHERE tc.source_code = 'tcgcsv' AND sel.reported_by_source_id = tc.source_id
   AND sel.namespace = 'products' AND sel.external_value = w.product_id AND sel.entity_id = w.entity_id
   AND sel.mapping_status <> 'REJECTED';

DELETE FROM external_identifiers ei
 USING weak_tp_mappings w, data_sources tp
 WHERE tp.source_code = 'tcgplayer' AND ei.source_id = tp.source_id AND ei.namespace = 'products'
   AND ei.external_value = w.product_id AND ei.scope_language_code = w.lang AND ei.entity_id = w.entity_id;

UPDATE source_records sr SET promotion_status = 'STAGED', promoted_entity_id = NULL, promoted_at = NULL
  FROM weak_tp_mappings w
 WHERE sr.source_record_id = w.source_record_id AND sr.promotion_status = 'CANONICAL';

INSERT INTO resolution_decisions(source_record_id,resolution_status,matched_entity_id,rule_id,rule_version,candidate_count,confidence,evidence_json,contradictions_json)
SELECT w.source_record_id, 'CANDIDATE_MATCH', NULL, 'TCGCSV_UNANCHORED_MAPPING_DEMOTED', 'market-enrichment-v0.3.1', 1, 0.75,
       jsonb_build_object('enrichment_only', true, 'demoted_entity', w.entity_id, 'product_id', w.product_id), '[]'::jsonb
  FROM weak_tp_mappings w
 WHERE NOT EXISTS (SELECT 1 FROM resolution_decisions d WHERE d.source_record_id = w.source_record_id AND d.rule_id = 'TCGCSV_UNANCHORED_MAPPING_DEMOTED');

-- Crosswalk conflicts raised only because a demoted mapping occupied the product ID are stale.
UPDATE data_conflicts dc SET status = 'RESOLVED', resolved_at = now()
 WHERE dc.conflict_type = 'MARKET_MAPPING_CONFLICT' AND dc.status = 'OPEN'
   AND dc.evidence->>'ruleId' = 'TP_XWALK_EXISTING_MAPPING_DISAGREES'
   AND NOT EXISTS (
     SELECT 1 FROM external_identifiers ei JOIN data_sources tp ON tp.source_id = ei.source_id AND tp.source_code = 'tcgplayer'
      WHERE ei.namespace = 'products' AND ei.external_value = dc.evidence->>'productId' AND ei.entity_id = dc.entity_ids[2]);

SELECT count(*) AS demoted_mappings FROM weak_tp_mappings;
COMMIT;
