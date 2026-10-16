BEGIN;

CREATE TYPE catalog_entity_type AS ENUM (
  'SET_FAMILY','SET','CARD_CONCEPT','CARD_PRINTING','CARD_VARIANT','SEALED_FAMILY','SEALED_PRODUCT'
);
CREATE TYPE catalog_entity_status AS ENUM ('ACTIVE','DEPRECATED','MERGED','REJECTED','REVIEW_REQUIRED');
CREATE TYPE resolution_state AS ENUM ('CANONICAL','STAGED','QUARANTINED','REJECTED');
CREATE TYPE trust_tier AS ENUM ('A_PLUS','A','B_PLUS','B','C','D','X');

CREATE TABLE catalog_entities (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type catalog_entity_type NOT NULL,
  canonical_key text NOT NULL UNIQUE,
  status catalog_entity_status NOT NULL DEFAULT 'ACTIVE',
  resolution_state resolution_state NOT NULL DEFAULT 'CANONICAL',
  merged_into_id uuid NULL REFERENCES catalog_entities(entity_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_into_id IS NULL OR merged_into_id <> entity_id)
);

CREATE TABLE set_families (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  internal_name text NOT NULL,
  era text NULL
);

CREATE TABLE card_sets (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  family_id uuid NULL REFERENCES set_families(entity_id),
  language_code varchar(16) NOT NULL,
  region_code varchar(16) NULL,
  official_name text NOT NULL,
  official_set_code text NULL,
  release_date date NULL,
  printed_card_count integer NULL CHECK (printed_card_count IS NULL OR printed_card_count >= 0),
  total_card_count integer NULL CHECK (total_card_count IS NULL OR total_card_count >= 0)
);
CREATE UNIQUE INDEX card_sets_official_code_unique
  ON card_sets(language_code, official_set_code)
  WHERE official_set_code IS NOT NULL;

CREATE TABLE card_concepts (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  concept_kind text NULL,
  rules_fingerprint text NULL
);

CREATE TABLE card_printings (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  concept_id uuid NULL REFERENCES card_concepts(entity_id),
  set_id uuid NOT NULL REFERENCES card_sets(entity_id),
  collector_number_raw text NOT NULL,
  collector_number_normalized text NOT NULL,
  printing_discriminator text NOT NULL DEFAULT 'base',
  name text NOT NULL,
  rarity text NULL,
  supertype text NULL,
  illustrator text NULL,
  release_date date NULL,
  UNIQUE(set_id, collector_number_normalized, printing_discriminator)
);
CREATE INDEX card_printings_lookup_idx ON card_printings(set_id, collector_number_normalized);
CREATE INDEX card_printings_name_idx ON card_printings(lower(name));

CREATE TABLE card_variants (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  printing_id uuid NOT NULL REFERENCES card_printings(entity_id),
  variant_code text NOT NULL,
  finish text NULL,
  edition_mark text NULL,
  stamp text NULL,
  foil_pattern text NULL,
  texture_type text NULL,
  variant_fingerprint text NOT NULL,
  UNIQUE(printing_id, variant_code),
  UNIQUE(printing_id, variant_fingerprint)
);

CREATE TABLE sealed_families (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  canonical_name text NOT NULL,
  product_type text NOT NULL,
  brand_line text NULL
);

CREATE TABLE sealed_products (
  entity_id uuid PRIMARY KEY REFERENCES catalog_entities(entity_id) ON DELETE RESTRICT,
  family_id uuid NOT NULL REFERENCES sealed_families(entity_id),
  language_code varchar(16) NULL,
  region_code varchar(16) NULL,
  official_name text NOT NULL,
  packaging_variant text NOT NULL DEFAULT 'standard',
  manufacturer text NULL,
  manufacturer_sku text NULL,
  release_date date NULL,
  msrp_amount numeric(14,4) NULL CHECK (msrp_amount IS NULL OR msrp_amount >= 0),
  msrp_currency char(3) NULL
);
CREATE UNIQUE INDEX sealed_product_sku_unique
  ON sealed_products(manufacturer, region_code, manufacturer_sku)
  WHERE manufacturer_sku IS NOT NULL;

CREATE TABLE sealed_product_sets (
  sealed_product_id uuid NOT NULL REFERENCES sealed_products(entity_id),
  set_id uuid NOT NULL REFERENCES card_sets(entity_id),
  relationship_type text NOT NULL,
  PRIMARY KEY(sealed_product_id, set_id, relationship_type)
);

