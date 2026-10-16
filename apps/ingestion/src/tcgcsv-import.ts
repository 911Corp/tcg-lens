import { Pool } from 'pg';
import {
  TcgcsvClient,
  TCGCSV_POKEMON_CATEGORY,
  TCGCSV_POKEMON_JAPAN_CATEGORY,
  normalizeTcgcsvPrice,
  normalizeTcgcsvProduct,
  tcgcsvLanguageForCategory,
  normalizeTcgcsvSealed
} from '../../../packages/ingestion/src/index.js';
import { enrichTcgcsvPrinting, persistTcgcsvPrice } from './card-printing-enrichment.js';
import { enrichSealedProduct } from './sealed-enrichment.js';
import { extractBarcodeCandidates, ingestBarcodeClaim } from './barcode-ingestion.js';
import { finishSyncRun, getSourceId, getVenueId, startSyncRun, upsertSourceRecord } from './source-record.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: DATABASE_URL });
const source = new TcgcsvClient();
const categories = parseCategories(process.argv[2]);
const groupLimit = Number(process.env.GROUP_LIMIT ?? '0') || undefined;
const productLimit = Number(process.env.IMPORT_LIMIT ?? '0') || undefined;
const delayMs = Number(process.env.TCGCSV_DELAY_MS ?? '250');

const stats = {
  groupsSeen: 0,
  productsSeen: 0,
  autoMatched: 0,
  candidateMatched: 0,
  conflicts: 0,
  canonicalGaps: 0,
  pricesSeen: 0,
  observationsWritten: 0,
  sealedSeen: 0,
  sealedCreated: 0,
  barcodeClaims: 0
};

async function main() {
  const db = pool;
  const tcgcsvSourceId = await getSourceId(db, 'tcgcsv');
  const tcgplayerSourceId = await getSourceId(db, 'tcgplayer');
  const venueId = await getVenueId(db, 'tcgplayer');
  const syncRunId = await startSyncRun(db, tcgcsvSourceId);
  try {
    for (const categoryId of categories) {
      const groups = await source.listGroups(categoryId);
      const selectedGroups = groupLimit ? groups.slice(0, groupLimit) : groups;
      for (const group of selectedGroups) {
        stats.groupsSeen++;
        const language = tcgcsvLanguageForCategory(categoryId);
        await upsertSourceRecord(db, {
          sourceId: tcgcsvSourceId, syncRunId, namespace: 'groups', externalKey: String(group.groupId), scopeLanguageCode: language,
          rawPayload: group, normalizedPayload: group, normalizationVersion: 'tcgcsv-v0.1'
        });

        const products = await source.listProducts(categoryId, group.groupId);
        const selectedProducts = productLimit ? products.slice(0, productLimit) : products;
        for (const raw of selectedProducts) {
          const normalized = normalizeTcgcsvProduct(group, raw);
          const sourceRecordId = await upsertSourceRecord(db, {
            sourceId: tcgcsvSourceId, syncRunId, namespace: 'products', externalKey: normalized.externalKey, scopeLanguageCode: normalized.languageCode,
            rawPayload: raw, normalizedPayload: normalized, normalizationVersion: 'tcgcsv-v0.1'
          });
          stats.productsSeen++;
          const sealed = normalizeTcgcsvSealed(normalized);
          if (sealed) {
            stats.sealedSeen++;
            const sealedResult = await enrichSealedProduct(db, { reportedBySourceId: tcgcsvSourceId, originSourceId: tcgplayerSourceId, sourceRecordId, product: sealed });
            if (sealedResult.status === 'NEW_ENTITY') stats.sealedCreated++;
            else if (sealedResult.status === 'AUTO_MATCH') stats.autoMatched++;
            else if (sealedResult.status === 'CANDIDATE_MATCH') stats.candidateMatched++;
            else stats.conflicts++;
            const entityId = sealedResult.entityIds.length === 1 ? sealedResult.entityIds[0] : undefined;
            for (const barcode of extractBarcodeCandidates(raw)) {
              await ingestBarcodeClaim(db, { sourceId: tcgcsvSourceId, sourceRecordId, rawValue: barcode, sourceExternalValue: normalized.externalKey, entityId, verified: false, confidence: 0.8, evidence: { origin_source: 'tcgplayer', inferred_from_payload: true } });
              stats.barcodeClaims++;
            }
          } else {
            const result = await enrichTcgcsvPrinting(db, { tcgcsvSourceId, tcgplayerSourceId, sourceRecordId, product: normalized });
            if (result.status === 'AUTO_MATCH') stats.autoMatched++;
            else if (result.status === 'CANDIDATE_MATCH') stats.candidateMatched++;
            else if (result.status === 'CONFLICT') stats.conflicts++;
            else stats.canonicalGaps++;
          }
        }

        await sleep(delayMs);
        const prices = await source.listPrices(categoryId, group.groupId);
        const productIds = productLimit ? new Set(selectedProducts.map(p => p.productId)) : undefined;
        for (const raw of prices) {
          if (productIds && !productIds.has(raw.productId)) continue;
          const normalized = normalizeTcgcsvPrice(categoryId, raw);
          const date = normalized.observedAt.slice(0, 10);
          const sourceRecordId = await upsertSourceRecord(db, {
            sourceId: tcgcsvSourceId, syncRunId, namespace: 'prices', externalKey: `${normalized.externalKey}:${date}`, scopeLanguageCode: normalized.languageCode,
            rawPayload: raw, normalizedPayload: normalized, normalizationVersion: 'tcgcsv-v0.1'
          });
          stats.pricesSeen++;
          stats.observationsWritten += await persistTcgcsvPrice(db, { tcgcsvSourceId, tcgplayerSourceId, venueId, sourceRecordId, price: normalized });
        }
        await sleep(delayMs);
      }
    }

    await finishSyncRun(db, syncRunId, 'SUCCESS', stats);
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    await finishSyncRun(db, syncRunId, 'FAILED', { ...stats, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await pool.end();
  }
}

function parseCategories(raw?: string): number[] {
  if (!raw || raw === 'all') return [TCGCSV_POKEMON_CATEGORY, TCGCSV_POKEMON_JAPAN_CATEGORY];
  return raw.split(',').map(x => Number(x.trim())).filter(x => x === TCGCSV_POKEMON_CATEGORY || x === TCGCSV_POKEMON_JAPAN_CATEGORY);
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }

await main();
