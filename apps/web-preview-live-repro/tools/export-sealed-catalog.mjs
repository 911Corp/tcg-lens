// Export the canonical sealed-product catalogue (ETB, displays, boosters, bundles, tins, blisters,
// decks, collection boxes…) for the web app, with provider ids and latest market prices.
//
//   DATABASE_URL=postgres://… node apps/web-preview-live-repro/tools/export-sealed-catalog.mjs
//
// Output: data/sealed-catalog.json (schema tcg-lens-sealed-catalog-v1) and data/barcodes.json
// (VERIFIED entity_barcodes only — barcode claims that are merely CANDIDATE are never exported).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(`
  WITH ids AS (
    SELECT e.entity_id,
           max(e.external_value) FILTER (WHERE d.source_code = 'cardmarket') AS cm_id,
           max(e.external_value) FILTER (WHERE d.source_code = 'tcgplayer') AS tp_id
    FROM external_identifiers e JOIN data_sources d ON d.source_id = e.source_id
    WHERE e.namespace = 'products' GROUP BY e.entity_id
  ), latest AS (
    SELECT DISTINCT ON (mo.entity_id, d.source_code, mo.metric_type)
           mo.entity_id, d.source_code, mo.metric_type, mo.currency, mo.amount, mo.observed_at
    FROM market_observations mo JOIN data_sources d ON d.source_id = mo.reported_by_source
    JOIN sealed_products s ON s.entity_id = mo.entity_id
    ORDER BY mo.entity_id, d.source_code, mo.metric_type, mo.observed_at DESC
  ), prices AS (
    SELECT entity_id,
      max(amount) FILTER (WHERE source_code = 'cardmarket' AND metric_type = 'TREND') AS cm_trend,
      max(amount) FILTER (WHERE source_code = 'cardmarket' AND metric_type = 'LISTING_LOW') AS cm_low,
      max(amount) FILTER (WHERE source_code = 'tcgcsv' AND metric_type = 'MARKET') AS tp_market,
      max(amount) FILTER (WHERE source_code = 'tcgcsv' AND metric_type = 'LISTING_LOW') AS tp_low,
      max(observed_at) AS priced_at
    FROM latest GROUP BY entity_id
  )
  SELECT s.entity_id, s.official_name, s.language_code, s.release_date, f.product_type,
         ids.cm_id, ids.tp_id, p.cm_trend, p.cm_low, p.tp_market, p.tp_low, p.priced_at
  FROM sealed_products s JOIN sealed_families f ON f.entity_id = s.family_id
  LEFT JOIN ids ON ids.entity_id = s.entity_id LEFT JOIN prices p ON p.entity_id = s.entity_id
  ORDER BY s.release_date DESC NULLS LAST, s.official_name`);

const num = v => (v == null ? null : Math.round(Number(v) * 100) / 100);
const items = rows.map(r => [
  r.entity_id, r.official_name, r.product_type, r.language_code || null,
  r.release_date ? r.release_date.toISOString().slice(0, 10) : null,
  r.cm_id || null, r.tp_id || null, num(r.cm_trend), num(r.cm_low), num(r.tp_market), num(r.tp_low),
]);
const asOf = rows.reduce((m, r) => (r.priced_at && (!m || r.priced_at > m) ? r.priced_at : m), null);
await fs.writeFile(path.join(appDir, 'data', 'sealed-catalog.json'), JSON.stringify({
  schema: 'tcg-lens-sealed-catalog-v1', asOf: asOf?.toISOString() || null, count: items.length,
  columns: ['entityId', 'name', 'type', 'lang', 'releaseDate', 'cardmarketId', 'tcgplayerId', 'cmTrendEur', 'cmLowEur', 'tpMarketUsd', 'tpLowUsd'],
  items,
}));

const barcodes = await client.query(`
  SELECT b.gtin14, eb.entity_id FROM entity_barcodes eb JOIN barcodes b ON b.barcode_id = eb.barcode_id
  WHERE eb.status = 'VERIFIED'`).catch(() => ({ rows: [] }));
await fs.writeFile(path.join(appDir, 'data', 'barcodes.json'), JSON.stringify({
  schema: 'tcg-lens-barcodes-v1', verified: Object.fromEntries(barcodes.rows.map(r => [r.gtin14, r.entity_id])),
}));
console.log(`sealed products: ${items.length} (priced as of ${asOf?.toISOString()}), verified barcodes: ${barcodes.rows.length}`);
await client.end();
