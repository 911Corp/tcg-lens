BEGIN;

-- Localized source IDs are not globally unique across FR/EN/JP. Make the
-- source scope explicit instead of encoding the language into external IDs.
ALTER TABLE source_records
  ADD COLUMN IF NOT EXISTS scope_language_code varchar(16) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scope_region_code varchar(16) NULL,
  ADD COLUMN IF NOT EXISTS promotion_status text NOT NULL DEFAULT 'STAGED',
  ADD COLUMN IF NOT EXISTS promoted_entity_id uuid NULL REFERENCES catalog_entities(entity_id),
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz NULL;

ALTER TABLE source_records
  DROP CONSTRAINT IF EXISTS source_records_source_id_namespace_external_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS source_records_scoped_external_key_unique
  ON source_records(source_id, namespace, scope_language_code, external_key);

CREATE INDEX IF NOT EXISTS source_records_promotion_queue_idx
  ON source_records(source_id, promotion_status, scope_language_code, namespace, last_seen_at);

ALTER TABLE external_identifiers
  ADD COLUMN IF NOT EXISTS scope_language_code varchar(16) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scope_region_code varchar(16) NULL;

ALTER TABLE external_identifiers
  DROP CONSTRAINT IF EXISTS external_identifiers_source_id_namespace_external_value_key;

CREATE UNIQUE INDEX IF NOT EXISTS external_identifiers_scoped_value_unique
  ON external_identifiers(source_id, namespace, scope_language_code, external_value);

ALTER TABLE catalog_entities
  ADD COLUMN IF NOT EXISTS canonicalization_method text NOT NULL DEFAULT 'MANUAL_OR_LEGACY',
  ADD COLUMN IF NOT EXISTS canonical_source_id uuid NULL REFERENCES data_sources(source_id);

-- Fast exact identity lookup for TCGdex promotion.
CREATE INDEX IF NOT EXISTS card_printings_exact_identity_idx
  ON card_printings(set_id, collector_number_normalized, printing_discriminator, lower(name));

-- A source record can be resolved multiple times historically; this gives a
-- cheap way to fetch the latest decision during reconciliation/admin review.
CREATE INDEX IF NOT EXISTS resolution_decisions_source_record_latest_idx
  ON resolution_decisions(source_record_id, created_at DESC);

COMMIT;
