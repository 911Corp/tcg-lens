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
  const jaScript = { latinConf: 31, jaConf: 20, latinStrong: 0, jaStrong: 3, jaText: 'トロピウスたねワザを使うとき' };
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
