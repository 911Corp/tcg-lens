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
 * 2b. MAP JA (v0.3.8) TCGdex Japanese sets without TCGplayer products ↔ TCGplayer Japan groups with the same
 *            set code (or a curated alias). A pair is accepted only when the collector number is unique on
 *            both sides AND it is proven card by card: Pokémon — the TCGplayer (English) name contains the
 *            species name of the TCGdex Pokédex number (learned from English TCGdex cards) and HP agree;
 *            Trainer/Energy — same card category and the group passed the Pokémon check (≥ 90 %, ≥ 5 pairs).
 *            Rule TP_GAP_JA_NUMBER_SPECIES. Images and TCGplayer Japan prices follow.
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
    await fillEmptyJapaneseSets(db, { tcgcsvSourceId, tcgplayerSourceId, venueId, syncRunId });
    await mapUnmappedSets(db, { tcgcsvSourceId, tcgplayerSourceId, syncRunId });
    await mapJapaneseSets(db, { tcgcsvSourceId, tcgplayerSourceId, venueId, syncRunId });
    await attachMissingImages(db, tcgplayerSourceId);
    await shareSiblingImages(db);
    await variantsFromTcgplayerSubtypes(db);
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
    await fillSetFromGroup(db, ctx, setId, code, group, products);
    stats.prices += await prices(db, ctx, TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId);
  }
}

/** Printings, product ids and reference images of a Japanese set from its TCGplayer Japan group. */
async function fillSetFromGroup(db: any, ctx: Ctx, setId: string, code: string, group: TcgcsvGroup, products: TcgcsvProduct[]) {
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
}

/**
 * 1b. FILL (v0.3.8) Japanese sets TCGdex lists without any card: printings from the TCGplayer Japan group with
 *     the same set code — only when that code names exactly one group, released within 30 days of the set,
 *     and the printed total agrees with the set's official count when TCGdex gives one.
 */
async function fillEmptyJapaneseSets(db: any, ctx: Ctx) {
  const sets = (await db.query(
    `SELECT cs.entity_id, cs.official_set_code, cs.official_name, cs.release_date, cs.printed_card_count FROM card_sets cs
      WHERE cs.language_code='ja' AND NOT EXISTS (SELECT 1 FROM card_printings cp WHERE cp.set_id=cs.entity_id)`)).rows;
  const groups = await tcgcsv.listGroups(TCGCSV_POKEMON_JAPAN_CATEGORY);
  const fill = { filled: 0, skipped: [] as string[] };
  for (const set of sets) {
    const code = String(set.official_set_code || '');
    const cands = groups.filter(g => g.abbreviation && String(g.abbreviation).toLowerCase() === code.toLowerCase());
    if (cands.length !== 1) { if (cands.length) fill.skipped.push(`${code}: ${cands.length} groups`); continue; }
    const group = cands[0];
    const days = Math.abs(new Date(String(group.publishedOn)).getTime() - new Date(set.release_date).getTime()) / 864e5;
    if (!(days <= 30)) { fill.skipped.push(`${code}: release ${Math.round(days)} days apart`); continue; }
    const products = (await tcgcsv.listProducts(TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId)).filter(p => number(p));
    if (products.length < 5) { fill.skipped.push(`${code}: ${products.length} numbered products`); continue; }
    const printedTotal = mode(products.map(p => Number(number(p)!.split('/')[1])).filter(Number.isFinite));
    if (set.printed_card_count && printedTotal && Number(set.printed_card_count) !== printedTotal) { fill.skipped.push(`${code}: total ${printedTotal} vs ${set.printed_card_count}`); continue; }
    if (dryRun) { console.log('would fill', code, group.name, products.length); fill.filled++; continue; }
    await db.query(
      `INSERT INTO external_identifiers(entity_id,source_id,namespace,external_value,scope_language_code,verified)
       VALUES ($1,$2,'groups',$3,'ja',true) ON CONFLICT(source_id,namespace,scope_language_code,external_value) DO NOTHING`,
      [set.entity_id, ctx.tcgplayerSourceId, String(group.groupId)]);
    await fillSetFromGroup(db, ctx, set.entity_id, code, group as TcgcsvGroup, products);
    stats.prices += await prices(db, ctx, TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId);
    fill.filled++;
  }
  (stats as any).filledJapaneseSets = fill;
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

/** TCGdex JA set code → TCGplayer Japan group names, for groups published without an abbreviation. */
export const JA_GROUP_ALIASES: Record<string, string[]> = {
  MC: ['Start Deck 100 Battle Collection'],
  PCG1: ['Flight of Legends'], PCG2: ['Clash of the Blue Sky'], PCG3: ['Rocket Gang Strikes Back'], PCG4: ['Golden Sky, Silvery Ocean'],
  PCG5: ['Mirage Forest'], PCG6: ['Holon Research Tower'], PCG7: ['Holon Phantom'], PCG8: ['Miracle Crystal'], PCG9: ['Offense and Defense of the Furthest Ends'],
  E1: ['Base Expansion Pack'], E2: ['The Town on No Map'], E3: ['Wind from the Sea'], E4: ['Split Earth'], E5: ['Mysterious Mountains'],
  VS1: ['Pokemon VS'], web1: ['Pokemon Web'],
};

const tokenSet = (s: string) => new Set(normalizeTextV1(String(s).normalize('NFD').replace(/\p{M}+/gu, '').replace(/♀/g, 'f').replace(/♂/g, 'm')).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean));

