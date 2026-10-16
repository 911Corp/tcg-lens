import { createHash } from 'node:crypto';
import type { SqlClient } from './tcgdex-canonical.js';

export async function getSourceId(db: SqlClient, sourceCode: string): Promise<string> {
  const result = await db.query<{ source_id: string }>(`SELECT source_id FROM data_sources WHERE source_code=$1 AND active=true`, [sourceCode]);
  const sourceId = result.rows[0]?.source_id;
  if (!sourceId) throw new Error(`Active data source not found: ${sourceCode}`);
  return sourceId;
}

export async function getVenueId(db: SqlClient, venueCode: string): Promise<string> {
  const result = await db.query<{ venue_id: string }>(`SELECT venue_id FROM market_venues WHERE venue_code=$1`, [venueCode]);
  const venueId = result.rows[0]?.venue_id;
  if (!venueId) throw new Error(`Market venue not found: ${venueCode}`);
  return venueId;
}

export async function startSyncRun(db: SqlClient, sourceId: string): Promise<string> {
  const result = await db.query<{ sync_run_id: string }>(
    `INSERT INTO sync_runs(source_id,status) VALUES ($1,'RUNNING') RETURNING sync_run_id`,
    [sourceId]
  );
  const id = result.rows[0]?.sync_run_id;
  if (!id) throw new Error('Unable to start sync run');
  return id;
}

export async function finishSyncRun(db: SqlClient, syncRunId: string, status: 'SUCCESS' | 'FAILED', stats: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE sync_runs SET finished_at=now(),status=$2,stats=$3::jsonb WHERE sync_run_id=$1`,
    [syncRunId, status, JSON.stringify(stats)]
  );
}

export async function upsertSourceRecord(db: SqlClient, input: {
  sourceId: string;
  syncRunId?: string;
  namespace: string;
  externalKey: string;
  scopeLanguageCode?: string;
  scopeRegionCode?: string;
  rawPayload: unknown;
  normalizedPayload: unknown;
  normalizationVersion: string;
}): Promise<string> {
  const hash = createHash('sha256').update(stableJson(input.rawPayload)).digest();
  const result = await db.query<{ source_record_id: string }>(
    `INSERT INTO source_records(
       source_id,sync_run_id,namespace,external_key,scope_language_code,scope_region_code,
       raw_payload,normalized_payload,normalization_version,payload_hash,last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,now())
     ON CONFLICT(source_id,namespace,scope_language_code,external_key)
     DO UPDATE SET
       sync_run_id=EXCLUDED.sync_run_id,
       scope_region_code=EXCLUDED.scope_region_code,
       raw_payload=EXCLUDED.raw_payload,
       normalized_payload=EXCLUDED.normalized_payload,
       normalization_version=EXCLUDED.normalization_version,
       payload_hash=EXCLUDED.payload_hash,
       last_seen_at=now()
     RETURNING source_record_id`,
    [
      input.sourceId,
      input.syncRunId ?? null,
      input.namespace,
      input.externalKey,
      input.scopeLanguageCode ?? '',
      input.scopeRegionCode ?? null,
      JSON.stringify(input.rawPayload),
      JSON.stringify(input.normalizedPayload),
      input.normalizationVersion,
      hash
    ]
  );
  const id = result.rows[0]?.source_record_id;
  if (!id) throw new Error(`Unable to upsert source record ${input.namespace}/${input.externalKey}`);
  return id;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}
