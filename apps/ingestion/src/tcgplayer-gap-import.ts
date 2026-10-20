/**
 * v0.3.6 — TCGplayer gap import: sets, printings and reference images TCGdex does not provide.
 *
 *   DATABASE_URL=... npm run tcgplayer:gaps -w @tcglens/ingestion-worker -- [--since=2025-06-01] [--map-since=1999-01-01] [--dry-run]
 *
 * 1. CREATE  Japanese expansions published by TCGplayer (category 85, with a set abbreviation, since
 *            `--since`) that have no canonical set: canonical set + printings (method
 *            BOOTSTRAP_TCGPLAYER_GAP, canonical source tcgplayer), product ids, reference images, prices.
 *            A later TCGdex import matches them by set code + number + name (ensureSet / printing lookup).
 * 2. MAP     Canonical sets with no TCGplayer mapping whose TCGplayer group is the same product line
 *            (token overlap ≥ 0.75, release dates within 10 days): printings mapped by unique comparable
 *            name (TP_GAP_GROUP_NAME_UNIQUE). The number printed on the card is kept as an assertion
 *            (`tcgplayer_printed_number`) — e.g. Classic Collection reprints print "4/102" while TCGdex
 *            numbers them 001–030. Same-concept printings in other languages of that set (shared TCGdex
 *            card id) receive the image as reference too (same artwork).
 * 3. IMAGES  Printings with a verified TCGplayer product and no TCGdex reference image get the TCGplayer
 *            image (1000 px) as REFERENCE.
 */
import { Pool } from 'pg';
import {
  TcgcsvClient, TCGCSV_POKEMON_CATEGORY, TCGCSV_POKEMON_JAPAN_CATEGORY, normalizeTcgcsvProduct, normalizeTcgcsvPrice,
  collectorNumberMatchKeyV1, normalizeTextV1, tcgplayerComparableName, type TcgcsvGroup, type TcgcsvProduct,
} from '../../../packages/ingestion/src/index.js';
import { persistTcgcsvPrice } from './card-printing-enrichment.js';
import { finishSyncRun, getSourceId, getVenueId, startSyncRun, upsertSourceRecord } from './source-record.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const since = (process.argv.find(a => a.startsWith('--since=')) || '--since=2025-06-01').slice(8);
// Mapping of existing sets (no creation) can go further back than set creation.
const mapSince = (process.argv.find(a => a.startsWith('--map-since=')) || `--map-since=${since}`).slice(12);
const dryRun = process.argv.includes('--dry-run');
const pool = new Pool({ connectionString: DATABASE_URL });
const tcgcsv = new TcgcsvClient();
const stats = { setsCreated: 0, printingsCreated: 0, mapped: 0, imagesAttached: 0, printedNumbers: 0, prices: 0, skipped: [] as string[] };

export const imageUrlFor = (productId: number | string) => `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_in_1000x1000.jpg`;

/** "Charizard 4/102 Classic Collection" / "Greninja ex - 021/128" → "charizard" / "greninja ex". */
export function gapComparableName(name: string): string {
  const cut = String(name).split(/\s+-?\s*\d+\s*\/\s*\d+/)[0];
  return tcgplayerComparableName(cut.replace(/\((?:[^)]*)\)/g, ' '));
}

function tokens(s: string): Set<string> {
  return new Set(normalizeTextV1(s).replace(/^[a-z0-9.-]+:\s*/u, '').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(t => t && t !== 'pokemon'));
}
export function sameProductLine(setName: string, groupName: string): number {
  const a = tokens(setName), b = tokens(groupName);
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / Math.max(1, a.size + b.size - inter); // Jaccard: "Celebrations" ≠ "Celebrations: Classic Collection"
}

const number = (p: TcgcsvProduct) => p.extendedData?.find(e => e.name === 'Number')?.value?.trim() || null;
const cleanCardName = (p: TcgcsvProduct) => String(p.name).replace(/\s+-\s+\d+\s*\/\s*\d+.*$/, '').replace(/\s+\d+\s*\/\s*\d+.*$/, '').trim();

async function main() {
  const db = await pool.connect();
  const tcgcsvSourceId = await getSourceId(db, 'tcgcsv');
  const tcgplayerSourceId = await getSourceId(db, 'tcgplayer');
  const venueId = await getVenueId(db, 'tcgplayer');
  const syncRunId = await startSyncRun(db, tcgcsvSourceId);
  try {
    await createJapaneseGaps(db, { tcgcsvSourceId, tcgplayerSourceId, venueId, syncRunId });
    await mapUnmappedSets(db, { tcgcsvSourceId, tcgplayerSourceId, syncRunId });
    await attachMissingImages(db, tcgplayerSourceId);
    await finishSyncRun(db, syncRunId, 'SUCCESS', { gapImport: stats });
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    await finishSyncRun(db, syncRunId, 'FAILED', { gapImport: stats, error: String(error) });
    throw error;
  } finally { db.release(); await pool.end(); }
}

