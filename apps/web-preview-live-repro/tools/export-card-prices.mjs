// v0.3.8 — latest canonical market prices of every live-pool printing, for the scanner result sheet.
//
//   DATABASE_URL=postgres://… node apps/web-preview-live-repro/tools/export-card-prices.mjs
//
// Output: data/card-prices.json (schema tcg-lens-card-prices-v1), keyed "<lang>:<family id>" like the
// visual index. Per printing: Cardmarket [trend, avg1, avg7, avg30, low] in EUR (printing level) and
// TCGplayer market price per priced sub-type (Normal, Holofoil, Reverse Holofoil…) in USD. Prices
// never influence identity; they are read only after a lock (api/card.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }

const keys = new Map(); // entityId -> [key]
for (const lang of ['fr', 'en', 'ja']) {
  const meta = JSON.parse(await fs.readFile(path.join(appDir, 'data', `visual-index-${lang}.json`), 'utf8'));
  const c = Object.fromEntries(meta.columns.map((k, i) => [k, i]));
  for (const r of meta.rows) { const e = r[c.entityId]; if (e) keys.set(e, [...(keys.get(e) || []), `${lang}:${r[c.id]}`]); }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query(`
  SELECT DISTINCT ON (mo.entity_id, d.source_code, mo.metric_type, COALESCE(mo.metadata->>'tcgplayer_subtype', ''))
         mo.entity_id, d.source_code, mo.metric_type, mo.metadata->>'tcgplayer_subtype' AS subtype, mo.amount, mo.observed_at
    FROM market_observations mo JOIN data_sources d ON d.source_id = mo.reported_by_source
    JOIN catalog_entities ce ON ce.entity_id = mo.entity_id AND ce.entity_type = 'CARD_PRINTING'
   WHERE mo.entity_id = ANY($1::uuid[])
     AND ((d.source_code = 'cardmarket' AND mo.metric_type IN ('TREND','AVG_1D','AVG_7D','AVG_30D','LISTING_LOW'))
       OR (d.source_code = 'tcgcsv' AND mo.metric_type IN ('MARKET','LISTING_MEDIAN')))
   ORDER BY mo.entity_id, d.source_code, mo.metric_type, COALESCE(mo.metadata->>'tcgplayer_subtype', ''), mo.observed_at DESC`, [[...keys.keys()]]);
await client.end();

const r2 = v => (v == null || !(Number(v) > 0) ? null : Math.round(Number(v) * 100) / 100);
const CM = ['TREND', 'AVG_1D', 'AVG_7D', 'AVG_30D', 'LISTING_LOW'];
const by = new Map(); let asOf = null;
for (const r of rows) {
  const p = by.get(r.entity_id) || { cm: [null, null, null, null, null], tp: {}, tpMid: {} };
  if (r.source_code === 'cardmarket') p.cm[CM.indexOf(r.metric_type)] = r2(r.amount);
  else if (r.metric_type === 'MARKET') p.tp[r.subtype || 'Normal'] = r2(r.amount);
  else p.tpMid[r.subtype || 'Normal'] = r2(r.amount);
  by.set(r.entity_id, p);
  if (!asOf || r.observed_at > asOf) asOf = r.observed_at;
}
const prices = {};
for (const [entity, p] of by) {
  // TCGplayer market price, or the listing median when no market price exists yet.
  const tp = {}; for (const s of new Set([...Object.keys(p.tp), ...Object.keys(p.tpMid)])) { const v = p.tp[s] ?? p.tpMid[s]; if (v != null) tp[s] = v; }
  const entry = { ...(p.cm.some(v => v != null) ? { cm: p.cm } : {}), ...(Object.keys(tp).length ? { tp } : {}) };
  if (!Object.keys(entry).length) continue;
  for (const k of keys.get(entity) || []) prices[k] = entry;
}
await fs.writeFile(path.join(appDir, 'data', 'card-prices.json'), JSON.stringify({
  schema: 'tcg-lens-card-prices-v1', asOf: asOf?.toISOString() || null, cmColumns: CM, count: Object.keys(prices).length, prices,
}));
console.log(`card prices: ${Object.keys(prices).length} / ${[...keys.values()].flat().length} live printings priced (as of ${asOf?.toISOString()})`);
