BEGIN;

-- Sealed products need a stable structural signature independent from provider IDs.
ALTER TABLE sealed_products
  ADD COLUMN IF NOT EXISTS normalized_name text NULL,
  ADD COLUMN IF NOT EXISTS structural_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS matching_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS source_confidence numeric(5,4) NULL CHECK (source_confidence IS NULL OR source_confidence BETWEEN 0 AND 1);

CREATE INDEX IF NOT EXISTS sealed_products_matching_fingerprint_idx
  ON sealed_products(matching_fingerprint)
  WHERE matching_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS sealed_products_structural_fingerprint_idx
  ON sealed_products(structural_fingerprint)
  WHERE structural_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS sealed_products_name_language_region_idx
  ON sealed_products(normalized_name, language_code, region_code);
CREATE INDEX IF NOT EXISTS sealed_families_type_name_idx
  ON sealed_families(product_type, lower(canonical_name));

-- Barcode representations now retain first-class provenance through claims.
CREATE TABLE IF NOT EXISTS barcode_claims (
  claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode_id uuid NOT NULL REFERENCES barcodes(barcode_id),
  source_record_id uuid NOT NULL REFERENCES source_records(source_record_id),
  source_id uuid NOT NULL REFERENCES data_sources(source_id),
  entity_id uuid NULL REFERENCES catalog_entities(entity_id),
  namespace text NOT NULL DEFAULT 'products',
  source_external_value text NULL,
  scheme text NOT NULL CHECK (scheme IN ('UPC_A','EAN_13','JAN_13','GTIN_14')),
  raw_value text NOT NULL,
  claim_status text NOT NULL CHECK (claim_status IN ('CANDIDATE','VERIFIED','REJECTED','CONFLICT')),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS barcode_claims_unique_idx
  ON barcode_claims(source_record_id, scheme, raw_value, COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS barcode_claims_barcode_idx ON barcode_claims(barcode_id, claim_status);
CREATE INDEX IF NOT EXISTS barcode_claims_entity_idx ON barcode_claims(entity_id, claim_status) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS barcode_claims_source_product_idx ON barcode_claims(source_id, namespace, source_external_value) WHERE source_external_value IS NOT NULL;

-- Make raw representations canonicalized and searchable regardless of provider.
CREATE INDEX IF NOT EXISTS barcode_representations_barcode_idx ON barcode_representations(barcode_id);

-- TCGCSV is a cache/reporter of TCGplayer sealed identity too.
INSERT INTO source_lineage(reported_by_source_id, origin_source_id, domain, relationship_type)
SELECT reporter.source_id, origin.source_id, 'SEALED_IDENTITY', 'CACHE'
FROM data_sources reporter
JOIN data_sources origin ON origin.source_code='tcgplayer'
WHERE reporter.source_code='tcgcsv'
ON CONFLICT DO NOTHING;

-- Conservative sealed policy: connectors may create STAGED entities. Promotion to
-- CANONICAL requires corroboration or a verified physical identifier.
INSERT INTO source_field_policies(
  source_id,domain,field_path,tier,resolution_capability,creation_policy,
  can_assert,can_override,requires_corroboration,minimum_independent_origins,notes
)
SELECT s.source_id, v.domain, NULL, v.tier::trust_tier, v.capability, v.creation_policy,
       true, false, v.corroborate, v.min_origins, v.notes
FROM data_sources s
JOIN (VALUES
  ('cardmarket','SEALED_IDENTITY','B_PLUS'::text,'DETERMINISTIC_AUTO_MATCH','CREATE_STAGED',true,2,'Cardmarket non-singles can seed staged sealed products; exact cross-source corroboration promotes them.'),
  ('tcgcsv','SEALED_IDENTITY','B'::text,'DETERMINISTIC_AUTO_MATCH','CREATE_STAGED',true,2,'TCGCSV/TCGplayer sealed products can seed staged identities but do not independently prove physical region/SKU.'),
  ('internal_verified','BARCODE','A_PLUS'::text,'DIRECT_AUTO_MATCH','NEVER_CREATE',false,1,'Verified GTIN registry may deterministically resolve a sealed product.'),
  ('user_observation','BARCODE','D'::text,'CANDIDATE_ONLY','NEVER_CREATE',true,2,'User scans are barcode claims until independently verified.')
) AS v(source_code,domain,tier,capability,creation_policy,corroborate,min_origins,notes)
  ON s.source_code=v.source_code
ON CONFLICT DO NOTHING;

COMMIT;
