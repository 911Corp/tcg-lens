/**
 * v0.3.1 — Probe reference-image availability.
 *
 * A URL listed by a source is not evidence that a usable reference exists (TCGdex has known 404s
 * and missing images). Every TCGdex REFERENCE image is HEAD-probed at the rendition the Lens indexes.
 *
 *   DATABASE_URL=... npm run images:probe -w @tcglens/ingestion-worker -- [--max-age-hours=168] [--limit=N]
 */
import pg from 'pg';
import { boundedMap } from '../../../packages/ingestion/src/index.js';

export const PROBE_RENDITION = 'low.webp';
export const MIN_IMAGE_BYTES = 2048;

export function probeUrlFor(sourceUrl: string): string {
  return /\.(webp|png|jpe?g)$/i.test(sourceUrl) ? sourceUrl : `${sourceUrl.replace(/\/$/, '')}/${PROBE_RENDITION}`;
}

export function isUsableImageResponse(status: number, contentType: string | null, contentLength: number | null): boolean {
  if (status !== 200) return false;
  if (!contentType || !contentType.toLowerCase().startsWith('image/')) return false;
  if (contentLength != null && contentLength < MIN_IMAGE_BYTES) return false;
  return true;
}

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const maxAgeArg = process.argv.find(v => v.startsWith('--max-age-hours='));
const maxAgeHours = maxAgeArg ? Number(maxAgeArg.split('=')[1]) : 168;
const limitArg = process.argv.find(v => v.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;
const concurrency = Number(process.env.PROBE_CONCURRENCY ?? 16);

const pool = new Pool({ connectionString: databaseUrl });
try {
  const rows = (await pool.query(
    `SELECT DISTINCT io.image_origin_id, io.source_url
       FROM image_origins io
       JOIN data_sources ds ON ds.source_id=io.source_id AND ds.source_code='tcgdex'
       JOIN entity_images ei ON ei.image_id=io.image_id AND ei.role='REFERENCE'
       LEFT JOIN image_probes ip ON ip.image_origin_id=io.image_origin_id
      WHERE ip.image_origin_id IS NULL OR ip.checked_at < now() - ($1::text || ' hours')::interval
      ORDER BY io.image_origin_id
      ${limit ? `LIMIT ${Math.floor(limit)}` : ''}`,
    [String(maxAgeHours)]
  )).rows as Array<{ image_origin_id: string; source_url: string }>;
  console.log(`probing ${rows.length} images (concurrency ${concurrency})`);

  let ok = 0, bad = 0, errors = 0, n = 0;
  const probe = async (row: { image_origin_id: string; source_url: string }) => {
    const url = probeUrlFor(row.source_url);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'TCGLens/0.1 (+coverage-audit)' } });
        if (response.status >= 500 && attempt < 3) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
        const length = response.headers.get('content-length');
        return { row, url, status: response.status, contentType: response.headers.get('content-type'), contentLength: length ? Number(length) : null, error: null as string | null };
      } catch (error) {
        if (attempt === 3) return { row, url, status: null as number | null, contentType: null, contentLength: null, error: String(error) };
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }
    throw new Error('unreachable');
  };
  for await (const result of boundedMap(rows, concurrency, probe, (row, error) => { errors++; console.error('probe failed', row.source_url, String(error)); })) {
    const usable = result.status != null && isUsableImageResponse(result.status, result.contentType, result.contentLength);
    if (usable) ok++; else bad++;
    if (result.error) errors++;
    await pool.query(
      `INSERT INTO image_probes(image_origin_id,probe_url,http_status,content_type,content_length,ok,error,checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT(image_origin_id) DO UPDATE SET probe_url=EXCLUDED.probe_url,http_status=EXCLUDED.http_status,
         content_type=EXCLUDED.content_type,content_length=EXCLUDED.content_length,ok=EXCLUDED.ok,error=EXCLUDED.error,checked_at=now()`,
      [result.row.image_origin_id, result.url, result.status, result.contentType, result.contentLength, usable, result.error]
    );
    if (++n % 2000 === 0) console.log(`${n}/${rows.length} probed: ${ok} ok, ${bad} unusable, ${errors} errors`);
  }
  console.log(`done: ${n} probed, ${ok} ok, ${bad} unusable, ${errors} network errors`);
} finally {
  await pool.end();
}
