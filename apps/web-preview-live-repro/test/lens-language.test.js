import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCardLanguage, LanguageConsensus } from '../lens/LanguageEvidence.js';
import { EvidenceFusion } from '../lens/EvidenceFusion.js';
import { PrecomputedIndex, INDEX_SCHEMA } from '../lens/PrecomputedIndex.js';
import { scopeLangs } from '../lens/ANNIndex.js';

const family = {
  id: 'sv01-001', languages: ['fr', 'en'],
  byLang: { fr: { name: 'Noeunoeuf', lang: 'fr' }, en: { name: 'Exeggcute', lang: 'en' } },
};

test('printed cues and language-specific names identify the card language', () => {
  assert.equal(detectCardLanguage('Noeunoeuf PV 60 De base Faiblesse Retraite', family).lang, 'fr');
  assert.equal(detectCardLanguage('Basic Exeggcute HP 60 Weakness Retreat', family).lang, 'en');
  assert.equal(detectCardLanguage('Exeggcute 001/084', family).lang, 'en', 'name alone is a cue');
  assert.equal(detectCardLanguage('001/084', family).lang, null, 'no text cue -> no guess');
  assert.equal(detectCardLanguage('PV 60 HP', family).lang, null, 'tie -> no guess');
  assert.equal(detectCardLanguage('タマタマ たね HP60', { languages: ['ja', 'en'] }).lang, 'ja');
});

test('Japanese is detected from the parallel Japanese read, even when the visual match is Latin-only', () => {
  const latinOnly = { languages: ['en'], byLang: { en: { name: 'Tropius' } } };
  const jaScript = { latinConf: 31, jaConf: 20, latinStrong: 0, jaStrong: 3, jaText: 'トロピウスたねワザを使うとき', jaWords: [['トロピウス', 88], ['たね', 85], ['ワザを使うとき', 80]] };
  assert.equal(detectCardLanguage('~ ES TR 110 ~', latinOnly, jaScript).lang, 'ja');
  const latinScript = { latinConf: 40, jaConf: 38, latinStrong: 18, jaStrong: 2, jaText: 'にデーへ三ニニTropiuswm11Oる今ペーンラ、和きみ時へさくい' };
  assert.equal(detectCardLanguage('Basic Tropius HP 110', latinOnly, latinScript).lang, 'en', 'Latin card: Japanese reader noise is ignored');
  const jaFamily = { languages: ['ja'], byLang: { ja: { name: 'トロピウス' } } };
  assert.equal(detectCardLanguage('', jaFamily, { latinConf: 50, jaConf: 55, latinStrong: 0, jaStrong: 0, jaText: 'トロピウス' }).nameHit, 'ja');
  assert.equal(detectCardLanguage('Basic Tropius HP 110', latinOnly, { latinStrong: 1, jaStrong: 0, jaText: '' }).lang, null, 'unreadable Latin text: no cue counted');
});

test('a single-language printing is contradicted by two reads of another language', () => {
  const lc = new LanguageConsensus();
  lc.observe('me05-001', 'en', ['en']);
  lc.observe('me05-001', 'ja', ['en']);
  assert.equal(lc.resolved('me05-001', ['en']), 'en', 'one noisy read does not block');
  lc.observe('me05-001', 'ja', ['en']);
  assert.equal(lc.contradicted('me05-001', ['en']), 'ja');
  assert.equal(lc.resolved('me05-001', ['en']), null);
  const fusion = new EvidenceFusion();
  const temporal = { top: { candidateId: 'me05-001', votes: 7, avgScore: 0.98, avgMargin: 0.2, avgQuality: 0.8 } };
  const visual = { candidateId: 'me05-001', score: 0.98, margin: 0.2, embeddingVerified: true, visualOnlyLockAllowed: true, languages: ['en'], resolvedLang: null, languageContradiction: 'ja' };
  assert.equal(fusion.evaluate({ temporal, visual }).reason, 'language_contradiction:ja');
});

test('a shared name across languages is not language evidence', () => {
  const shared = { languages: ['fr', 'en'], byLang: { fr: { name: 'Pikachu' }, en: { name: 'Pikachu' } } };
  assert.equal(detectCardLanguage('Pikachu 025/165', shared).lang, null);
});

