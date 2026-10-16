import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTcgdexCanonicalPlan, normalizeTcgdexCard, tcgdexScopedExternalIdentity, type TcgdexCard } from '../src/index.js';

const card: TcgdexCard = {
  id: 'sv3pt5-199',
  localId: '199',
  name: 'Charizard ex',
  rarity: 'Special illustration rare',
  illustrator: 'AKIRA EGAWA',
  image: 'https://assets.tcgdex.net/en/sv/sv3pt5/199',
  set: { id: 'sv3pt5', name: '151', cardCount: { official: 165, total: 207 } }
};

test('TCGdex canonical plan is deterministic', () => {
  const normalized = normalizeTcgdexCard('en', card);
  const a = buildTcgdexCanonicalPlan(normalized);
  const b = buildTcgdexCanonicalPlan(normalized);
  assert.deepEqual(a, b);
  assert.equal(a.set.canonicalKey, 'set:en:sv3pt5');
  assert.equal(a.cardCanonicalKey, 'card:en:sv3pt5:199:base');
  assert.equal(a.set.printedCardCount, 165);
  assert.equal(a.set.totalCardCount, 207);
  assert.equal(a.fingerprints.length, 2);
});

test('localized TCGdex external identities do not collide', () => {
  const en = tcgdexScopedExternalIdentity('en', 'cards', 'sv3pt5-199');
  const fr = tcgdexScopedExternalIdentity('fr', 'cards', 'sv3pt5-199');
  const ja = tcgdexScopedExternalIdentity('ja', 'cards', 'sv3pt5-199');
  assert.notEqual(en, fr);
  assert.notEqual(fr, ja);
  assert.notEqual(en, ja);
});

test('localized cards produce distinct canonical keys', () => {
  const en = buildTcgdexCanonicalPlan(normalizeTcgdexCard('en', card));
  const fr = buildTcgdexCanonicalPlan(normalizeTcgdexCard('fr', { ...card, name: 'Dracaufeu-ex' }));
  assert.notEqual(en.set.canonicalKey, fr.set.canonicalKey);
  assert.notEqual(en.cardCanonicalKey, fr.cardCanonicalKey);
});

test('promotion refuses records without a resolvable set', () => {
  const normalized = normalizeTcgdexCard('ja', { id: 'x-1', localId: '001', name: 'テスト' });
  assert.throws(() => buildTcgdexCanonicalPlan(normalized), /without set id\/name/);
});
