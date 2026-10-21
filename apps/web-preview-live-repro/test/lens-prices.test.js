import test from 'node:test';
import assert from 'node:assert/strict';
import { marketFromCanonical } from '../api/card.js';
import { lockedSheetModel } from '../lens/MarketOverlay.js';

test('canonical Cardmarket price: trend first, then 7-day average', () => {
  assert.equal(marketFromCanonical({ cm: [12.5, 11, 13, 14, 9] }).market.center, 12.5);
  const m = marketFromCanonical({ cm: [null, 18, 18.53, 20.43, 11], tp: { Holofoil: 18.88 } }).market;
  assert.equal(m.center, 18.53); assert.equal(m.currency, 'EUR'); assert.equal(m.source, 'Cardmarket');
});

test('TCGplayer only: several finishes → lowest, flagged "from"', () => {
  const m = marketFromCanonical({ tp: { '1st Edition': 7, Unlimited: 4 } }).market;
  assert.equal(m.center, 4); assert.equal(m.from, true); assert.equal(m.currency, 'USD');
  assert.equal(marketFromCanonical({ tp: { Normal: 0.49 } }).market.from, false);
  assert.equal(marketFromCanonical({}), null);
});

test('sheet: "dès" unless the finish is proven; price language shown while the language is unverified', () => {
  const card = { market: { center: 4, currency: 'USD', source: 'TCGplayer', from: true }, priceLang: 'en' };
  const unverified = lockedSheetModel({ id: 'x', name: 'Charizard', languageUnverified: true, languageCandidates: ['fr', 'en'] }, card);
  assert.match(unverified.price, /^dès /); assert.equal(unverified.priceSource, 'TCGplayer (EN)'); assert.equal(unverified.name, 'Charizard');
  const proven = lockedSheetModel({ id: 'x', name: 'Charizard', lang: 'en', variantProven: true }, card);
  assert.doesNotMatch(proven.price, /dès/); assert.equal(proven.priceSource, 'TCGplayer');
});

test('preferred market follows the app language', () => {
  const e = { cm: [12.5, 11, 13, 14, 9], tp: { Holofoil: 15.2 } };
  assert.equal(marketFromCanonical(e, null, 'eu').market.source, 'Cardmarket');
  const us = marketFromCanonical(e, null, 'us');
  assert.equal(us.market.source, 'TCGplayer'); assert.equal(us.market.center, 15.2);
  assert.equal(us.pricing.cardmarket.trend, 12.5, 'Cardmarket momentum still feeds Heat');
  assert.equal(marketFromCanonical({ cm: [12.5] }, null, 'us').market.source, 'Cardmarket', 'falls back when TCGplayer has no price');
});

test('v0.4.4: a price taken from another language is shown as an estimate', () => {
  const card = { market: { center: 0.71, currency: 'USD', source: 'TCGplayer', estimated: true, estimatedFrom: 'en' }, priceLang: 'en', priceEstimated: true };
  const m = lockedSheetModel({ id: '30th-038', name: 'Pikachu', lang: 'fr' }, card);
  assert.equal(m.estimated, true); assert.match(m.price, /^≈ /); assert.match(m.priceSource, /^Estimation · TCGplayer \(EN\)$/);
});
