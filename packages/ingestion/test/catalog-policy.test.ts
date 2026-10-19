import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTcgdexVariantPlan,
  classifyTcgdexSetMedium,
  computeSetReadiness,
  decidePrintingEligibility,
  releaseStatus,
  type SetCoverageMetrics
} from '../src/index.js';

const complete: SetCoverageMetrics = {
  expectedCards: 10, canonicalPrintings: 10, collectorNumberCovered: 10, variantsCovered: 10,
  imagesListed: 10, imagesProbed: 10, imagesOk: 10, visualIndexEligible: 10,
  cardmarketMapped: 10, tcgplayerMapped: 9, priced: 10, openConflicts: 0, quarantinedRecords: 0
};

test('Pokémon TCG Pocket series is classified digital-only and excluded', () => {
  assert.equal(classifyTcgdexSetMedium({ serie: { id: 'tcgp' } }), 'DIGITAL_ONLY');
  assert.equal(classifyTcgdexSetMedium({ serie: { id: 'me' } }), 'PHYSICAL');
  assert.equal(classifyTcgdexSetMedium(undefined), 'PHYSICAL');
  const r = computeSetReadiness({ metrics: complete, releaseStatus: 'RELEASED', productMedium: 'DIGITAL_ONLY' });
  assert.equal(r.readiness, 'EXCLUDED');
  const e = decidePrintingEligibility({ productMedium: 'DIGITAL_ONLY', releaseStatus: 'RELEASED', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: true, setIdentityVisualReadiness: 'VISUAL_COMPLETE' });
  assert.equal(e.inLivePool, false);
  assert.equal(e.reason, 'DIGITAL_ONLY_PRODUCT');
});

test('release status is derived from an explicit as-of date; upcoming sets are staged', () => {
  assert.equal(releaseStatus('2026-11-06', null, '2026-10-20'), 'UPCOMING');
  assert.equal(releaseStatus('2026-09-16', null, '2026-10-20'), 'RELEASED');
  assert.equal(releaseStatus('2026-10-20', null, '2026-10-20'), 'RELEASED');
  assert.equal(releaseStatus(null, null, '2026-10-20'), 'UNKNOWN');
  assert.equal(releaseStatus('2026-11-06', 'PRERELEASE', '2026-10-20'), 'PRERELEASE');

  const staged = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'UPCOMING', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: true, setIdentityVisualReadiness: 'VISUAL_COMPLETE' });
  assert.equal(staged.indexable, true, 'upcoming sets can be prepared ahead of release');
  assert.equal(staged.inLivePool, false);
  assert.equal(staged.reason, 'STAGED_UPCOMING');
  const prerelease = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'UPCOMING', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: true, setIdentityVisualReadiness: 'VISUAL_COMPLETE', includePrerelease: true });
  assert.equal(prerelease.inLivePool, true, 'explicit prerelease mode may include staged sets');
  assert.equal(prerelease.visualOnlyLockAllowed, false, 'never visual-only lock on unreleased sets');

  const r = computeSetReadiness({ metrics: complete, releaseStatus: 'UPCOMING', productMedium: 'PHYSICAL' });
  assert.equal(r.readiness, 'MARKET_READY');
  assert.ok(r.blockers.includes('RELEASE_STATUS:UPCOMING'));
});

