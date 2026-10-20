// v0.3.8 — card-level proof for Japanese TCGdex ↔ TCGplayer Japan pairs.
//   DATABASE_URL=unused npx tsx --test apps/ingestion/test/tcgplayer-gap-ja.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';
const { checkJaPair, SUBTYPE_VARIANTS } = await import('../src/tcgplayer-gap-import.js');

const species = new Map<number, Set<string>>([[6, new Set(['charizard'])], [669, new Set(['flabebe'])], [122, new Set(['mr', 'mime'])]]);
const product = (name: string, ext: Record<string, string> = {}) => ({ productId: 1, name, extendedData: Object.entries(ext).map(([name, value]) => ({ name, value })) }) as any;

test('Pokémon pair needs the species name and agreeing HP', () => {
  const card = { category: 'Pokemon', dexId: [6], hp: 330 };
  assert.equal(checkJaPair(card, product('Charizard ex - 201/165', { HP: '330' }), species), 'POKEMON_OK');
  assert.equal(checkJaPair(card, product('Blastoise ex - 201/165', { HP: '330' }), species), 'REJECT');
  assert.equal(checkJaPair(card, product('Charizard ex - 201/165', { HP: '180' }), species), 'REJECT');
});

test('accents and multi-word species match', () => {
  assert.equal(checkJaPair({ category: 'Pokemon', dexId: [669], hp: 40 }, product('Flabébé'), species), 'POKEMON_OK');
  assert.equal(checkJaPair({ category: 'Pokemon', dexId: [122], hp: 80 }, product('Mr. Mime'), species), 'POKEMON_OK');
});

test('unknown species is never accepted', () => {
  assert.equal(checkJaPair({ category: 'Pokemon', dexId: [9999], hp: 60 }, product('Newmon'), species), 'UNPROVEN');
  assert.equal(checkJaPair({ category: 'Pokemon', hp: 60 }, product('Pikachu'), species), 'UNPROVEN');
});

test('a trainer cannot pair with a TCGplayer Pokémon product', () => {
  assert.equal(checkJaPair({ category: 'Trainer' }, product("Boss's Orders"), species), 'TRAINER_OK');
  assert.equal(checkJaPair({ category: 'Trainer' }, product('Antique Jaw Fossil', { HP: '60' }), species), 'REJECT');
});

test('TCGplayer sub-types map to the TCGdex variant codes', () => {
  assert.equal(SUBTYPE_VARIANTS['Reverse Holofoil'].code, 'reverse');
  assert.equal(SUBTYPE_VARIANTS['1st Edition Holofoil'].edition, '1ST_EDITION');
  assert.equal(SUBTYPE_VARIANTS['Unlimited'].code, 'normal');
});
