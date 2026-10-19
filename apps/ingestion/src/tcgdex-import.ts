import pg from 'pg';
import fs from 'node:fs/promises';
import { TcgdexClient, normalizeTcgdexCard, type TcgdexCard, type TcgdexLanguage } from '../../../packages/ingestion/src/index.js';
import { payloadHash, promoteTcgdexCard } from './tcgdex-canonical.js';
import { applyTcgdexSetMetadata, promoteTcgdexVariants } from './tcgdex-catalog-v031.js';
import type { TcgdexSet } from '../../../packages/ingestion/src/index.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const requested = (process.argv[2] ?? 'fr,en,ja').split(',').filter(Boolean) as TcgdexLanguage[];
const allowed = new Set<TcgdexLanguage>(['fr','en','ja']);
for (const lang of requested) if (!allowed.has(lang)) throw new Error(`Unsupported language ${lang}`);
const limitArg = process.argv.find(v => v.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const fixtureArg = process.argv.find(v => v.startsWith('--fixture='));
const fixturePath = fixtureArg?.slice('--fixture='.length);
// v0.3.1: import from a raw snapshot directory written by tcgdex-snapshot.ts ({lang}-sets.json, {lang}-cards.json).
const snapshotArg = process.argv.find(v => v.startsWith('--snapshot='));
const snapshotDir = snapshotArg?.slice('--snapshot='.length);

const pool = new Pool({ connectionString: databaseUrl });
const tcgdex = new TcgdexClient();

try {
  const source = await pool.query(`SELECT source_id FROM data_sources WHERE source_code = 'tcgdex'`);
  if (!source.rows[0]) throw new Error('tcgdex source is missing; run migrations first');
  const sourceId = source.rows[0].source_id as string;

  const fixtures = fixturePath ? await loadFixtures(fixturePath) : snapshotDir ? await loadSnapshotCards(snapshotDir, requested) : undefined;

  for (const language of requested) {
    const run = await pool.query(
      `INSERT INTO sync_runs(source_id,status,stats) VALUES ($1,'RUNNING',$2::jsonb) RETURNING sync_run_id`,
      [sourceId, JSON.stringify({ language, seen: 0, promoted: 0, conflicts: 0, created: 0, matched: 0 })]
    );
    const syncRunId = run.rows[0].sync_run_id as string;
    let seen = 0;
    let promoted = 0;
    let conflicts = 0;
    let created = 0;
    let matched = 0;
    let variantsCreated = 0;
    let quarantined = 0;
    let setsUpdated = 0;
    const fetchFailures: Array<{ id: string; error: string }> = [];

    try {
      // Set metadata first (release date / series / medium / expected count), so sets with zero
      // catalogued cards are still DISCOVERED and visible in the coverage report.
      const sets: TcgdexSet[] = snapshotDir
        ? JSON.parse(await fs.readFile(`${snapshotDir}/${language}-sets.json`, 'utf8'))
        : fixtures ? [] : await tcgdex.listSets(language).then(briefs => Promise.all(briefs.map(b => tcgdex.getSet(language, b.id))));
      for (const set of sets) {
        await applyTcgdexSetMetadata(pool, { sourceId, language, set });
        setsUpdated++;
      }

      const cards = fixtures
        ? iterateFixtureCards(fixtures[language] ?? [], limit)
        : tcgdex.iterateCards(language, { concurrency: 6, limit, onFailure: failure => fetchFailures.push(failure) });
      for await (const card of cards) {
        const normalized = normalizeTcgdexCard(language, card);
        const payload = JSON.stringify(card);
        const normalizedPayload = JSON.stringify(normalized);
        const hash = payloadHash(card);

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const staged = await client.query(
            `INSERT INTO source_records(
               source_id,sync_run_id,namespace,external_key,scope_language_code,raw_payload,normalized_payload,normalization_version,payload_hash,promotion_status
             ) VALUES ($1,$2,'cards',$3,$4,$5::jsonb,$6::jsonb,'norm-v1',$7,'STAGED')
             ON CONFLICT(source_id,namespace,scope_language_code,external_key)
             DO UPDATE SET
               sync_run_id=EXCLUDED.sync_run_id,
               raw_payload=EXCLUDED.raw_payload,
               normalized_payload=EXCLUDED.normalized_payload,
               normalization_version=EXCLUDED.normalization_version,
               last_seen_at=now(),
               payload_hash=EXCLUDED.payload_hash,
               promotion_status=CASE
                 WHEN source_records.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash THEN 'STAGED'
                 ELSE source_records.promotion_status
               END
             RETURNING source_record_id`,
            [sourceId, syncRunId, normalized.externalKey, language, payload, normalizedPayload, hash]
          );
          const sourceRecordId = staged.rows[0].source_record_id as string;
          const result = await promoteTcgdexCard(client, { sourceId, sourceRecordId, normalized });
          if (result.status !== 'CONFLICT' && result.entityId) {
            variantsCreated += await promoteTcgdexVariants(client, { sourceId, sourceRecordId, printingEntityId: result.entityId, card });
          }
          await client.query('COMMIT');

          promoted++;
          if (result.status === 'CONFLICT') conflicts++;
          if (result.status === 'NEW_ENTITY') created++;
          if (result.status === 'AUTO_MATCH') matched++;
        } catch (error) {
          await client.query('ROLLBACK');
          // v0.3.1: a single invalid upstream record must not abort the language. Keep the raw record
          // as QUARANTINED with an open conflict for audit; abort only if failures look systemic.
          quarantined++;
          await client.query(
            `WITH rec AS (
               INSERT INTO source_records(source_id,sync_run_id,namespace,external_key,scope_language_code,raw_payload,normalized_payload,normalization_version,payload_hash,promotion_status)
               VALUES ($1,$2,'cards',$3,$4,$5::jsonb,$6::jsonb,'norm-v1',$7,'QUARANTINED')
               ON CONFLICT(source_id,namespace,scope_language_code,external_key)
               DO UPDATE SET raw_payload=EXCLUDED.raw_payload,payload_hash=EXCLUDED.payload_hash,promotion_status='QUARANTINED',last_seen_at=now()
               RETURNING source_record_id)
             INSERT INTO data_conflicts(source_record_id,conflict_type,severity,evidence,status)
             SELECT source_record_id,'SOURCE_RECORD_INVALID','MEDIUM',$8::jsonb,'OPEN' FROM rec`,
            [sourceId, syncRunId, normalized.externalKey, language, payload, normalizedPayload, hash,
             JSON.stringify({ source: 'tcgdex', externalKey: normalized.externalKey, error: String(error) })]
          );
          console.error(`[${language}] quarantined ${normalized.externalKey}: ${String(error)}`);
          if (quarantined > 25 && quarantined > seen * 0.01) throw new Error(`systemic promotion failure: ${quarantined} quarantined of ${seen + 1}`);
        } finally {
          client.release();
        }

        seen++;
        if (seen % 250 === 0) console.log(`[${language}] ${seen} cards, ${created} created, ${matched} matched, ${conflicts} conflicts`);
      }

      await pool.query(
        `UPDATE sync_runs SET status='SUCCESS',finished_at=now(),stats=$2::jsonb WHERE sync_run_id=$1`,
        [syncRunId, JSON.stringify({ language, seen, promoted, conflicts, created, matched, fetchFailed: fetchFailures.length, variantsCreated, setsUpdated, quarantined, snapshot: snapshotDir ?? null, fetchFailures: fetchFailures.slice(0, 500), fixture: Boolean(fixtures) })]
      );
      console.log(`[${language}] done: ${seen} seen, ${created} new, ${matched} matched, ${conflicts} conflicts, ${fetchFailures.length} fetch failures, ${variantsCreated} variants, ${setsUpdated} sets`);
    } catch (error) {
      await pool.query(
        `UPDATE sync_runs SET status='FAILED',finished_at=now(),stats=$2::jsonb WHERE sync_run_id=$1`,
        [syncRunId, JSON.stringify({ language, seen, promoted, conflicts, created, matched, error: String(error) })]
      );
      throw error;
    }
  }
} finally {
  await pool.end();
}

async function loadFixtures(path: string): Promise<Record<TcgdexLanguage, TcgdexCard[]>> {
  const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<Record<TcgdexLanguage, TcgdexCard[]>>;
  return { fr: parsed.fr ?? [], en: parsed.en ?? [], ja: parsed.ja ?? [] };
}

async function loadSnapshotCards(dir: string, languages: TcgdexLanguage[]): Promise<Record<TcgdexLanguage, TcgdexCard[]>> {
  const out: Record<TcgdexLanguage, TcgdexCard[]> = { fr: [], en: [], ja: [] };
  for (const language of languages) out[language] = JSON.parse(await fs.readFile(`${dir}/${language}-cards.json`, 'utf8'));
  return out;
}

async function* iterateFixtureCards(cards: TcgdexCard[], limit?: number): AsyncGenerator<TcgdexCard> {
  for (const card of limit ? cards.slice(0, limit) : cards) yield card;
}