type Ctx = { tcgcsvSourceId: string; tcgplayerSourceId: string; venueId?: string; syncRunId: string };

async function createJapaneseGaps(db: any, ctx: Ctx) {
  const codes = new Set((await db.query(`SELECT lower(official_set_code) AS c FROM card_sets WHERE language_code='ja'`)).rows.map((r: any) => r.c));
  const groups = (await tcgcsv.listGroups(TCGCSV_POKEMON_JAPAN_CATEGORY))
    .filter(g => g.abbreviation && String(g.publishedOn || '') >= since && !codes.has(String(g.abbreviation).toLowerCase()));
  for (const group of groups) {
    const products = (await tcgcsv.listProducts(TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId)).filter(p => number(p));
    if (products.length < 5) { stats.skipped.push(`${group.abbreviation}: ${products.length} numbered products`); continue; }
    const code = String(group.abbreviation).replace(/^m/, 'M');
    const totals = products.map(p => Number(number(p)!.split('/')[1])).filter(Number.isFinite);
    const printedTotal = mode(totals);
    const officialName = String(group.name).replace(/^[^:]+:\s*/, '');
    if (dryRun) { console.log('would create', code, officialName, products.length); continue; }
    const setKey = `set:ja:tcgplayer-gap:${code.toLowerCase()}`;
    const setId = (await db.query(
      `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
       VALUES ('SET',$1,'CANONICAL','BOOTSTRAP_TCGPLAYER_GAP',$2) ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now() RETURNING entity_id`,
      [setKey, ctx.tcgplayerSourceId])).rows[0].entity_id;
    await db.query(
      `INSERT INTO card_sets(entity_id,language_code,official_name,official_set_code,release_date,printed_card_count,total_card_count,product_medium,source_expected_card_count)
       VALUES ($1,'ja',$2,$3,$4,$5,$6,'PHYSICAL',$6)
       ON CONFLICT(entity_id) DO UPDATE SET official_name=EXCLUDED.official_name, printed_card_count=EXCLUDED.printed_card_count,
         total_card_count=EXCLUDED.total_card_count, source_expected_card_count=EXCLUDED.source_expected_card_count`,
      [setId, officialName, code, String(group.publishedOn).slice(0, 10), printedTotal ?? null, products.length]);
    await db.query(
      `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,verified)
       VALUES ($1,$2,'groups',$3,'ja',true) ON CONFLICT(source_id,namespace,scope_language_code,external_value) DO NOTHING`,
      [setId, ctx.tcgplayerSourceId, String(group.groupId)]);
    stats.setsCreated++;
    const seen = new Map<string, number>();
    for (const product of products) {
      const normalized = normalizeTcgcsvProduct(group as TcgcsvGroup, product);
      const raw = number(product)!.split('/')[0].trim();
      const key = collectorNumberMatchKeyV1(raw);
      const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
      const discriminator = n === 1 ? 'base' : `tcgplayer-${product.productId}`;
      const sourceRecordId = await upsertSourceRecord(db, {
        sourceId: ctx.tcgcsvSourceId, syncRunId: ctx.syncRunId, namespace: 'products', externalKey: String(product.productId),
        scopeLanguageCode: 'ja', rawPayload: product, normalizedPayload: normalized, normalizationVersion: 'tcgplayer-gap-v1',
      });
      const entityId = (await db.query(
        `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
         VALUES ('CARD_PRINTING',$1,'CANONICAL','BOOTSTRAP_TCGPLAYER_GAP',$2) ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now() RETURNING entity_id`,
        [`card:ja:${code.toLowerCase()}:${key}:${discriminator}`, ctx.tcgplayerSourceId])).rows[0].entity_id;
      const inserted = await db.query(
        `INSERT INTO card_printings(entity_id,set_id,collector_number_raw,collector_number_normalized,printing_discriminator,name,rarity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(set_id,collector_number_normalized,printing_discriminator) DO NOTHING RETURNING entity_id`,
        [entityId, setId, raw, key, discriminator, cleanCardName(product), normalized.rarity ?? null]);
      if (inserted.rows[0]) stats.printingsCreated++;
      await linkProduct(db, ctx, entityId, product.productId, 'ja', sourceRecordId, 'TP_GAP_CREATED');
      await attachImage(db, ctx.tcgplayerSourceId, entityId, product.productId, sourceRecordId);
    }
    stats.prices += await prices(db, ctx, TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId);
  }
}

