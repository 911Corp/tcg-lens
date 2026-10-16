BEGIN;

CREATE TYPE ingestion_resolution_status AS ENUM ('AUTO_MATCH','CANDIDATE_MATCH','CONFLICT','NEW_ENTITY');

CREATE TABLE sync_runs (
  sync_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES data_sources(source_id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  status text NOT NULL,
  cursor_state jsonb NULL,
  stats jsonb NULL
);

CREATE TABLE source_records (
  source_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES data_sources(source_id),
  sync_run_id uuid NULL REFERENCES sync_runs(sync_run_id),
  namespace text NOT NULL,
  external_key text NOT NULL,
  raw_payload jsonb NULL,
  normalized_payload jsonb NULL,
  normalization_version text NULL,
  payload_hash bytea NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, namespace, external_key)
);

ALTER TABLE image_origins
  ADD CONSTRAINT image_origins_source_record_fk
  FOREIGN KEY (source_record_id) REFERENCES source_records(source_record_id);
ALTER TABLE entity_barcodes
  ADD CONSTRAINT entity_barcodes_source_record_fk
  FOREIGN KEY (source_record_id) REFERENCES source_records(source_record_id);

CREATE TABLE external_identifiers (
  external_identifier_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  source_id uuid NOT NULL REFERENCES data_sources(source_id),
  namespace text NOT NULL,
  external_value text NOT NULL,
  source_record_id uuid NULL REFERENCES source_records(source_record_id),
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, namespace, external_value)
);

CREATE TABLE source_assertions (
  assertion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  source_record_id uuid NOT NULL REFERENCES source_records(source_record_id),
  field_path text NOT NULL,
  value_json jsonb NOT NULL,
  normalized_value jsonb NULL,
  value_hash bytea NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'ACTIVE',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen_at >= first_seen_at),
  UNIQUE(source_record_id, entity_id, field_path, value_hash)
);

CREATE TABLE field_resolutions (
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  field_path text NOT NULL,
  assertion_id uuid NULL REFERENCES source_assertions(assertion_id),
  resolution_method text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(entity_id, field_path)
);

CREATE TABLE resolution_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(source_record_id),
  resolution_status ingestion_resolution_status NOT NULL,
  matched_entity_id uuid NULL REFERENCES catalog_entities(entity_id),
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  candidate_count integer NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
  confidence numeric(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  contradictions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resolution_candidates (
  decision_id uuid NOT NULL REFERENCES resolution_decisions(decision_id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  candidate_rank integer NOT NULL CHECK(candidate_rank > 0),
  candidate_score numeric(7,3) NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  contradictions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY(decision_id, entity_id),
  UNIQUE(decision_id, candidate_rank)
);

CREATE TABLE data_conflicts (
  conflict_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NULL REFERENCES source_records(source_record_id),
  conflict_type text NOT NULL,
  severity text NOT NULL,
  entity_ids uuid[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL
);

CREATE TABLE entity_fingerprints (
  fingerprint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES catalog_entities(entity_id),
  fingerprint_type text NOT NULL,
  fingerprint_version integer NOT NULL,
  canonical_payload text NOT NULL,
  fingerprint_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_id, fingerprint_type, fingerprint_version),
  UNIQUE(fingerprint_type, fingerprint_version, fingerprint_hash, entity_id)
);
CREATE INDEX entity_fingerprint_lookup_idx
  ON entity_fingerprints(fingerprint_type, fingerprint_version, fingerprint_hash);

COMMIT;
