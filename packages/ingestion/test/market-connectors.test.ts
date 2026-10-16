import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideCardmarketEnrichment,
  decideTcgcsvEnrichment,
  normalizeCardmarketPrice,
  normalizeCardmarketProduct,
  normalizeTcgcsvPrice,
  normalizeTcgcsvProduct,
  type CanonicalCardCandidate,
  type TcgcsvGroup,
  type TcgcsvProduct
} from '../src/index.js';

const charizardEn: CanonicalCardCandidate = {
  entity_id: '00000000-0000-0000-0000-000000000001',
  name: 'Charizard ex',
  collector_number_normalized: '199',
  language_code: 'en',
  set_name: '151',
  set_code: 'sv3pt5'
};

const charizardFr: CanonicalCardCandidate = {
  ...charizardEn,
  entity_id: '00000000-0000-0000-0000-000000000002',
  name: 'Dracaufeu-ex',
  language_code: 'fr'
};

test('Cardmarket normalizer extracts local collector number and strips display suffix', () => {
  const product = normalizeCardmarketProduct({
    idProduct: 12345,
    name: 'Charizard ex (MEW 199)',
    expansionName: '151',
    idExpansion: 999,
    idMetacard: 888,
    number: '199/165'
  }, 'single');
  assert.equal(product.collectorNumberNormalized, '199');
  assert.equal(product.normalizedName, 'charizard ex');
  const decision = decideCardmarketEnrichment(product, [charizardEn, charizardFr]);
  assert.equal(decision.status, 'AUTO_MATCH');
  assert.equal(decision.matches[0]?.entity_id, charizardEn.entity_id);
  assert.equal(decision.ruleId, 'CARDMARKET_NUMBER_NAME_SET_EXACT');
});

test('Cardmarket refuses ambiguous same-name/number enrichment', () => {
  const product = normalizeCardmarketProduct({ idProduct: 7, name: 'Pikachu', number: '25' }, 'single');
  const candidates: CanonicalCardCandidate[] = [
    { ...charizardEn, entity_id: 'a', name: 'Pikachu', collector_number_normalized: '25', set_name: 'Set A' },
    { ...charizardEn, entity_id: 'b', name: 'Pikachu', collector_number_normalized: '25', set_name: 'Set B' }
  ];
  const decision = decideCardmarketEnrichment(product, candidates);
  assert.equal(decision.status, 'CANDIDATE_MATCH');
  assert.equal(decision.matches.length, 2);
});

test('TCGCSV product normalizer maps category 3 to EN and fraction number to local number', () => {
  const group: TcgcsvGroup = { groupId: 100, name: '151', abbreviation: 'MEW', categoryId: 3 };
  const product: TcgcsvProduct = {
    productId: 451396,
    name: 'Charizard ex',
    cleanName: 'Charizard ex',
    categoryId: 3,
    groupId: 100,
    extendedData: [
      { name: 'Number', value: '199/165' },
      { name: 'Rarity', value: 'Special Illustration Rare' }
    ]
  };
  const normalized = normalizeTcgcsvProduct(group, product);
  assert.equal(normalized.languageCode, 'en');
  assert.equal(normalized.collectorNumberNormalized, '199');
  const decision = decideTcgcsvEnrichment(normalized, [charizardEn, charizardFr]);
  assert.equal(decision.status, 'AUTO_MATCH');
  assert.equal(decision.matches[0]?.entity_id, charizardEn.entity_id);
});

test('TCGCSV category 85 maps to JA and does not match EN candidate', () => {
  const group: TcgcsvGroup = { groupId: 200, name: 'Pokemon Card 151', categoryId: 85 };
  const product: TcgcsvProduct = {
    productId: 999,
    name: 'リザードンex',
    categoryId: 85,
    groupId: 200,
    extendedData: [{ name: 'Number', value: '201/165' }]
  };
  const normalized = normalizeTcgcsvProduct(group, product);
  assert.equal(normalized.languageCode, 'ja');
  const decision = decideTcgcsvEnrichment(normalized, [charizardEn]);
  assert.notEqual(decision.status, 'AUTO_MATCH');
});

test('Cardmarket price guide normalizes standard and holo metrics in EUR', () => {
  const price = normalizeCardmarketPrice({
    idProduct: 12345,
    trend: 185,
    avg7: 180,
    'trend-holo': 210
  }, '2026-10-16T00:00:00Z');
  assert.equal(price.currency, 'EUR');
  assert.equal(price.metrics.length, 3);
  assert.equal(price.metrics.find(x => x.metricType === 'TREND')?.amount, 185);
  assert.equal(price.metrics.filter(x => x.metadata?.cardmarket_variant === 'holo').length, 1);
});

test('TCGCSV price normalizes TCGplayer subtype and metrics in USD', () => {
  const price = normalizeTcgcsvPrice(3, {
    productId: 451396,
    lowPrice: 170,
    midPrice: 185,
    marketPrice: 181,
    subTypeName: 'Holofoil'
  }, '2026-10-16T10:00:00Z');
  assert.equal(price.languageCode, 'en');
  assert.equal(price.currency, 'USD');
  assert.equal(price.metrics.find(x => x.metricType === 'MARKET')?.amount, 181);
  assert.equal(price.metrics[0]?.metadata.tcgplayer_subtype, 'Holofoil');
});