async function mapUnmappedSets(db: any, ctx: Ctx) {
  // Canonical sets where no printing has a TCGplayer product id.
  const sets = (await db.query(
    `SELECT cs.entity_id, cs.official_name, cs.official_set_code, cs.language_code, cs.release_date
       FROM card_sets cs
      WHERE cs.language_code IN ('en','fr') AND cs.release_date >= $1
        AND NOT EXISTS (SELECT 1 FROM card_printings cp JOIN external_identifiers e ON e.entity_id=cp.entity_id
                         WHERE cp.set_id=cs.entity_id AND e.source_id=$2 AND e.namespace='products')`,
    [mapSince, ctx.tcgplayerSourceId])).rows;
  const enGroups = await tcgcsv.listGroups(TCGCSV_POKEMON_CATEGORY);
  for (const set of sets.filter((s: any) => s.language_code === 'en')) {
    const released = new Date(set.release_date).getTime();
    const group = enGroups
      .map(g => ({ g, s: sameProductLine(set.official_name, g.name) }))
      .filter(x => x.s >= 0.6 && Math.abs(new Date(String(x.g.publishedOn)).getTime() - released) <= 10 * 864e5)
      .sort((a, b) => b.s - a.s)[0]?.g;
    if (!group) continue;
    const products = (await tcgcsv.listProducts(TCGCSV_POKEMON_CATEGORY, group.groupId)).filter(p => number(p));
    const printings = (await db.query(`SELECT entity_id, name, collector_number_raw FROM card_printings WHERE set_id=$1`, [set.entity_id])).rows;
    const byName = new Map<string, TcgcsvProduct[]>();
    for (const p of products) { const k = gapComparableName(p.name); byName.set(k, [...(byName.get(k) ?? []), p]); }
    const printingNames = new Map<string, number>();
    for (const pr of printings) { const k = gapComparableName(pr.name); printingNames.set(k, (printingNames.get(k) ?? 0) + 1); }
    // Unique names on both sides. Numbers must agree, unless the whole set is systematically renumbered
    // (≥ 80 % of pairs differ, e.g. Classic Collection reprints printing their original numbers).
    const pairs = printings.map((pr: any) => {
      const k = gapComparableName(pr.name); const hits = byName.get(k) ?? [];
      return hits.length === 1 && printingNames.get(k) === 1 ? { pr, product: hits[0] } : null;
    }).filter(Boolean) as Array<{ pr: any; product: TcgcsvProduct }>;
    const differs = (x: { pr: any; product: TcgcsvProduct }) => collectorNumberMatchKeyV1(String(number(x.product)).split('/')[0]) !== collectorNumberMatchKeyV1(x.pr.collector_number_raw);
    const renumbered = pairs.length >= 5 && pairs.filter(differs).length / pairs.length >= 0.8;
    for (const { pr, product } of pairs) {
      if (!renumbered && differs({ pr, product })) continue;
      if (dryRun) { console.log('would map', set.official_set_code, pr.name, '->', product.productId, number(product)); continue; }
      const normalized = normalizeTcgcsvProduct(group as TcgcsvGroup, product);
      const sourceRecordId = await upsertSourceRecord(db, {
        sourceId: ctx.tcgcsvSourceId, syncRunId: ctx.syncRunId, namespace: 'products', externalKey: String(product.productId),
        scopeLanguageCode: 'en', rawPayload: product, normalizedPayload: normalized, normalizationVersion: 'tcgplayer-gap-v1',
      });
      await linkProduct(db, ctx, pr.entity_id, product.productId, 'en', sourceRecordId, 'TP_GAP_GROUP_NAME_UNIQUE');
      await attachImage(db, ctx.tcgplayerSourceId, pr.entity_id, product.productId, sourceRecordId);
      const printed = number(product);
      if (printed && collectorNumberMatchKeyV1(printed.split('/')[0]) !== collectorNumberMatchKeyV1(pr.collector_number_raw)) {
        await assert(db, pr.entity_id, sourceRecordId, 'tcgplayer_printed_number', printed);
        stats.printedNumbers++;
      }
      stats.mapped++;
      // Other-language printings of the same TCGdex card (same artwork) without a reference image.
      const siblings = (await db.query(
        `SELECT DISTINCT e2.entity_id FROM external_identifiers e1
           JOIN data_sources d ON d.source_id=e1.source_id AND d.source_code='tcgdex'
           JOIN external_identifiers e2 ON e2.source_id=e1.source_id AND e2.namespace='cards' AND e2.external_value=e1.external_value AND e2.entity_id<>e1.entity_id
          WHERE e1.entity_id=$1 AND e1.namespace='cards'`, [pr.entity_id])).rows;
      for (const s of siblings) {
        await attachImage(db, ctx.tcgplayerSourceId, s.entity_id, product.productId, sourceRecordId);
        if (printed && collectorNumberMatchKeyV1(printed.split('/')[0]) !== collectorNumberMatchKeyV1(pr.collector_number_raw)) await assert(db, s.entity_id, sourceRecordId, 'tcgplayer_printed_number', printed);
      }
    }
  }
}