CREATE TABLE data_sources (
  source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  source_kind text NOT NULL,
  access_mode text NULL,
  base_url text NULL,
  license_name text NULL,
  terms_url text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_field_policies (
  policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES data_sources(source_id),
  domain text NOT NULL,
  field_path text NULL,
  tier trust_tier NOT NULL,
  resolution_capability text NOT NULL,
  creation_policy text NOT NULL,
  can_assert boolean NOT NULL DEFAULT true,
  can_override boolean NOT NULL DEFAULT false,
  requires_corroboration boolean NOT NULL DEFAULT false,
  minimum_independent_origins integer NOT NULL DEFAULT 1 CHECK (minimum_independent_origins >= 1),
  notes text NULL
);
CREATE UNIQUE INDEX source_field_policy_unique
  ON source_field_policies(source_id, domain, COALESCE(field_path, ''));

CREATE TABLE source_lineage (
  reported_by_source_id uuid NOT NULL REFERENCES data_sources(source_id),
  origin_source_id uuid NOT NULL REFERENCES data_sources(source_id),
  domain text NOT NULL,
  relationship_type text NOT NULL,
  PRIMARY KEY(reported_by_source_id, origin_source_id, domain)
);

CREATE TABLE entity_aliases (
  alias_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  language_code varchar(16) NULL,
  alias text NOT NULL,
  alias_normalized text NOT NULL,
  alias_type text NOT NULL,
  source_id uuid NULL REFERENCES data_sources(source_id)
);
CREATE UNIQUE INDEX entity_alias_unique
  ON entity_aliases(entity_id, COALESCE(language_code,''), alias_normalized, alias_type);

CREATE TABLE images (
  image_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 bytea NULL UNIQUE,
  perceptual_hash text NULL,
  mime_type text NULL,
  width integer NULL CHECK (width IS NULL OR width > 0),
  height integer NULL CHECK (height IS NULL OR height > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE image_origins (
  image_origin_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id uuid NOT NULL REFERENCES images(image_id),
  source_id uuid NOT NULL REFERENCES data_sources(source_id),
  source_record_id uuid NULL,
  source_url text NOT NULL,
  rights_status text NOT NULL,
  redistribution_status text NOT NULL,
  indexing_allowed boolean NOT NULL DEFAULT false,
  display_allowed boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, source_url)
);

CREATE TABLE entity_images (
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  image_id uuid NOT NULL REFERENCES images(image_id),
  role text NOT NULL,
  view_type text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY(entity_id, image_id, role, view_type)
);
CREATE UNIQUE INDEX entity_primary_image_unique
  ON entity_images(entity_id, role, view_type)
  WHERE is_primary;

CREATE TABLE barcodes (
  barcode_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gtin14 char(14) NOT NULL UNIQUE,
  checksum_valid boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE barcode_representations (
  barcode_id uuid NOT NULL REFERENCES barcodes(barcode_id),
  scheme text NOT NULL,
  raw_value text NOT NULL,
  PRIMARY KEY(scheme, raw_value)
);

CREATE TABLE entity_barcodes (
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  barcode_id uuid NOT NULL REFERENCES barcodes(barcode_id),
  source_record_id uuid NULL,
  status text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NULL,
  PRIMARY KEY(entity_id, barcode_id)
);
CREATE UNIQUE INDEX verified_barcode_unique
  ON entity_barcodes(barcode_id)
  WHERE status = 'VERIFIED';

CREATE TABLE market_venues (
  venue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  region_code varchar(16) NULL
);

CREATE TABLE market_observations (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  reported_by_source uuid NOT NULL REFERENCES data_sources(source_id),
  origin_source uuid NULL REFERENCES data_sources(source_id),
  venue_id uuid NULL REFERENCES market_venues(venue_id),
  observed_at timestamptz NOT NULL,
  metric_type text NOT NULL,
  currency char(3) NOT NULL,
  amount numeric(18,6) NOT NULL CHECK (amount >= 0),
  language_code varchar(16) NULL,
  region_code varchar(16) NULL,
  condition_code text NULL,
  precision_scope text NOT NULL DEFAULT 'UNKNOWN',
  sample_size integer NULL CHECK (sample_size IS NULL OR sample_size >= 0),
  listing_count integer NULL CHECK (listing_count IS NULL OR listing_count >= 0),
  seller_count integer NULL CHECK (seller_count IS NULL OR seller_count >= 0),
  confidence numeric(5,4) NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  external_event_key text NULL,
  observation_hash bytea NOT NULL UNIQUE,
  metadata jsonb NULL
);
CREATE UNIQUE INDEX market_event_unique
  ON market_observations(reported_by_source, external_event_key)
  WHERE external_event_key IS NOT NULL;
CREATE INDEX market_observation_entity_time_idx ON market_observations(entity_id, observed_at DESC);

CREATE TABLE market_heat_snapshots (
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  market_scope_hash bytea NOT NULL,
  heat_score numeric(5,2) NOT NULL CHECK (heat_score BETWEEN 0 AND 100),
  demand_score numeric(5,2) NULL CHECK (demand_score IS NULL OR demand_score BETWEEN 0 AND 100),
  liquidity_score numeric(5,2) NULL CHECK (liquidity_score IS NULL OR liquidity_score BETWEEN 0 AND 100),
  momentum_score numeric(5,2) NULL CHECK (momentum_score IS NULL OR momentum_score BETWEEN 0 AND 100),
  supply_pressure_score numeric(5,2) NULL CHECK (supply_pressure_score IS NULL OR supply_pressure_score BETWEEN 0 AND 100),
  heat_class text NOT NULL,
  heat_trend text NOT NULL,
  confidence text NOT NULL,
  engine_version text NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY(entity_id, market_scope_hash, computed_at)
);

COMMIT;
