import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySealedProduct,
  normalizeCardmarketProduct,
  normalizeCardmarketSealed,
  normalizeTcgcsvProduct,
  normalizeTcgcsvSealed,
  normalizeBarcodeClaim,
  detectBarcodeScheme,
  type TcgcsvGroup,
  type TcgcsvProduct
} from '../src/index.js';

test('Cardmarket non-single ETB becomes a sealed product', () => {
  const product = normalizeCardmarketProduct({
    idProduct: 60001,
    name: 'Pokemon 151 Elite Trainer Box',
    idExpansion: 151,
    expansionName: '151',
    categoryName: 'Elite Trainer Boxes'
  }, 'non_single');
  const sealed = normalizeCardmarketSealed(product);
  assert.ok(sealed);
  assert.equal(sealed?.productType, 'ETB');
  assert.equal(sealed?.normalizedSetHint, '151');
});

test('TCGCSV product without collector number classifies as sealed and cross-source fingerprint aligns', () => {
  const cm = normalizeCardmarketSealed(normalizeCardmarketProduct({
    idProduct: 60001, name: 'Pokemon 151 Elite Trainer Box', expansionName: '151'
  }, 'non_single'))!;
  const group: TcgcsvGroup = { groupId: 151, name: '151', categoryId: 3 };
  const raw: TcgcsvProduct = { productId: 70001, name: 'Pokemon 151 Elite Trainer Box', categoryId: 3, groupId: 151 };
  const tcg = normalizeTcgcsvSealed(normalizeTcgcsvProduct(group, raw));
  assert.ok(tcg);
  assert.equal(tcg?.productType, 'ETB');
  assert.equal(tcg?.languageCode, 'en');
  assert.equal(cm.matchingFingerprint, tcg?.matchingFingerprint);
  assert.notEqual(cm.structuralFingerprint, tcg?.structuralFingerprint); // language is intentionally part of strict identity
});

test('code cards are not treated as sealed retail products', () => {
  assert.equal(classifySealedProduct('151 Elite Trainer Box Code Card'), undefined);
});

test('barcode claims normalize UPC to GTIN-14 and validate checksum', () => {
  const claim = normalizeBarcodeClaim({ rawValue: '036000291452' });
  assert.equal(claim.scheme, 'UPC_A');
  assert.equal(claim.gtin14, '00036000291452');
  assert.equal(claim.checksumValid, true);
});

test('JAN-13 is distinguished from generic EAN-13', () => {
  assert.equal(detectBarcodeScheme('4901234567894'), 'JAN_13');
  assert.equal(detectBarcodeScheme('4006381333931'), 'EAN_13');
});
