import assert from 'node:assert/strict';
import pg from 'pg';
import { normalizeTcgdexCard, type TcgdexCard } from '../../../packages/ingestion/src/index.js';
import { promoteTcgdexCard, payloadHash } from '../src/tcgdex-canonical.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP tcgdex-postgres.integration: TEST_DATABASE_URL is not set');
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  const source = await pool.query(`SELECT source_id FROM data_sources WHERE source_code='tcgdex'`);
  assert.ok(source.rows[0], 'migrations + source seed must be applied first');
  const sourceId = source.rows[0].source_id as string;
  const card: TcgdexCard = {
    id: 'integration-en-001', localId: '001', name: 'Integration Test ex', image: 'https://example.invalid/card',
    set: { id: 'integration-set', name: 'Integration Set', cardCount: { official: 1, total: 1 } }
  };
  const normalized = normalizeTcgdexCard('en', card);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(`INSERT INTO sync_runs(source_id,status) VALUES($1,'RUNNING') RETURNING sync_run_id`, [sourceId]);
    const staged = await client.query(
      `INSERT INTO source_records(source_id,sync_run_id,namespace,external_key,scope_language_code,raw_payload,normalized_payload,normalization_version,payload_hash)
       VALUES($1,$2,'cards',$3,'en',$4::jsonb,$5::jsonb,'norm-v1',$6)
       ON CONFLICT(source_id,namespace,scope_language_code,external_key)
       DO UPDATE SET raw_payload=EXCLUDED.raw_payload,normalized_payload=EXCLUDED.normalized_payload,payload_hash=EXCLUDED.payload_hash,last_seen_at=now()
       RETURNING source_record_id`,
      [sourceId, run.rows[0].sync_run_id, card.id, JSON.stringify(card), JSON.stringify(normalized), payloadHash(card)]
    );
    const sourceRecordId = staged.rows[0].source_record_id as string;
    const first = await promoteTcgdexCard(client, { sourceId, sourceRecordId, normalized });
    assert.ok(first.entityId);
    const second = await promoteTcgdexCard(client, { sourceId, sourceRecordId, normalized });
    assert.equal(second.status, 'AUTO_MATCH');
    assert.equal(second.entityId, first.entityId);
    const count = await client.query(`SELECT count(*)::int AS n FROM card_printings WHERE entity_id=$1`, [first.entityId]);
    assert.equal(count.rows[0].n, 1);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  console.log('PASS tcgdex-postgres.integration');
} finally { await pool.end(); }
