import assert from 'node:assert/strict';
import test from 'node:test';
import { TcgdexClient, buildTcgdexCanonicalPlan, normalizeTcgdexCard, tcgdexScopedExternalIdentity, type TcgdexCard } from '../src/index.js';

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

test('TCGdex iterateCards yields every card even when the consumer is slow (v0.3.1 data-loss regression)', async () => {
  const ids = Array.from({ length: 50 }, (_, i) => `set-${i + 1}`);
  const fakeFetch = async (url: string) => {
    if (url.endsWith('/en/cards')) return { ok: true, status: 200, json: async () => ids.map((id, i) => ({ id, localId: String(i + 1), name: `Card ${i + 1}` })) };
    const id = decodeURIComponent(url.split('/').pop() as string);
    await new Promise(resolve => setTimeout(resolve, (Number(id.split('-')[1]) % 5) + 1));
    return { ok: true, status: 200, json: async () => ({ id, localId: id.split('-')[1], name: id }) };
  };
  const client = new TcgdexClient('https://tcgdex.test/v2', fakeFetch, { attempts: 1, baseDelayMs: 0 });
  const seen: string[] = [];
  for await (const card of client.iterateCards('en', { concurrency: 6 })) {
    seen.push(card.id);
    await new Promise(resolve => setTimeout(resolve, 8)); // slow consumer, like a DB transaction
  }
  assert.equal(seen.length, 50);
  assert.equal(new Set(seen).size, 50);
});

test('TCGdex iterateCards reports failures without aborting and retries transient errors', async () => {
  const calls = new Map<string, number>();
  const fakeFetch = async (url: string) => {
    if (url.endsWith('/en/cards')) return { ok: true, status: 200, json: async () => [{ id: 'a', localId: '1', name: 'A' }, { id: 'b', localId: '2', name: 'B' }, { id: 'c', localId: '3', name: 'C' }] };
    const id = url.split('/').pop() as string;
    calls.set(id, (calls.get(id) ?? 0) + 1);
    if (id === 'b') return { ok: false, status: 404, json: async () => ({}) };
    if (id === 'c' && calls.get(id) === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id, localId: '1', name: id }) };
  };
  const client = new TcgdexClient('https://tcgdex.test/v2', fakeFetch, { attempts: 3, baseDelayMs: 0 });
  const failures: string[] = [];
  const seen: string[] = [];
  for await (const card of client.iterateCards('en', { onFailure: f => failures.push(f.id) })) seen.push(card.id);
  assert.deepEqual(seen.sort(), ['a', 'c']);
  assert.deepEqual(failures, ['b']);
  assert.equal(calls.get('b'), 1, '404 must not be retried');
  assert.equal(calls.get('c'), 2, '503 must be retried');
});
