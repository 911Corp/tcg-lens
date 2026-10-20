import test from 'node:test';
import assert from 'node:assert/strict';
import { addItem, setQty, removeItem, totals, sorted, toCSV, migrate } from '../lens/collectionModel.js';

const charizard = { kind: 'card', id: 'swsh10.5-011', lang: 'en', name: 'Radiant Charizard', setName: 'Pokémon GO', number: '011/078', market: { center: 18.5, currency: 'EUR' } };

test('adding twice increments the quantity; languages stay separate', () => {
  let { list, added } = addItem([], charizard); assert.equal(added, true);
  ({ list, added } = addItem(list, charizard)); assert.equal(added, false); assert.equal(list[0].qty, 2);
  ({ list } = addItem(list, { ...charizard, lang: 'fr' })); assert.equal(list.length, 2);
  ({ list } = addItem(list, { ...charizard, lang: null, languageCandidates: ['fr', 'en'] })); assert.equal(list.length, 3);
});

test('quantity, removal and totals per currency', () => {
  let { list } = addItem([], charizard);
  ({ list } = addItem(list, { kind: 'card', id: 'x', lang: 'ja', name: 'Pikachu', market: { center: 2, currency: 'USD' } }, 3));
  ({ list } = addItem(list, { kind: 'card', id: 'y', lang: 'fr', name: 'Sans prix' }));
  assert.deepEqual(totals(list), { count: 5, priced: 4, byCurrency: { EUR: 18.5, USD: 6 } });
  list = setQty(list, 'card:x:ja', 1); assert.equal(totals(list).byCurrency.USD, 2);
  list = setQty(list, 'card:x:ja', 0); assert.equal(list.length, 2);
  list = removeItem(list, 'card:y:fr'); assert.equal(list.length, 1);
  assert.equal(sorted([...addItem(list, { kind: 'card', id: 'z', lang: 'en', name: 'Abra', market: { center: 1, currency: 'EUR' } }).list], 'value')[0].name, 'Radiant Charizard');
});

test('CSV export (semicolons, French decimals) and migration of old items', () => {
  const { list } = addItem([], charizard, 2);
  const csv = toCSV(list);
  assert.match(csv, /^﻿Nom;Type;Extension/);
  assert.match(csv, /Radiant Charizard;Carte;Pokémon GO;011\/078;EN;2;18,5;EUR;37;/);
  const en = toCSV(list, { lang: 'en' });
  assert.match(en, /^\ufeffName,Type,Set,Number/);
  assert.match(en, /Radiant Charizard,Card,Pokémon GO,011\/078,EN,2,18.5,EUR,37,/);
  const old = migrate([{ key: 'card:abc', kind: 'card', id: 'abc', lang: 'fr', name: 'Old', expansion: 'Base', localId: '4', market: null }]);
  assert.equal(old[0].key, 'card:abc:fr'); assert.equal(old[0].setName, 'Base'); assert.equal(old[0].qty, 1);
});
