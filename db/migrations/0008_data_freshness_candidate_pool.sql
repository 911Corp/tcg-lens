-- v0.3.1 Data Freshness + Candidate Intelligence
--
-- Adds release staging, product medium (physical vs digital-only), image availability probes,
-- versioned visual-index builds and per-set coverage/readiness runs.
--
-- Doctrine preserved:
--   * nothing here participates in identity resolution scoring;
--   * market data stays out of identity (coverage only *reports* market mappings);
--   * release status is derived from release_date as of an explicit date, never guessed.
BEGIN;

ALTER TABLE card_sets
  ADD COLUMN IF NOT EXISTS series_external_id text NULL,
  ADD COLUMN IF NOT EXISTS series_name text NULL,
  ADD COLUMN IF NOT EXISTS official_abbreviation text NULL,
  ADD COLUMN IF NOT EXISTS product_medium text NOT NULL DEFAULT 'PHYSICAL'
    CHECK (product_medium IN ('PHYSICAL', 'DIGITAL_ONLY')),
  ADD COLUMN IF NOT EXISTS release_status_override text NULL
    CHECK (release_status_override IN ('RELEASED', 'UPCOMING', 'PRERELEASE', 'WITHDRAWN')),
  ADD COLUMN IF NOT EXISTS release_status_override_reason text NULL,
  ADD COLUMN IF NOT EXISTS source_expected_card_count integer NULL
    CHECK (source_expected_card_count IS NULL OR source_expected_card_count >= 0),
  ADD COLUMN IF NOT EXISTS metadata_refreshed_at timestamptz NULL;

-- Release status as of an explicit date. UPCOMING sets are staged: catalogued, but never part of the
-- ordinary live candidate pool unless prerelease mode is requested explicitly.
CREATE OR REPLACE FUNCTION card_set_release_status(p_release_date date, p_override text, p_as_of date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_override IS NOT NULL THEN p_override
    WHEN p_release_date IS NULL THEN 'UNKNOWN'
    WHEN p_release_date > p_as_of THEN 'UPCOMING'
    ELSE 'RELEASED'
  END
$$;

-- Cross-source collector-number comparison key (zero-padding insensitive). Comparison only;
-- canonical keys and collector_number_normalized are unchanged. Mirrors collectorNumberMatchKeyV1().
CREATE OR REPLACE FUNCTION collector_number_match_key(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_value IS NULL THEN '' ELSE
    regexp_replace(lower(regexp_replace(normalize(p_value, NFC), '\s+', '', 'g')), '(^|[^0-9])0+([0-9])', '\1\2', 'g')
  END
$$;
CREATE INDEX IF NOT EXISTS card_printings_collector_match_idx
  ON card_printings (collector_number_match_key(collector_number_normalized));

-- Reverse-lookup indexes needed by coverage audits and enrichment at full-catalog scale.
CREATE INDEX IF NOT EXISTS external_identifiers_entity_idx ON external_identifiers(entity_id, source_id, namespace);
CREATE INDEX IF NOT EXISTS source_assertions_entity_field_idx ON source_assertions(entity_id, field_path);
CREATE INDEX IF NOT EXISTS source_records_promoted_entity_idx ON source_records(promoted_entity_id) WHERE promoted_entity_id IS NOT NULL;

-- Source-asserted variant attributes (TCGdex variants / variants_detailed). Assertions, not proof.
ALTER TABLE card_variants
  ADD COLUMN IF NOT EXISTS source_variant_id text NULL,
  ADD COLUMN IF NOT EXISTS size_code text NULL;

-- HTTP availability of a source image as of checked_at. A URL listed by a source is not evidence
-- that a usable reference image exists.
CREATE TABLE IF NOT EXISTS image_probes (
  image_origin_id uuid PRIMARY KEY REFERENCES image_origins(image_origin_id) ON DELETE CASCADE,
  probe_url text NOT NULL,
  http_status integer NULL,
  content_type text NULL,
  content_length bigint NULL,
  ok boolean NOT NULL,
  error text NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS image_probes_ok_idx ON image_probes(ok, checked_at);

-- A visual-index build is the exact, versioned set of reference printings the Lens may use as
-- candidates. Exclusions are recorded with a reason so coverage gaps are auditable.
CREATE TABLE IF NOT EXISTS visual_index_builds (
  build_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_label text NOT NULL,
  as_of date NOT NULL,
  include_prerelease boolean NOT NULL DEFAULT false,
  descriptor_kind text NOT NULL,
  descriptor_version text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visual_index_entries (
  build_id uuid NOT NULL REFERENCES visual_index_builds(build_id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  set_id uuid NOT NULL REFERENCES card_sets(entity_id),
  language_code varchar(16) NOT NULL,
  image_origin_id uuid NULL REFERENCES image_origins(image_origin_id),
  eligible boolean NOT NULL,
  exclusion_reason text NULL,
  visual_only_lock_allowed boolean NOT NULL DEFAULT false,
  lock_blocked_reason text NULL,
  artwork_twin_count integer NOT NULL DEFAULT 0,
  descriptor vector NULL,
  PRIMARY KEY (build_id, entity_id),
  CHECK (eligible OR exclusion_reason IS NOT NULL),
  CHECK (NOT visual_only_lock_allowed OR eligible)
);
-- Columns added after the table first shipped in this migration (keeps re-application idempotent).
ALTER TABLE visual_index_entries
  ADD COLUMN IF NOT EXISTS lock_blocked_reason text NULL,
  ADD COLUMN IF NOT EXISTS artwork_twin_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS visual_index_entries_pool_idx
  ON visual_index_entries(build_id, language_code, eligible);

CREATE TABLE IF NOT EXISTS coverage_runs (
  coverage_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of date NOT NULL,
  visual_index_build_id uuid NULL REFERENCES visual_index_builds(build_id),
  thresholds jsonb NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS set_coverage (
  coverage_run_id uuid NOT NULL REFERENCES coverage_runs(coverage_run_id) ON DELETE CASCADE,
  set_id uuid NOT NULL REFERENCES card_sets(entity_id),
  language_code varchar(16) NOT NULL,
  release_status text NOT NULL,
  product_medium text NOT NULL,
  readiness text NOT NULL CHECK (readiness IN (
    'EXCLUDED', 'DISCOVERED', 'CATALOGUED', 'IDENTITY_COMPLETE', 'VISUAL_COMPLETE', 'MARKET_READY', 'LENS_READY'
  )),
  metrics jsonb NOT NULL,
  blockers text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (coverage_run_id, set_id)
);
CREATE INDEX IF NOT EXISTS set_coverage_readiness_idx ON set_coverage(coverage_run_id, language_code, readiness);

COMMIT;
