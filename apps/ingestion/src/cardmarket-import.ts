import { Pool } from 'pg';
import {
  CardmarketClient,
  normalizeCardmarketPrice,
  normalizeCardmarketProduct,
  normalizeCardmarketSealed
} from '../../../packages/ingestion/src/index.js';
import { enrichCardmarketPrinting, persistCardmarketPrice } from './card-printing-enrichment.js';
import { enrichSealedProduct } from './sealed-enrichment.js';
import { extractBarcodeCandidates, ingestBarcodeClaim } from './barcode-ingestion.js';
import { finishSyncRun, getSourceId, getVenueId, startSyncRun, upsertSourceRecord } from './source-record.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: DATABASE_URL });
const client = new CardmarketClient();
const only = new Set((process.argv[2] ?? 'singles,nonsingles,prices').split(',').map(x => x.trim()).filter(Boolean));
const limit = Number(process.env.IMPORT_LIMIT ?? '0') || undefined;

const stats = {
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
  const sourceId = await getSourceId(db, 'cardmarket');
  const venueId = await getVenueId(db, 'cardmarket');
  const syncRunId = await startSyncRun(db, sourceId);
  try {
    if (only.has('singles')) {
      const file = await client.fetchSingles();
      const products = limit ? file.products.slice(0, limit) : file.products;
      for (const raw of products) {
        const normalized = normalizeCardmarketProduct(raw, 'single');
        const sourceRecordId = await upsertSourceRecord(db, {
          sourceId, syncRunId, namespace: 'products', externalKey: normalized.externalKey,
          rawPayload: raw, normalizedPayload: normalized, normalizationVersion: 'cardmarket-v0.1'
        });
        const result = await enrichCardmarketPrinting(db, { cardmarketSourceId: sourceId, sourceRecordId, product: normalized });
        stats.productsSeen++;
        if (result.status === 'AUTO_MATCH') stats.autoMatched++;
        else if (result.status === 'CANDIDATE_MATCH') stats.candidateMatched++;
        else if (result.status === 'CONFLICT') stats.conflicts++;
        else stats.canonicalGaps++;
      }
    }

    if (only.has('nonsingles')) {
      const file = await client.fetchNonSingles();
      const products = limit ? file.products.slice(0, limit) : file.products;
      for (const raw of products) {
        const normalized = normalizeCardmarketProduct(raw, 'non_single');
        const sourceRecordId = await upsertSourceRecord(db, {
          sourceId, syncRunId, namespace: 'products', externalKey: normalized.externalKey,
          rawPayload: raw, normalizedPayload: normalized, normalizationVersion: 'cardmarket-v0.2'
        });
        stats.productsSeen++;
        const sealed = normalizeCardmarketSealed(normalized);
        if (sealed) {
          stats.sealedSeen++;
          const result = await enrichSealedProduct(db, { reportedBySourceId: sourceId, originSourceId: sourceId, sourceRecordId, product: sealed });
          if (result.status === 'NEW_ENTITY') stats.sealedCreated++;
          const entityId = result.entityIds.length === 1 ? result.entityIds[0] : undefined;
          for (const barcode of extractBarcodeCandidates(raw)) {
            await ingestBarcodeClaim(db, { sourceId, sourceRecordId, rawValue: barcode, sourceExternalValue: normalized.externalKey, entityId, verified: false, confidence: 0.8, evidence: { source: 'cardmarket', inferred_from_payload: true } });
            stats.barcodeClaims++;
          }
        }
      }
    }

    if (only.has('prices')) {
      const file = await client.fetchPrices();
      const prices = limit ? file.priceGuides.slice(0, limit) : file.priceGuides;
      for (const raw of prices) {
        const normalized = normalizeCardmarketPrice(raw, file.createdAt);
        const snapshotKey = `${normalized.idProduct}:${normalized.observedAt}`;
        const sourceRecordId = await upsertSourceRecord(db, {
          sourceId, syncRunId, namespace: 'prices', externalKey: snapshotKey,
          rawPayload: raw, normalizedPayload: normalized, normalizationVersion: 'cardmarket-v0.1'
        });
        stats.pricesSeen++;
        stats.observationsWritten += await persistCardmarketPrice(db, { cardmarketSourceId: sourceId, venueId, sourceRecordId, price: normalized });
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

await main();
