import fs from 'node:fs/promises';
import { Pool } from 'pg';
import { getSourceId, startSyncRun, finishSyncRun, upsertSourceRecord } from './source-record.js';
import { ingestBarcodeClaim } from './barcode-ingestion.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const file = process.env.BARCODE_CLAIMS_FILE ?? process.argv[2];
if (!file) throw new Error('BARCODE_CLAIMS_FILE or path argument is required');
const sourceCode = process.env.BARCODE_SOURCE ?? 'internal_verified';
const pool = new Pool({ connectionString: DATABASE_URL });

interface InputRow {
  barcode: string;
  entity_id?: string;
  external_value?: string;
  verified?: boolean;
  confidence?: number;
  evidence?: Record<string, unknown>;
}

const body = JSON.parse(await fs.readFile(file, 'utf8')) as InputRow[];
const sourceId = await getSourceId(pool, sourceCode);
const syncRunId = await startSyncRun(pool, sourceId);
const stats = { seen: 0, verified: 0, candidate: 0, conflict: 0, rejected: 0 };
try {
  for (const [index,row] of body.entries()) {
    const sourceRecordId = await upsertSourceRecord(pool, {
      sourceId, syncRunId, namespace: 'barcode_claims', externalKey: `${row.external_value ?? row.entity_id ?? 'unbound'}:${index}:${row.barcode}`,
      rawPayload: row, normalizedPayload: row, normalizationVersion: 'barcode-registry-v0.1'
    });
    const result = await ingestBarcodeClaim(pool, {
      sourceId, sourceRecordId, rawValue: row.barcode, sourceExternalValue: row.external_value,
      entityId: row.entity_id, verified: row.verified ?? false, confidence: row.confidence, evidence: row.evidence
    });
    stats.seen++; stats[result.status.toLowerCase() as 'verified'|'candidate'|'conflict'|'rejected']++;
  }
  await finishSyncRun(pool, syncRunId, 'SUCCESS', stats);
  console.log(JSON.stringify(stats,null,2));
} catch (error) {
  await finishSyncRun(pool, syncRunId, 'FAILED', { ...stats, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally { await pool.end(); }
