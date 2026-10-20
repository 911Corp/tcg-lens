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

test('TCGCSV names carrying the printed number ("Greninja ex - 021/128") still match by group, number and name', () => {
  const group: TcgcsvGroup = { groupId: 24722, name: 'ME: 30th Celebration', abbreviation: '30C', categoryId: 3 };
  const product: TcgcsvProduct = {
    productId: 696676, name: 'Greninja ex - 021/128', cleanName: 'Greninja ex 021 128', categoryId: 3, groupId: 24722,
    extendedData: [{ name: 'Number', value: '021/128' }],
  };
  const greninja = { ...charizardEn, entity_id: 'greninja-30th-en', name: 'Greninja ex', collector_number_normalized: '21', set_name: '30th Celebration', set_code: '30th' };
  const other = { ...greninja, entity_id: 'greninja-other', set_name: 'Twilight Masquerade', set_code: 'sv06' };
  const decision = decideTcgcsvEnrichment(normalizeTcgcsvProduct(group, product), [greninja, other]);
  assert.equal(decision.status, 'AUTO_MATCH');
  assert.equal(decision.matches[0]?.entity_id, 'greninja-30th-en');
  const wrongName = decideTcgcsvEnrichment(normalizeTcgcsvProduct(group, { ...product, name: 'Frogadier - 021/128', cleanName: 'Frogadier 021 128' }), [greninja]);
  assert.notEqual(wrongName.status, 'AUTO_MATCH', 'the name must still agree');
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

import { collectorNumberMatchKeyV1 } from '../src/index.js';

test('collector-number match key is zero-padding insensitive across providers (v0.3.1)', () => {
  assert.equal(collectorNumberMatchKeyV1('033'), collectorNumberMatchKeyV1('33'));
  assert.equal(collectorNumberMatchKeyV1('TG05'), 'tg5');
  assert.equal(collectorNumberMatchKeyV1('100'), '100');
  assert.equal(collectorNumberMatchKeyV1('0'), '0');
  assert.equal(collectorNumberMatchKeyV1('SV-P 012'), 'sv-p12');
  assert.notEqual(collectorNumberMatchKeyV1('33'), collectorNumberMatchKeyV1('133'));
  const product = normalizeTcgcsvProduct({ groupId: 2, name: 'SWSH02: Rebel Clash', abbreviation: 'RCL', categoryId: 3 },
    { productId: 9, name: 'Chandelure', cleanName: 'Chandelure', categoryId: 3, groupId: 2, extendedData: [{ name: 'Number', value: '033/192' }] });
  const decision = decideTcgcsvEnrichment(product, [{ entity_id: 'e', name: 'Chandelure', collector_number_normalized: '33', language_code: 'en', set_name: 'Rebel Clash', set_code: 'swsh2' }]);
  assert.equal(decision.status, 'AUTO_MATCH');
});

test('name + number without set/group agreement never auto-maps a marketplace product (v0.3.1)', () => {
  const product = normalizeTcgcsvProduct({ groupId: 24831, name: 'ME06: Delta Reign', abbreviation: 'DLR', categoryId: 3 },
    { productId: 77, name: 'Pikachu', cleanName: 'Pikachu', categoryId: 3, groupId: 24831, extendedData: [{ name: 'Number', value: '025/120' }] });
  const decision = decideTcgcsvEnrichment(product, [{ entity_id: 'old', name: 'Pikachu', collector_number_normalized: '25', language_code: 'en', set_name: 'Some Older Set', set_code: 'old1' }]);
  assert.equal(decision.status, 'CANDIDATE_MATCH');
  assert.equal(decision.ruleId, 'TCGCSV_NUMBER_NAME_LANGUAGE_UNIQUE_NO_SET_AGREEMENT');
});