test('language consensus needs two agreeing reads and no disagreement', () => {
  const lc = new LanguageConsensus();
  assert.equal(lc.resolved('x', ['ja']), null, 'auto scan: a single-language printing still needs one read');
  assert.equal(new LanguageConsensus({ singleLanguageReads: 0 }).resolved('x', ['ja']), 'ja', 'fixed scan language: no read needed');
  assert.equal(lc.observe('x', 'fr'), null);
  assert.equal(lc.observe('x', null), null, 'an empty read does not count');
  assert.equal(lc.observe('x', 'fr'), 'fr');
  lc.observe('x', 'en');
  assert.equal(lc.resolved('x', ['fr', 'en']), null, 'any disagreeing read keeps it unresolved');
  assert.equal(lc.resolved('y', ['fr', 'en']), null);
  lc.observe('x', 'fr');
  assert.equal(lc.resolved('x', ['fr', 'en']), 'fr', '3 FR vs 1 EN: one stray misread no longer blocks');
  lc.observe('x', 'en');
  assert.equal(lc.resolved('x', ['fr', 'en']), null, '3 FR vs 2 EN: disagreement blocks again');
});

test('v0.4.3: French rules text is read as French, English as English, Japanese noise as neither', () => {
  const fr = "Pikachu 60 adversaire. (N'appliquez ni la Faiblesse ni la Résistance aux Pokémon de Banc.) Faiblesse x2 Résistance Retraite Ce Pokémon a de petites poches pleines d'électricité sur les joues. 038/128";
  const r = detectCardLanguage(fr, { languages: ['fr', 'en'] }, { latinStrong: 4, jaStrong: 0, jaText: '' });
  assert.equal(r.lang, 'fr'); assert.equal(r.strong, true, 'one clear French read counts as two');
  const en = "Pikachu 60 HP This attack does 20 damage to 1 of your opponent's Pokémon. (Don't apply Weakness and Resistance for Benched Pokémon.)";
  const e = detectCardLanguage(en, { languages: ['fr', 'en'] }, { latinStrong: 9, jaStrong: 0, jaText: '' });
  assert.equal(e.lang, 'en'); assert.equal(e.strong, true);
  assert.equal(detectCardLanguage('Pokémon Pokémon HP 60', { languages: ['fr', 'en'] }).lang, null, 'Pokémon is printed in both languages');
  assert.equal(detectCardLanguage('ee les a — re ox Co de', {}, { latinStrong: 0, jaStrong: 0, jaText: '' }).lang, null, 'unreadable: short words are not counted');
  assert.equal(detectCardLanguage('HP 60 ~~ = = ae', {}, { latinStrong: 0, jaStrong: 0, jaText: '' }).lang, null, 'Japanese cards print HP');
});

test('fusion never locks a multi-language family before its language is proven', () => {
  const fusion = new EvidenceFusion();
  const temporal = { top: { candidateId: 'sv01-001', votes: 7, avgScore: 0.98, avgMargin: 0.2, avgQuality: 0.8 } };
  const visual = { candidateId: 'sv01-001', score: 0.98, margin: 0.2, embeddingVerified: true, visualOnlyLockAllowed: true, languages: ['fr', 'en'], resolvedLang: null };
  const held = fusion.evaluate({ temporal, visual });
  assert.equal(held.decision, 'VERIFY');
  assert.equal(held.reason, 'language_unresolved');
  assert.equal(fusion.evaluate({ temporal, visual: { ...visual, resolvedLang: 'fr' } }).decision, 'LOCK');
  assert.equal(fusion.evaluate({ temporal, visual: { ...visual, languages: ['ja'], resolvedLang: 'ja' } }).decision, 'LOCK');
});

function fakeIndex() {
  const dims = 2;
  const files = {
    fr: { rows: [['a', 'Noeunoeuf', '1', 84, 's', 'S', null, null, 'fr/a.webp', 1, null, 'e1'], ['b', 'Bulbizarre', '2', 84, 's', 'S', null, null, 'fr/b.webp', 1, null, 'e2']], vec: [127, 0, 0, 127] },
    en: { rows: [['a', 'Exeggcute', '1', 84, 's', 'S', null, null, 'en/a.webp', 0, null, 'e3']], vec: [120, 40] },
  };
  const columns = ['id', 'name', 'localId', 'printedTotal', 'setId', 'setName', 'setAbbreviation', 'releaseDate', 'imagePath', 'visualOnlyLockAllowed', 'lockBlockedReason', 'entityId'];
  const fetchImpl = async url => {
    const [, lang, ext] = url.match(/visual-index-(\w+)\.(json|bin)$/);
    const f = files[lang];
    if (ext === 'json') return { ok: true, json: async () => ({ schema: INDEX_SCHEMA, lang, dims, count: f.rows.length, imageBase: 'https://x/', columns, rows: f.rows }) };
    return { ok: true, arrayBuffer: async () => new Int8Array(f.vec).buffer };
  };
  return new PrecomputedIndex({ fetchImpl });
}