test('complete released set reaches LENS_READY', () => {
  const r = computeSetReadiness({ metrics: complete, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' });
  assert.equal(r.readiness, 'LENS_READY');
  assert.equal(r.identityVisualReadiness, 'VISUAL_COMPLETE');
  assert.deepEqual(r.blockers, []);
});

test('a set missing reference images never reaches VISUAL_COMPLETE or LENS_READY (30th-c case)', () => {
  const metrics = { ...complete, expectedCards: 30, canonicalPrintings: 30, collectorNumberCovered: 30, variantsCovered: 30, imagesListed: 0, imagesProbed: 0, imagesOk: 0, visualIndexEligible: 0, cardmarketMapped: 30, tcgplayerMapped: 30, priced: 30 };
  const r = computeSetReadiness({ metrics, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' });
  assert.equal(r.readiness, 'IDENTITY_COMPLETE');
  assert.ok(r.blockers.includes('MISSING_OR_BROKEN_IMAGES:30'));
  const oneMissing = computeSetReadiness({ metrics: { ...complete, imagesOk: 9, visualIndexEligible: 9 }, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' });
  assert.equal(oneMissing.readiness, 'IDENTITY_COMPLETE', 'a single missing reference blocks VISUAL_COMPLETE under default policy');
});

test('identity completeness requires expected count, collector numbers and zero open conflicts', () => {
  assert.equal(computeSetReadiness({ metrics: { ...complete, canonicalPrintings: 9, collectorNumberCovered: 9 }, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' }).readiness, 'CATALOGUED');
  assert.equal(computeSetReadiness({ metrics: { ...complete, openConflicts: 1 }, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' }).readiness, 'CATALOGUED');
  assert.equal(computeSetReadiness({ metrics: { ...complete, expectedCards: null }, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' }).readiness, 'CATALOGUED');
  assert.equal(computeSetReadiness({ metrics: { ...complete, canonicalPrintings: 0 }, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' }).readiness, 'DISCOVERED');
});

test('market coverage never changes candidate-pool membership or visual-only lock permission', () => {
  const noMarket = { ...complete, cardmarketMapped: 0, tcgplayerMapped: 0, priced: 0 };
  const withMarket = computeSetReadiness({ metrics: complete, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' });
  const without = computeSetReadiness({ metrics: noMarket, releaseStatus: 'RELEASED', productMedium: 'PHYSICAL' });
  assert.equal(without.readiness, 'VISUAL_COMPLETE');
  assert.equal(withMarket.identityVisualReadiness, without.identityVisualReadiness);
  const base = { productMedium: 'PHYSICAL' as const, releaseStatus: 'RELEASED' as const, entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: true };
  assert.deepEqual(
    decidePrintingEligibility({ ...base, setIdentityVisualReadiness: withMarket.identityVisualReadiness }),
    decidePrintingEligibility({ ...base, setIdentityVisualReadiness: without.identityVisualReadiness })
  );
});

test('candidates from visually incomplete sets stay in the pool but may not lock visual-only', () => {
  const e = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'RELEASED', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: true, setIdentityVisualReadiness: 'IDENTITY_COMPLETE' });
  assert.equal(e.inLivePool, true);
  assert.equal(e.visualOnlyLockAllowed, false);
  const broken = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'RELEASED', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: false, setIdentityVisualReadiness: 'VISUAL_COMPLETE' });
  assert.equal(broken.inLivePool, false);
  assert.equal(broken.reason, 'IMAGE_MISSING_OR_BROKEN');
  const conflict = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'RELEASED', entityActiveCanonical: true, hasOpenConflict: true, imageProbeOk: true, setIdentityVisualReadiness: 'VISUAL_COMPLETE' });
  assert.equal(conflict.inLivePool, false);
  const unprobed = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'RELEASED', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: null, setIdentityVisualReadiness: 'VISUAL_COMPLETE' });
  assert.equal(unprobed.inLivePool, false, 'an unprobed image is not evidence of a usable reference');
  assert.equal(unprobed.reason, 'IMAGE_NOT_PROBED');
  const none = decidePrintingEligibility({ productMedium: 'PHYSICAL', releaseStatus: 'RELEASED', entityActiveCanonical: true, hasOpenConflict: false, imageProbeOk: null, hasReferenceImage: false, setIdentityVisualReadiness: 'VISUAL_COMPLETE' });
  assert.equal(none.reason, 'NO_REFERENCE_IMAGE');
});

test('TCGdex variant plans are deterministic and normalize casing/localized labels', () => {
  const card = {
    variants: { normal: true, reverse: true, holo: false, firstEdition: false, wPromo: false },
    variants_detailed: [
      { type: 'Normal', size: 'Standard', variantId: 'v1', thirdParty: { cardmarket: 1, tcgplayer: 2 } },
      { type: 'reverse', size: 'Standard', variantId: 'v2' },
      { type: 'Reverse', size: 'Standard', variantId: 'v2-dup' },
      { type: 'Holo', size: 'Standard', stamp: ['1re Édition'], variantId: 'v3' },
      { type: 'Métal', size: 'Jumbo', variantId: 'v4' }
    ]
  };
  const a = buildTcgdexVariantPlan(card);
  const b = buildTcgdexVariantPlan(structuredClone(card));
  assert.deepEqual(a, b);
  assert.deepEqual(a.map(x => x.variantCode), ['holo+stamp-1re-edition', 'metal+jumbo', 'normal', 'reverse']);
  assert.equal(a.find(x => x.variantCode === 'holo+stamp-1re-edition')?.editionMark, '1ST_EDITION');
  assert.equal(a.find(x => x.variantCode === 'metal+jumbo')?.finish, 'METAL');
  assert.equal(a.find(x => x.variantCode === 'normal')?.assertedCardmarketId, 1);
  const flagsOnly = buildTcgdexVariantPlan({ variants: { normal: true, reverse: true, holo: false } });
  assert.deepEqual(flagsOnly.map(x => x.variantCode), ['normal', 'reverse']);
});

import { cardmarketBaseName, decideCardmarketCrosswalk } from '../src/index.js';

test('Cardmarket crosswalk verifies TCGdex-asserted product IDs against the real catalog shape', () => {
  const ctx = { setExpansionMode: 1544, setExpansionModeShare: 0.97, printingsAssertingSameProductInLanguage: 1 };
  const product = { idProduct: 276281, name: 'Charizard ex [Energy Flame | Slash | Burn Down]', idCategory: 51, idExpansion: 1544 };
  assert.equal(cardmarketBaseName(product.name), 'charizard ex');
  assert.equal(cardmarketBaseName('Pikachu (V.2)'), 'pikachu');
  assert.equal(cardmarketBaseName('Drifblim Lv.33 [Ram | Gust]'), 'drifblim');
  assert.equal(cardmarketBaseName('Blaziken [FB] LV.X [Burning Spirit | Jet Shoot]'), 'blaziken [fb] lv.x', 'LV.X is part of the card name');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'e', languageCode: 'en', name: 'Charizard ex' }, product, ctx).status, 'AUTO_MATCH');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'e', languageCode: 'en', name: 'Blastoise ex' }, product, ctx).ruleId, 'CM_XWALK_NAME_MISMATCH');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'e', languageCode: 'en', name: 'Charizard ex' }, undefined, ctx).status, 'CANDIDATE_MATCH');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'e', languageCode: 'en', name: 'Charizard ex' }, { ...product, idCategory: 52 }, ctx).status, 'CONFLICT');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'e', languageCode: 'en', name: 'Charizard ex' }, product, { ...ctx, printingsAssertingSameProductInLanguage: 2 }).status, 'CANDIDATE_MATCH');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'e', languageCode: 'en', name: 'Charizard ex' }, { ...product, idExpansion: 9 }, ctx).ruleId, 'CM_XWALK_EXPANSION_INCONSISTENT');
  // FR/JA: Cardmarket names are English; require the EN sibling (same TCGdex id) to assert the same product.
  assert.equal(decideCardmarketCrosswalk({ entityId: 'f', languageCode: 'fr', name: 'Dracaufeu ex', englishSiblingName: 'Charizard ex', englishSiblingAssertsSameProduct: true }, product, ctx).status, 'AUTO_MATCH');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'f', languageCode: 'fr', name: 'Dracaufeu ex', englishSiblingName: 'Charizard ex', englishSiblingAssertsSameProduct: false }, product, ctx).status, 'CANDIDATE_MATCH');
  assert.equal(decideCardmarketCrosswalk({ entityId: 'f', languageCode: 'fr', name: 'Dracaufeu ex' }, product, ctx).ruleId, 'CM_XWALK_NO_ENGLISH_REFERENCE_NAME');
});
