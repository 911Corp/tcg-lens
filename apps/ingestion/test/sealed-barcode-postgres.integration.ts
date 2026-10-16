import assert from 'node:assert/strict';
import pg from 'pg';
import {
  normalizeCardmarketProduct,
  normalizeCardmarketSealed,
  normalizeTcgcsvProduct,
  normalizeTcgcsvSealed,
  type TcgcsvGroup,
  type TcgcsvProduct
} from '../../../packages/ingestion/src/index.js';
import { enrichSealedProduct } from '../src/sealed-enrichment.js';
import { ingestBarcodeClaim } from '../src/barcode-ingestion.js';
import { upsertSourceRecord } from '../src/source-record.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP sealed-barcode-postgres.integration: TEST_DATABASE_URL is not set');
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sources = await client.query(`SELECT source_code,source_id FROM data_sources WHERE source_code IN ('cardmarket','tcgcsv','tcgplayer','internal_verified')`);
    const ids = Object.fromEntries(sources.rows.map((r: any) => [r.source_code, r.source_id])) as Record<string,string>;
    for (const code of ['cardmarket','tcgcsv','tcgplayer','internal_verified']) assert.ok(ids[code], `missing source ${code}`);

    // 1) Cardmarket seeds a STAGED sealed identity.
    const cmRaw = { idProduct: 960001, name: 'Pokemon 151 Elite Trainer Box', expansionName: '151', categoryName: 'Elite Trainer Boxes' };
    const cm = normalizeCardmarketSealed(normalizeCardmarketProduct(cmRaw, 'non_single'))!;
    const cmRecord = await upsertSourceRecord(client, {
      sourceId: ids.cardmarket, namespace: 'products', externalKey: cm.externalKey,
      rawPayload: cmRaw, normalizedPayload: cm, normalizationVersion: 'cardmarket-v0.2'
    });
    const first = await enrichSealedProduct(client, { reportedBySourceId: ids.cardmarket, originSourceId: ids.cardmarket, sourceRecordId: cmRecord, product: cm });
    assert.equal(first.status, 'NEW_ENTITY');
    assert.equal(first.entityIds.length, 1);
    const entityId = first.entityIds[0];
    const staged = await client.query(`SELECT resolution_state FROM catalog_entities WHERE entity_id=$1`, [entityId]);
    assert.equal(staged.rows[0].resolution_state, 'STAGED');

    // 2) Independent TCGplayer identity via TCGCSV corroborates the same structural product.
    const group: TcgcsvGroup = { groupId: 9151, name: '151', categoryId: 3 };
    const tpRaw: TcgcsvProduct = { productId: 970001, name: 'Pokemon 151 Elite Trainer Box', cleanName: 'Pokemon 151 Elite Trainer Box', categoryId: 3, groupId: 9151 };
    const tp = normalizeTcgcsvSealed(normalizeTcgcsvProduct(group, tpRaw))!;
    const tpRecord = await upsertSourceRecord(client, {
      sourceId: ids.tcgcsv, namespace: 'products', externalKey: tp.externalKey, scopeLanguageCode: 'en',
      rawPayload: tpRaw, normalizedPayload: tp, normalizationVersion: 'tcgcsv-v0.2'
    });
    const second = await enrichSealedProduct(client, { reportedBySourceId: ids.tcgcsv, originSourceId: ids.tcgplayer, sourceRecordId: tpRecord, product: tp });
    assert.equal(second.status, 'AUTO_MATCH');
    assert.deepEqual(second.entityIds, [entityId]);
    const canonical = await client.query(`SELECT resolution_state FROM catalog_entities WHERE entity_id=$1`, [entityId]);
    assert.equal(canonical.rows[0].resolution_state, 'CANONICAL');

    // 3) Verified UPC claim becomes the single verified GTIN mapping.
    const barcodeRecord = await upsertSourceRecord(client, {
      sourceId: ids.internal_verified, namespace: 'barcode_claims', externalKey: 'etb-151:036000291452',
      rawPayload: { barcode: '036000291452', entity_id: entityId },
      normalizedPayload: { barcode: '036000291452', entity_id: entityId }, normalizationVersion: 'barcode-registry-v0.1'
    });
    const verified = await ingestBarcodeClaim(client, {
      sourceId: ids.internal_verified, sourceRecordId: barcodeRecord, rawValue: '036000291452', entityId, verified: true, confidence: 1
    });
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(verified.gtin14, '00036000291452');

    // 4) Idempotence: same claim + same source record creates one mapping.
    await ingestBarcodeClaim(client, {
      sourceId: ids.internal_verified, sourceRecordId: barcodeRecord, rawValue: '036000291452', entityId, verified: true, confidence: 1
    });
    const mappings = await client.query(`SELECT count(*)::int AS n FROM entity_barcodes WHERE barcode_id=$1 AND status='VERIFIED'`, [verified.barcodeId]);
    assert.equal(mappings.rows[0].n, 1);

    // 5) Same GTIN cannot verify a different physical product.
    const otherRaw = { idProduct: 960002, name: 'Pokemon 151 Booster Bundle', expansionName: '151', categoryName: 'Booster Bundles' };
    const other = normalizeCardmarketSealed(normalizeCardmarketProduct(otherRaw, 'non_single'))!;
    const otherRecord = await upsertSourceRecord(client, { sourceId: ids.cardmarket, namespace: 'products', externalKey: other.externalKey, rawPayload: otherRaw, normalizedPayload: other, normalizationVersion: 'cardmarket-v0.2' });
    const otherCreated = await enrichSealedProduct(client, { reportedBySourceId: ids.cardmarket, originSourceId: ids.cardmarket, sourceRecordId: otherRecord, product: other });
    const otherEntityId = otherCreated.entityIds[0];
    const conflictRecord = await upsertSourceRecord(client, {
      sourceId: ids.internal_verified, namespace: 'barcode_claims', externalKey: 'bundle-151:036000291452',
      rawPayload: { barcode: '036000291452', entity_id: otherEntityId }, normalizedPayload: { barcode: '036000291452', entity_id: otherEntityId }, normalizationVersion: 'barcode-registry-v0.1'
    });
    const conflict = await ingestBarcodeClaim(client, { sourceId: ids.internal_verified, sourceRecordId: conflictRecord, rawValue: '036000291452', entityId: otherEntityId, verified: true, confidence: 1 });
    assert.equal(conflict.status, 'CONFLICT');
    const conflicts = await client.query(`SELECT count(*)::int AS n FROM data_conflicts WHERE source_record_id=$1 AND conflict_type='BARCODE_COLLISION'`, [conflictRecord]);
    assert.equal(conflicts.rows[0].n, 1);

    await client.query('ROLLBACK');
  } finally { client.release(); }
  console.log('PASS sealed-barcode-postgres.integration');
} finally { await pool.end(); }
