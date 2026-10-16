BEGIN;

-- Keep the raw market record that produced an observation so every price can be
-- traced back to an immutable source record.
ALTER TABLE market_observations
  ADD COLUMN IF NOT EXISTS source_record_id uuid NULL REFERENCES source_records(source_record_id);

CREATE INDEX IF NOT EXISTS market_observations_source_record_idx
  ON market_observations(source_record_id)
  WHERE source_record_id IS NOT NULL;

-- A provider product can enrich one or more canonical entities without claiming
-- that the provider's product ID is itself our canonical identity. This is
-- especially important for Cardmarket products whose market data can be less
-- language-specific than our CARD_PRINTING entities.
CREATE TABLE IF NOT EXISTS source_entity_links (
  link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_by_source_id uuid NOT NULL REFERENCES data_sources(source_id),
  origin_source_id uuid NOT NULL REFERENCES data_sources(source_id),
  namespace text NOT NULL,
  external_value text NOT NULL,
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  scope_language_code varchar(16) NOT NULL DEFAULT '',
  scope_region_code varchar(16) NULL,
  mapping_status text NOT NULL CHECK (mapping_status IN ('VERIFIED','CANDIDATE','REJECTED','CONFLICT')),
  mapping_method text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_record_id uuid NULL REFERENCES source_records(source_record_id),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(reported_by_source_id, namespace, external_value, entity_id)
);

CREATE INDEX IF NOT EXISTS source_entity_links_lookup_idx
  ON source_entity_links(reported_by_source_id, namespace, external_value, mapping_status);
CREATE INDEX IF NOT EXISTS source_entity_links_entity_idx
  ON source_entity_links(entity_id, mapping_status);
CREATE UNIQUE INDEX IF NOT EXISTS source_entity_links_verified_scoped_unique
  ON source_entity_links(origin_source_id, namespace, external_value, scope_language_code)
  WHERE mapping_status='VERIFIED';

-- Exact enrichment matching is intentionally narrow: number + language/name
-- filtering is done by the worker, while these indexes keep the candidate set
-- small.
CREATE INDEX IF NOT EXISTS card_printings_number_name_idx
  ON card_printings(collector_number_normalized, lower(name));
CREATE INDEX IF NOT EXISTS card_sets_language_name_idx
  ON card_sets(language_code, lower(official_name));

-- Source lineage: TCGCSV republishes/cache-reports TCGplayer catalogue/market
-- data, so it must not count as an independent market origin.
INSERT INTO source_lineage(reported_by_source_id, origin_source_id, domain, relationship_type)
SELECT reporter.source_id, origin.source_id, x.domain, 'CACHE'
FROM data_sources reporter
JOIN data_sources origin ON origin.source_code='tcgplayer'
CROSS JOIN (VALUES ('CARD_IDENTITY'),('MARKET_PRICE'),('IMAGE_REFERENCE')) AS x(domain)
WHERE reporter.source_code='tcgcsv'
ON CONFLICT DO NOTHING;

-- Field-scoped trust policies for the two connectors. These are deliberately
-- conservative: neither connector can create a CARD_PRINTING in this slice.
INSERT INTO source_field_policies(
  source_id,domain,field_path,tier,resolution_capability,creation_policy,
  can_assert,can_override,requires_corroboration,minimum_independent_origins,notes
)
SELECT s.source_id, v.domain, NULL, v.tier::trust_tier, v.capability, 'NEVER_CREATE', true, false, v.corroborate, 1, v.notes
FROM data_sources s
JOIN (VALUES
  ('cardmarket','CARD_IDENTITY','B'::text,'DETERMINISTIC_AUTO_MATCH',true,'Cardmarket catalogue may enrich an existing printing; never creates one.'),
  ('cardmarket','MARKET_PRICE','A'::text,'OBSERVATION_ONLY',false,'Cardmarket is authoritative for its own price-guide metrics.'),
  ('tcgcsv','CARD_IDENTITY','B'::text,'DETERMINISTIC_AUTO_MATCH',true,'TCGCSV reports cached TCGplayer products and only enriches existing printings.'),
  ('tcgcsv','MARKET_PRICE','B_PLUS'::text,'OBSERVATION_ONLY',false,'Reported by TCGCSV, originated from TCGplayer.'),
  ('tcgplayer','MARKET_PRICE','A'::text,'OBSERVATION_ONLY',false,'Origin marketplace for TCGCSV market prices.')
) AS v(source_code,domain,tier,capability,corroborate,notes)
  ON s.source_code=v.source_code
ON CONFLICT DO NOTHING;

COMMIT;
