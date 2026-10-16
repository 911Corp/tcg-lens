import pg from 'pg';
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await pool.query(`
    SELECT sr.scope_language_code AS language,
           count(*)::int AS source_records,
           count(*) FILTER (WHERE sr.promotion_status='CANONICAL')::int AS canonical,
           count(*) FILTER (WHERE sr.promotion_status='QUARANTINED')::int AS quarantined,
           count(DISTINCT sr.promoted_entity_id) FILTER (WHERE sr.promoted_entity_id IS NOT NULL)::int AS entities
      FROM source_records sr
      JOIN data_sources ds ON ds.source_id=sr.source_id
     WHERE ds.source_code='tcgdex' AND sr.namespace='cards'
     GROUP BY sr.scope_language_code
     ORDER BY sr.scope_language_code`);
  console.table(result.rows);
} finally {
  await pool.end();
}