/** Pokédex number → tokens shared by ≥ 60 % of English TCGdex card names of that species ("mr", "mime"). */
async function speciesTokens(db: any): Promise<Map<number, Set<string>>> {
  const rows = (await db.query(
    `SELECT (raw_payload->'dexId'->>0)::int AS dex, raw_payload->>'name' AS name FROM source_records sr JOIN data_sources d ON d.source_id=sr.source_id
      WHERE d.source_code='tcgdex' AND sr.namespace='cards' AND sr.scope_language_code='en' AND jsonb_array_length(COALESCE(raw_payload->'dexId','[]'::jsonb))=1`)).rows;
  const by = new Map<number, string[]>();
  for (const r of rows) by.set(r.dex, [...(by.get(r.dex) ?? []), r.name]);
  const out = new Map<number, Set<string>>();
  for (const [dex, names] of by) {
    const c = new Map<string, number>();
    for (const n of names) for (const t of tokenSet(n)) c.set(t, (c.get(t) ?? 0) + 1);
    const keep = new Set([...c].filter(([, k]) => k / names.length >= 0.6).map(([t]) => t));
    if (keep.size) out.set(dex, keep);
  }
  return out;
}

export type JaPairCheck = 'POKEMON_OK' | 'TRAINER_OK' | 'REJECT' | 'UNPROVEN';
/** Card-level proof that a TCGdex JA card and a TCGplayer Japan product are the same printing. */
export function checkJaPair(card: any, product: TcgcsvProduct, species: Map<number, Set<string>>): JaPairCheck {
  const ext = (k: string) => product.extendedData?.find(e => e.name === k)?.value?.trim();
  const pTokens = tokenSet(cleanCardName(product));
  const dex: number[] = Array.isArray(card?.dexId) ? card.dexId : [];
  const isPokemon = String(card?.category || '').toLowerCase() === 'pokemon';
  if (isPokemon) {
    const hp = Number(ext('HP')), chp = Number(card?.hp);
    if (Number.isFinite(hp) && hp > 0 && Number.isFinite(chp) && chp > 0 && hp !== chp) return 'REJECT';
    if (!dex.length) return 'UNPROVEN';
    const known = dex.map(d => species.get(d)).filter(Boolean) as Set<string>[];
    if (known.length < dex.length) return 'UNPROVEN';
    return known.every(sp => [...sp].some(t => pTokens.has(t))) ? 'POKEMON_OK' : 'REJECT';
  }
  // Trainer / Energy: TCGplayer must not describe a Pokémon (no HP, no Stage).
  if (ext('HP') || ext('Stage')) return 'REJECT';
  return 'TRAINER_OK';
}