test('precomputed index groups identical artwork across languages into one family', async () => {
  const pre = fakeIndex();
  await pre.load(['fr', 'en']);
  const top = pre.fastTop([1, 0], ['fr', 'en'], 5);
  assert.deepEqual(top.map(h => h.id), ['a', 'b'], 'one entry per family, FR and EN never split the margin');
  const cand = pre.familyCandidate(top[0], ['fr', 'en']);
  assert.deepEqual(cand.languages, ['fr', 'en']);
  assert.equal(cand.byLang.en.name, 'Exeggcute');
  assert.equal(cand.visualOnlyLockAllowed, false, 'conservative until the language is proven');
  assert.deepEqual(scopeLangs('auto'), ['fr', 'en', 'ja']);
  assert.deepEqual(scopeLangs('en'), ['en']);
});

test('an exact printed number consensus lowers only the visual score bar, never the margin', () => {
  const fusion = new EvidenceFusion();
  const ocr = { candidateId: 'me05-001', collectorExact: true, strongNameMatch: true, contradiction: false };
  const visual = { candidateId: 'me05-001', score: 0.93, margin: 0.07, embeddingVerified: true, visualOnlyLockAllowed: true, languages: ['fr'], resolvedLang: 'fr' };
  const temporal = s => ({ top: { candidateId: 'me05-001', votes: 6, avgScore: s.score, avgMargin: s.margin, avgQuality: 0.9 } });
  assert.equal(fusion.evaluate({ temporal: temporal({ score: 0.93, margin: 0.07 }), visual, ocr }).decision, 'LOCK');
  assert.notEqual(fusion.evaluate({ temporal: temporal({ score: 0.93, margin: 0.07 }), visual }).decision, 'LOCK', 'no printing proof');
  assert.notEqual(fusion.evaluate({ temporal: temporal({ score: 0.93, margin: 0.03 }), visual, ocr }).decision, 'LOCK', 'margin bar unchanged');
  assert.notEqual(fusion.evaluate({ temporal: temporal({ score: 0.88, margin: 0.07 }), visual, ocr }).decision, 'LOCK');
});

test('one read with four or more markers of a single language counts as two', () => {
  const r = detectCardLanguage('Base Tropius PV 110 Regardez les cartes de votre deck avec votre main Faiblesse Retraite', { languages: ['fr', 'en'] });
  assert.equal(r.lang, 'fr'); assert.equal(r.strong, true);
  const lc = new LanguageConsensus();
  assert.equal(lc.observe('me05-001', 'fr', ['fr', 'en'], true), 'fr');
  const weak = detectCardLanguage('PV 110 Faiblesse', { languages: ['fr', 'en'] });
  assert.equal(weak.strong, false);
  lc.observe('me05-001', 'en', ['fr', 'en']);
  assert.equal(lc.resolved('me05-001', ['fr', 'en']), null, 'a disagreeing read still blocks');
});

import { plausibleCollector } from '../lens/OCRAdapter.js';
test('digits-only collector reads are kept only when they look like a printed number/total', () => {
  for (const ok of ['001/084', '0001/084', '199/165', '25/102', '230/198']) assert.equal(plausibleCollector(ok), true, ok);
  for (const bad of ['0071/0840', '2', '20', '001/0840', '000/084', '400/084', '']) assert.equal(plausibleCollector(bad), false, bad);
});

test('printed name + clear visual margin locks only in visually complete sets', () => {
  const fusion = new EvidenceFusion();
  const temporal = { top: { candidateId: 'x', votes: 5, avgScore: 0.92, avgMargin: 0.07, avgQuality: 0.8 } };
  const ocr = { candidateId: 'x', collectorExact: false, strongNameMatch: true, contradiction: false };
  const base = { candidateId: 'x', score: 0.92, margin: 0.07, embeddingVerified: true, languages: ['fr'], resolvedLang: 'fr' };
  const locked = fusion.evaluate({ temporal, visual: { ...base, visualOnlyLockAllowed: true }, ocr });
  assert.equal(locked.decision, 'LOCK'); assert.equal(locked.reason, 'visual_temporal_plus_printed_name');
  assert.notEqual(fusion.evaluate({ temporal, visual: { ...base, visualOnlyLockAllowed: false }, ocr }).decision, 'LOCK', 'set not visually complete');
  assert.notEqual(fusion.evaluate({ temporal: { top: { ...temporal.top, avgMargin: 0.04 } }, visual: { ...base, visualOnlyLockAllowed: true }, ocr }).decision, 'LOCK', 'margin bar unchanged');
});

