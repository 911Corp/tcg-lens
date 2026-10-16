import assert from 'node:assert/strict';
import pg from 'pg';
import {
  normalizeCardmarketPrice,
  normalizeCardmarketProduct,
  normalizeTcgdexCard,
  normalizeTcgcsvPrice,
  normalizeTcgcsvProduct,
  type TcgdexCard,
  type TcgcsvGroup,
  type TcgcsvProduct
} from '../../../packages/ingestion/src/index.js';
import { promoteTcgdexCard, payloadHash } from '../src/tcgdex-canonical.js';
import { enrichCardmarketPrinting, enrichTcgcsvPrinting, persistCardmarketPrice, persistTcgcsvPrice } from '../src/card-printing-enrichment.js';
import { upsertSourceRecord } from '../src/source-record.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('SKIP market-enrichment-postgres.integration: TEST_DATABASE_URL is not set');
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sources = await client.query(`SELECT source_code,source_id FROM data_sources WHERE source_code IN ('tcgdex','cardmarket','tcgcsv','tcgplayer')`);
    const ids = Object.fromEntries(sources.rows.map((r: any) => [r.source_code, r.source_id])) as Record<string,string>;
    for (const code of ['tcgdex','cardmarket','tcgcsv','tcgplayer']) assert.ok(ids[code], `missing source ${code}`);
    const venues = await client.query(`SELECT venue_code,venue_id FROM market_venues WHERE venue_code IN ('cardmarket','tcgplayer')`);
    const venueIds = Object.fromEntries(venues.rows.map((r: any) => [r.venue_code, r.venue_id])) as Record<string,string>;

    // Seed one canonical CARD_PRINTING through the real TCGdex promotion path.
    const card: TcgdexCard = {
      id: 'market-integration-en-199', localId: '199', name: 'Charizard ex',
      set: { id: 'market-integration-151', name: '151', cardCount: { official: 165, total: 207 } }
    };
    const normalizedCard = normalizeTcgdexCard('en', card);
    const tcgdexRun = await client.query(`INSERT INTO sync_runs(source_id,status) VALUES($1,'RUNNING') RETURNING sync_run_id`, [ids.tcgdex]);
    const tcgdexRecord = await client.query(
      `INSERT INTO source_records(source_id,sync_run_id,namespace,external_key,scope_language_code,raw_payload,normalized_payload,normalization_version,payload_hash)
       VALUES($1,$2,'cards',$3,'en',$4::jsonb,$5::jsonb,'norm-v1',$6)
       ON CONFLICT(source_id,namespace,scope_language_code,external_key)
       DO UPDATE SET raw_payload=EXCLUDED.raw_payload,normalized_payload=EXCLUDED.normalized_payload,payload_hash=EXCLUDED.payload_hash,last_seen_at=now()
       RETURNING source_record_id`,
      [ids.tcgdex, tcgdexRun.rows[0].sync_run_id, card.id, JSON.stringify(card), JSON.stringify(normalizedCard), payloadHash(card)]
    );
    const canonical = await promoteTcgdexCard(client, { sourceId: ids.tcgdex, sourceRecordId: tcgdexRecord.rows[0].source_record_id, normalized: normalizedCard });
    assert.ok(canonical.entityId);

    // Cardmarket product -> same CARD_PRINTING.
    const cmRaw = {
      idProduct: 12345,
      name: 'Charizard ex (MEW 199)',
      idCategory: 51,
      idExpansion: 15101,
      expansionName: '151',
      number: '199/165',
      rarity: 'Special Illustration Rare'
    };
    const cm = normalizeCardmarketProduct(cmRaw, 'single');
    const cmRecord = await upsertSourceRecord(client, {
      sourceId: ids.cardmarket, namespace: 'products', externalKey: cm.externalKey,
      rawPayload: cmRaw, normalizedPayload: cm, normalizationVersion: 'cardmarket-v0.1'
    });
    const cmResult = await enrichCardmarketPrinting(client, { cardmarketSourceId: ids.cardmarket, sourceRecordId: cmRecord, product: cm });
    assert.equal(cmResult.status, 'AUTO_MATCH');
    assert.deepEqual(cmResult.entityIds, [canonical.entityId]);

    const cmPrice = normalizeCardmarketPrice({ idProduct: 12345, trend: 185, avg7: 181, avg30: 176 }, '2026-10-16T00:00:00Z');
    const cmPriceRecord = await upsertSourceRecord(client, {
      sourceId: ids.cardmarket, namespace: 'prices', externalKey: `12345:${cmPrice.observedAt}`,
      rawPayload: cmPrice.raw, normalizedPayload: cmPrice, normalizationVersion: 'cardmarket-v0.1'
    });
    await persistCardmarketPrice(client, { cardmarketSourceId: ids.cardmarket, venueId: venueIds.cardmarket, sourceRecordId: cmPriceRecord, price: cmPrice });

    // TCGCSV/TCGplayer product -> same CARD_PRINTING.
    const group: TcgcsvGroup = { groupId: 3170, name: '151', abbreviation: 'MEW', categoryId: 3 };
    const tpRaw: TcgcsvProduct = {
      productId: 451396, name: 'Charizard ex', cleanName: 'Charizard ex', categoryId: 3, groupId: 3170,
      extendedData: [{ name: 'Number', value: '199/165' }, { name: 'Rarity', value: 'Special Illustration Rare' }]
    };
    const tp = normalizeTcgcsvProduct(group, tpRaw);
    const tpRecord = await upsertSourceRecord(client, {
      sourceId: ids.tcgcsv, namespace: 'products', externalKey: tp.externalKey, scopeLanguageCode: 'en',
      rawPayload: tpRaw, normalizedPayload: tp, normalizationVersion: 'tcgcsv-v0.1'
    });
    const tpResult = await enrichTcgcsvPrinting(client, { tcgcsvSourceId: ids.tcgcsv, tcgplayerSourceId: ids.tcgplayer, sourceRecordId: tpRecord, product: tp });
    assert.equal(tpResult.status, 'AUTO_MATCH');
    assert.deepEqual(tpResult.entityIds, [canonical.entityId]);

    const tpPrice = normalizeTcgcsvPrice(3, { productId: 451396, lowPrice: 170, midPrice: 185, marketPrice: 181, subTypeName: 'Holofoil' }, '2026-10-16T10:00:00Z');
    const tpPriceRecord = await upsertSourceRecord(client, {
      sourceId: ids.tcgcsv, namespace: 'prices', externalKey: `${tpPrice.externalKey}:2026-10-16`, scopeLanguageCode: 'en',
      rawPayload: tpPrice.raw, normalizedPayload: tpPrice, normalizationVersion: 'tcgcsv-v0.1'
    });
    await persistTcgcsvPrice(client, { tcgcsvSourceId: ids.tcgcsv, tcgplayerSourceId: ids.tcgplayer, venueId: venueIds.tcgplayer, sourceRecordId: tpPriceRecord, price: tpPrice });

    // Idempotence: rerunning enrichment and identical price snapshots must not duplicate IDs/links/observations.
    await enrichCardmarketPrinting(client, { cardmarketSourceId: ids.cardmarket, sourceRecordId: cmRecord, product: cm });
    await enrichTcgcsvPrinting(client, { tcgcsvSourceId: ids.tcgcsv, tcgplayerSourceId: ids.tcgplayer, sourceRecordId: tpRecord, product: tp });
    await persistCardmarketPrice(client, { cardmarketSourceId: ids.cardmarket, venueId: venueIds.cardmarket, sourceRecordId: cmPriceRecord, price: cmPrice });
    await persistTcgcsvPrice(client, { tcgcsvSourceId: ids.tcgcsv, tcgplayerSourceId: ids.tcgplayer, venueId: venueIds.tcgplayer, sourceRecordId: tpPriceRecord, price: tpPrice });

    const ext = await client.query(
      `SELECT ds.source_code,ei.external_value,ei.scope_language_code
         FROM external_identifiers ei JOIN data_sources ds ON ds.source_id=ei.source_id
        WHERE ei.entity_id=$1 AND ds.source_code IN ('cardmarket','tcgplayer')`, [canonical.entityId]
    );
    assert.equal(ext.rows.filter((x: any) => x.source_code === 'cardmarket' && x.external_value === '12345').length, 1);
    assert.equal(ext.rows.filter((x: any) => x.source_code === 'tcgplayer' && x.external_value === '451396').length, 1);

    const links = await client.query(`SELECT count(*)::int AS n FROM source_entity_links WHERE entity_id=$1 AND mapping_status='VERIFIED'`, [canonical.entityId]);
    assert.equal(links.rows[0].n, 2);

    const market = await client.query(
      `SELECT ds_reporter.source_code AS reporter,ds_origin.source_code AS origin,metric_type,amount
         FROM market_observations mo
         JOIN data_sources ds_reporter ON ds_reporter.source_id=mo.reported_by_source
         JOIN data_sources ds_origin ON ds_origin.source_id=mo.origin_source
        WHERE mo.entity_id=$1`, [canonical.entityId]
    );
    assert.ok(market.rows.some((x: any) => x.reporter === 'cardmarket' && x.origin === 'cardmarket' && x.metric_type === 'TREND'));
    assert.ok(market.rows.some((x: any) => x.reporter === 'tcgcsv' && x.origin === 'tcgplayer' && x.metric_type === 'MARKET'));
    const uniqueMarketRows = new Set(market.rows.map((x: any) => `${x.reporter}|${x.origin}|${x.metric_type}|${x.amount}`));
    assert.equal(uniqueMarketRows.size, market.rows.length);

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  console.log('PASS market-enrichment-postgres.integration');
} finally {
  await pool.end();
}