async function mapJapaneseSets(db: any, ctx: Ctx) {
  const species = await speciesTokens(db);
  const sets = (await db.query(
    `SELECT cs.entity_id, cs.official_name, cs.official_set_code FROM card_sets cs
      WHERE cs.language_code='ja' AND EXISTS (SELECT 1 FROM card_printings cp WHERE cp.set_id=cs.entity_id)
        AND NOT EXISTS (SELECT 1 FROM card_printings cp JOIN external_identifiers e ON e.entity_id=cp.entity_id
                         WHERE cp.set_id=cs.entity_id AND e.source_id=$1 AND e.namespace='products')`, [ctx.tcgplayerSourceId])).rows;
  const groups = await tcgcsv.listGroups(TCGCSV_POKEMON_JAPAN_CATEGORY);
  const jaStats = { sets: 0, setsMapped: 0, pairs: 0, rejected: 0, unproven: 0, groupsRejected: [] as string[] };
  for (const set of sets) {
    const code = String(set.official_set_code || '');
    const aliases = JA_GROUP_ALIASES[code] ?? [];
    const cands = groups.filter(g => (g.abbreviation && String(g.abbreviation).toLowerCase() === code.toLowerCase()) || aliases.includes(String(g.name)));
    if (!cands.length) continue;
    jaStats.sets++;
    const printings = (await db.query(
      `SELECT cp.entity_id, cp.collector_number_raw, sr.raw_payload AS card
         FROM card_printings cp
         LEFT JOIN external_identifiers e ON e.entity_id=cp.entity_id AND e.namespace='cards'
         LEFT JOIN data_sources d ON d.source_id=e.source_id AND d.source_code='tcgdex'
         LEFT JOIN source_records sr ON sr.source_id=d.source_id AND sr.namespace='cards' AND sr.scope_language_code='ja' AND sr.external_key=e.external_value
        WHERE cp.set_id=$1`, [set.entity_id])).rows.filter((r: any) => r.card);
    const numCount = new Map<string, number>();
    for (const pr of printings) { const k = collectorNumberMatchKeyV1(pr.collector_number_raw); numCount.set(k, (numCount.get(k) ?? 0) + 1); }
    for (const group of cands) {
      const products = (await tcgcsv.listProducts(TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId)).filter(p => number(p));
      const byNum = new Map<string, TcgcsvProduct[]>();
      for (const p of products) { const k = collectorNumberMatchKeyV1(String(number(p)).split('/')[0]); byNum.set(k, [...(byNum.get(k) ?? []), p]); }
      const pairs = printings.map((pr: any) => {
        const k = collectorNumberMatchKeyV1(pr.collector_number_raw); const hits = byNum.get(k) ?? [];
        if (numCount.get(k) !== 1 || hits.length !== 1) return null;
        return { pr, product: hits[0], check: checkJaPair(pr.card, hits[0], species) };
      }).filter(Boolean) as Array<{ pr: any; product: TcgcsvProduct; check: JaPairCheck }>;
      const poke = pairs.filter(x => x.check === 'POKEMON_OK' || x.check === 'REJECT');
      const ok = pairs.filter(x => x.check === 'POKEMON_OK').length;
      const rate = poke.length ? ok / poke.length : 0;
      if (poke.length < 5 || rate < 0.9) { jaStats.groupsRejected.push(`${code}↔${group.name}: ${ok}/${poke.length}`); continue; }
      jaStats.setsMapped++;
      for (const { pr, product, check } of pairs) {
        if (check === 'REJECT') { jaStats.rejected++; if (dryRun) console.log('reject', code, pr.collector_number_raw, pr.card?.name, pr.card?.hp, '↔', product.name); continue; }
        if (check === 'UNPROVEN') { jaStats.unproven++; continue; }
        if (dryRun) { jaStats.pairs++; if (process.env.SHOW_PAIRS && Math.random() < 0.004) console.log('pair', code, pr.collector_number_raw, pr.card?.name, '↔', product.name); continue; }
        const normalized = normalizeTcgcsvProduct(group as TcgcsvGroup, product);
        const sourceRecordId = await upsertSourceRecord(db, {
          sourceId: ctx.tcgcsvSourceId, syncRunId: ctx.syncRunId, namespace: 'products', externalKey: String(product.productId),
          scopeLanguageCode: 'ja', rawPayload: product, normalizedPayload: normalized, normalizationVersion: 'tcgplayer-gap-v1',
        });
        await linkProduct(db, ctx, pr.entity_id, product.productId, 'ja', sourceRecordId, 'TP_GAP_JA_NUMBER_SPECIES');
        await attachImage(db, ctx.tcgplayerSourceId, pr.entity_id, product.productId, sourceRecordId);
        jaStats.pairs++; stats.mapped++;
      }
      if (!dryRun) stats.prices += await prices(db, ctx, TCGCSV_POKEMON_JAPAN_CATEGORY, group.groupId);
    }
  }
  (stats as any).japanese = jaStats;
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

/**
 * 4. SHARE (v0.3.8) A physical printing with no reference image borrows the reference image of a printing of the
 *    same TCGdex card in another language (TCGdex shares card ids across FR/EN: same artwork). Only images whose
 *    probe did not fail. The printed language is never inferred from the image (LanguageEvidence decides).
 */
async function shareSiblingImages(db: any) {
  if (dryRun) return;
  const r = await db.query(
    `WITH td AS (SELECT source_id FROM data_sources WHERE source_code='tcgdex'),
          missing AS (SELECT cp.entity_id FROM card_printings cp JOIN card_sets cs ON cs.entity_id=cp.set_id AND cs.product_medium='PHYSICAL'
                       WHERE NOT EXISTS (SELECT 1 FROM entity_images ei WHERE ei.entity_id=cp.entity_id AND ei.role='REFERENCE')),
          pick AS (
            SELECT DISTINCT ON (m.entity_id) m.entity_id, ei.image_id
              FROM missing m
              JOIN external_identifiers e1 ON e1.entity_id=m.entity_id AND e1.namespace='cards' AND e1.source_id=(SELECT source_id FROM td)
              JOIN external_identifiers e2 ON e2.source_id=e1.source_id AND e2.namespace='cards' AND e2.external_value=e1.external_value AND e2.entity_id<>e1.entity_id
              JOIN entity_images ei ON ei.entity_id=e2.entity_id AND ei.role='REFERENCE'
              JOIN image_origins io ON io.image_id=ei.image_id
              LEFT JOIN image_probes ip ON ip.image_origin_id=io.image_origin_id
             WHERE ip.ok IS NOT FALSE
             ORDER BY m.entity_id, (ip.ok IS TRUE) DESC, (e2.scope_language_code='en') DESC)
     INSERT INTO entity_images(entity_id,image_id,role,view_type,is_primary,sort_order)
     SELECT entity_id, image_id, 'REFERENCE', 'FRONT', false, 2 FROM pick
     ON CONFLICT(entity_id,image_id,role,view_type) DO NOTHING`);
  (stats as any).siblingImagesShared = r.rowCount;
}

/** TCGplayer price sub-type → variant (same codes/finishes as the TCGdex variant plan). */
export const SUBTYPE_VARIANTS: Record<string, { code: string; finish: string; edition: string | null; stamp: string | null }> = {
  'Normal': { code: 'normal', finish: 'NON_HOLO', edition: null, stamp: null },
  'Unlimited': { code: 'normal', finish: 'NON_HOLO', edition: null, stamp: null },
  'Holofoil': { code: 'holo', finish: 'HOLO', edition: null, stamp: null },
  'Unlimited Holofoil': { code: 'holo', finish: 'HOLO', edition: null, stamp: null },
  'Reverse Holofoil': { code: 'reverse', finish: 'REVERSE_HOLO', edition: null, stamp: null },
  '1st Edition': { code: 'normal+stamp-1st-edition', finish: 'NON_HOLO', edition: '1ST_EDITION', stamp: '1st-edition' },
  '1st Edition Holofoil': { code: 'holo+stamp-1st-edition', finish: 'HOLO', edition: '1ST_EDITION', stamp: '1st-edition' },
};

/**
 * 5. VARIANTS (v0.3.8) Printings created from TCGplayer (no TCGdex variant data) get their variants from the
 *    sub-types TCGplayer actually prices for that product (Normal / Holofoil / Reverse Holofoil / 1st Edition…).
 *    A printing without any priced sub-type gets none (not proven).
 */
async function variantsFromTcgplayerSubtypes(db: any) {
  if (dryRun) return;
  const rows = (await db.query(
    `SELECT DISTINCT cp.entity_id AS printing_id, ce.canonical_key, sr.normalized_payload->>'subtype' AS subtype, sr.source_id
       FROM card_printings cp
       JOIN catalog_entities ce ON ce.entity_id=cp.entity_id AND ce.canonicalization_method='BOOTSTRAP_TCGPLAYER_GAP'
       JOIN external_identifiers e ON e.entity_id=cp.entity_id AND e.namespace='products'
       JOIN data_sources d ON d.source_id=e.source_id AND d.source_code='tcgplayer'
       JOIN source_records sr ON sr.namespace='prices' AND sr.scope_language_code=e.scope_language_code
            AND (sr.normalized_payload->>'productId')=e.external_value
      WHERE NOT EXISTS (SELECT 1 FROM card_variants cv WHERE cv.printing_id=cp.entity_id)`)).rows;
  let n = 0;
  for (const r of rows) {
    const v = SUBTYPE_VARIANTS[r.subtype]; if (!v) continue;
    const key = `variant:${String(r.canonical_key).replace(/^card:/, '')}:${v.code}`;
    const id = (await db.query(
      `INSERT INTO catalog_entities(entity_type,canonical_key,resolution_state,canonicalization_method,canonical_source_id)
       VALUES ('CARD_VARIANT',$1,'CANONICAL','BOOTSTRAP_TCGPLAYER_GAP',(SELECT source_id FROM data_sources WHERE source_code='tcgplayer'))
       ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now() RETURNING entity_id`, [key])).rows[0].entity_id;
    const ins = await db.query(
      `INSERT INTO card_variants(entity_id,printing_id,variant_code,finish,edition_mark,stamp,variant_fingerprint,size_code)
       VALUES ($1,$2,$3,$4,$5,$6,encode(sha256(convert_to('variant-v1|' || $3::text,'UTF8')),'hex'),'STANDARD')
       ON CONFLICT DO NOTHING RETURNING entity_id`, [id, r.printing_id, v.code, v.finish, v.edition, v.stamp]);
    if (ins.rows[0]) n++;
  }
  (stats as any).variantsFromSubtypes = n;
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