async function attachMissingImages(db: any, tcgplayerSourceId: string) {
  const rows = (await db.query(
    `SELECT e.entity_id, e.external_value, e.source_record_id FROM external_identifiers e
       JOIN card_printings cp ON cp.entity_id=e.entity_id
      WHERE e.source_id=$1 AND e.namespace='products' AND e.verified
        AND NOT EXISTS (SELECT 1 FROM entity_images ei WHERE ei.entity_id=e.entity_id AND ei.role='REFERENCE')`,
    [tcgplayerSourceId])).rows;
  for (const r of rows) if (!dryRun) await attachImage(db, tcgplayerSourceId, r.entity_id, r.external_value, r.source_record_id);
}

async function linkProduct(db: any, ctx: Ctx, entityId: string, productId: number, lang: string, sourceRecordId: string, rule: string) {
  await db.query(
    `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,source_record_id,verified)
     VALUES ($1,$2,'products',$3,$4,$5,true)
     ON CONFLICT(source_id,namespace,scope_language_code,external_value) DO NOTHING`,
    [entityId, ctx.tcgplayerSourceId, String(productId), lang, sourceRecordId]);
  await assert(db, entityId, sourceRecordId, 'tcgplayer_gap_rule', rule);
}

async function attachImage(db: any, sourceId: string, entityId: string, productId: number | string, sourceRecordId: string | null) {
  const url = imageUrlFor(productId);
  let imageId = (await db.query(`SELECT image_id FROM image_origins WHERE source_id=$1 AND source_url=$2`, [sourceId, url])).rows[0]?.image_id;
  if (!imageId) {
    imageId = (await db.query(`INSERT INTO images DEFAULT VALUES RETURNING image_id`)).rows[0].image_id;
    await db.query(
      `INSERT INTO image_origins(image_id,source_id,source_record_id,source_url,rights_status,redistribution_status,indexing_allowed,display_allowed)
       VALUES ($1,$2,$3,$4,'UNKNOWN','UNKNOWN',false,false) ON CONFLICT(source_id,source_url) DO NOTHING`,
      [imageId, sourceId, sourceRecordId, url]);
    imageId = (await db.query(`SELECT image_id FROM image_origins WHERE source_id=$1 AND source_url=$2`, [sourceId, url])).rows[0].image_id;
  }
  const r = await db.query(
    `INSERT INTO entity_images(entity_id,image_id,role,view_type,is_primary,sort_order) VALUES ($1,$2,'REFERENCE','FRONT',false,1)
     ON CONFLICT(entity_id,image_id,role,view_type) DO NOTHING RETURNING entity_id`, [entityId, imageId]);
  if (r.rows[0]) stats.imagesAttached++;
}

async function assert(db: any, entityId: string, sourceRecordId: string, field: string, value: unknown) {
  await db.query(
    `INSERT INTO source_assertions(entity_id,source_record_id,field_path,value_json,normalized_value,value_hash,confidence,status)
     SELECT $1,$2,$3,$4::jsonb,$4::jsonb,sha256(convert_to($4::text,'UTF8')),0.9,'ACTIVE'
      WHERE NOT EXISTS (SELECT 1 FROM source_assertions WHERE entity_id=$1 AND field_path=$3 AND value_json=$4::jsonb AND status='ACTIVE')`,
    [entityId, sourceRecordId, field, JSON.stringify(value)]);
}

async function prices(db: any, ctx: Ctx, category: number, groupId: number): Promise<number> {
  let n = 0;
  for (const price of await tcgcsv.listPrices(category, groupId)) {
    const normalized = normalizeTcgcsvPrice(category, price as any);
    const sourceRecordId = await upsertSourceRecord(db, {
      sourceId: ctx.tcgcsvSourceId, syncRunId: ctx.syncRunId, namespace: 'prices', externalKey: normalized.externalKey,
      scopeLanguageCode: normalized.languageCode, rawPayload: price, normalizedPayload: normalized, normalizationVersion: 'tcgplayer-gap-v1',
    });
    n += await persistTcgcsvPrice(db, { tcgcsvSourceId: ctx.tcgcsvSourceId, tcgplayerSourceId: ctx.tcgplayerSourceId, venueId: ctx.venueId!, sourceRecordId, price: normalized });
  }
  return n;
}

function mode(values: number[]): number | null {
  const c = new Map<number, number>(); for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

if (process.argv[1]?.endsWith('tcgplayer-gap-import.ts')) main().catch(error => { console.error(error); process.exitCode = 1; });