test('unreadable language: lock after the grace delay with language unverified, never across a foreign read', () => {
  const fusion = new EvidenceFusion();
  const temporal = { top: { candidateId: 'x', votes: 7, avgScore: 0.98, avgMargin: 0.2, avgQuality: 0.8 } };
  const v = { candidateId: 'x', score: 0.98, margin: 0.2, embeddingVerified: true, visualOnlyLockAllowed: true, languages: ['fr', 'en'], resolvedLang: null };
  assert.equal(fusion.evaluate({ temporal, visual: { ...v, languageWaitMs: 1000 } }).reason, 'language_unresolved');
  const late = fusion.evaluate({ temporal, visual: { ...v, languageWaitMs: 2600 } });
  assert.equal(late.decision, 'LOCK'); assert.equal(late.languageUnverified, true);
  assert.equal(fusion.evaluate({ temporal, visual: { ...v, languageWaitMs: 9000, languageOutside: true } }).decision, 'VERIFY', 'a Japanese read blocks the shortcut');
});

import { lockedSheetModel } from '../lens/MarketOverlay.js';
test('an unverified language is shown as such, never guessed', () => {
  const m = lockedSheetModel({ id: 'me05-001', name: 'Tropius', localId: '001', printedTotal: 84, lang: null, languageUnverified: true, languageCandidates: ['fr', 'en'] }, null, 0.95);
  assert.equal(m.language, 'FR/EN ?');
});

test('v0.4.3: kana hallucinated on a holo French card are not Japanese evidence when the Latin name is read', () => {
  const pika = { languages: ['fr', 'en'], byLang: { fr: { name: 'Pikachu' }, en: { name: 'Pikachu' } } };
  const holo = { latinConf: 36, jaConf: 28, latinStrong: 0, jaStrong: 9, jaText: 'ーーPikachu6るO記ーーっ人をそろでとこ近テラ全信三さ居テ電昌レコ放た' };
  assert.equal(detectCardLanguage('pEEE Pikachu ~O0 4 = $B yo ag 128 (N16 30)', pika, holo).lang, null);
  assert.equal(detectCardLanguage('~ ES TR 60 ~', pika, holo).lang, null, 'Latin-only family: noisy kana are below the calibrated bar');
  const jaFamily = { languages: ['ja'], byLang: { ja: { name: 'ピカチュウ' } } };
  assert.equal(detectCardLanguage('~ ES TR 60 ~', jaFamily, holo).lang, 'ja', 'a Japanese family is confirmed with the permissive rule');
});

test('v0.4.3: the Latin name read twice proves a Latin-script card even when FR vs EN is unknown', () => {
  const pika = { languages: ['fr', 'en'], byLang: { fr: { name: 'Pikachu' }, en: { name: 'Pikachu' } } };
  const r = detectCardLanguage('pEEE Pikachu ~O0 4 = $B 128', pika, { latinStrong: 2, jaStrong: 0, jaText: '' });
  assert.equal(r.lang, null); assert.equal(r.script, 'latin');
  const lc = new LanguageConsensus();
  lc.observe('card', r.lang, null, r.strong, r.script);
  assert.equal(lc.scriptResolved('card'), null, 'one read is not enough');
  lc.observe('card', r.lang, null, r.strong, r.script);
  assert.equal(lc.scriptResolved('card'), 'latin');
  assert.equal(detectCardLanguage('~ ES TR 60 ~', pika, { latinStrong: 0, jaStrong: 0, jaText: '' }).script, null);
});

import { collectorCandidates } from '../lens/OCRAdapter.js';
test('v0.4.4: printed numbers are recovered from glued digits-only reads', () => {
  assert.deepEqual(collectorCandidates('35036/12814730'), ['036/128']);
  assert.deepEqual(collectorCandidates('083/2172026/'), ['083/217']);
  assert.deepEqual(collectorCandidates('585071/21762026/'), ['071/217']);
  assert.deepEqual(collectorCandidates('4/102'), ['4/102']);
  assert.deepEqual(collectorCandidates('91403'), []);
});
