import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepIndex, DEEP_SCHEMA } from '../lens/DeepIndex.js';
import { EvidenceFusion } from '../lens/EvidenceFusion.js';
import { DEFAULT_POLICY, CALIBRATED_POLICY } from '../lens/config.js';

function fakeDeep() {
  // 3 inputs dims (2 deep + 1 fast), identity-like projection to 2 dims.
  const meta = { schema: DEEP_SCHEMA, deepDims: 2, fastDims: 1, inDims: 3, dims: 2, fastWeight: 0.5, calibration: { twinTau: 0.8 } };
  const model = new Float32Array([0, 0, 0, /* M 3x2 */ 1, 0, 0, 1, 0, 0]);
  const rows = { fr: [['a'], ['b'], ['c']], ja: [['j']] };
  const vec = { fr: new Int8Array([127, 0, 0, 127, 120, 40]), ja: new Int8Array([126, 10]) };
  const fetchImpl = async url => {
    if (url.endsWith('deep-index.json')) return { ok: true, json: async () => meta };
    if (url.endsWith('deep-model.bin.gz')) return { ok: true, arrayBuffer: async () => model.buffer };
    const lang = url.match(/deep-index-(\w+)\.bin/)[1];
    return { ok: true, arrayBuffer: async () => vec[lang].buffer.slice(0) };
  };
  const ix = new DeepIndex({ fetchImpl });
  return { ix, rows };
}

test('calibrated index ranks families and finds artwork twins across languages', async () => {
  const { ix, rows } = fakeDeep();
  for (const l of ['fr', 'ja']) await ix.loadLang(l, { count: rows[l].length, rows: rows[l], col: { id: 0 } });
  const q = ix.project([1, 0], [0]);
  const hits = ix.search(q, ['fr', 'ja'], 4);
  assert.equal(hits[0].id, 'a');
  const tw = ix.twins(hits[0].family, ['fr', 'ja']).map(t => t.id).sort();
  assert.deepEqual(tw, ['c', 'j'], 'c (reprint-like) and j (Japanese version) share the artwork; b does not');
});

const P = { ...DEFAULT_POLICY, ...CALIBRATED_POLICY };
const T = (score, margin, votes = 2, quality = 0.8) => ({ top: { candidateId: 'x', votes, avgScore: score, avgMargin: margin, avgQuality: quality } });
const V = extra => ({ candidateId: 'x', score: 0.9, margin: 0.2, embeddingVerified: true, calibrated: true, twinFree: true, languages: ['fr', 'en'], resolvedLang: null, ...extra });

test('instant calibrated lock: twin-free, calibrated bars, two frames, language shown unverified', () => {
  const f = new EvidenceFusion(P);
  const d = f.evaluate({ temporal: T(0.86, 0.12), visual: V() });
  assert.equal(d.decision, 'LOCK'); assert.equal(d.reason, 'instant_calibrated_visual'); assert.equal(d.languageUnverified, true);
  assert.notEqual(f.evaluate({ temporal: T(0.86, 0.12, 1), visual: V() }).decision, 'LOCK', 'one frame is not enough');
  assert.notEqual(f.evaluate({ temporal: T(0.78, 0.12), visual: V() }).decision, 'LOCK', 'score bar');
  assert.notEqual(f.evaluate({ temporal: T(0.86, 0.04), visual: V() }).decision, 'LOCK', 'non-twin margin bar');
  assert.notEqual(new EvidenceFusion(DEFAULT_POLICY).evaluate({ temporal: T(0.86, 0.12), visual: V() }).reason, 'instant_calibrated_visual', 'only with the calibrated policy');
});

test('artwork twins never lock instantly; a foreign language read blocks; lock-blocked stays blocked', () => {
  const f = new EvidenceFusion(P);
  assert.equal(f.evaluate({ temporal: T(0.9, 0.2), visual: V({ twinFree: false }) }).reason, 'artwork_twins');
  assert.equal(f.evaluate({ temporal: T(0.9, 0.2), visual: V({ languageOutside: true }) }).decision, 'VERIFY');
  assert.equal(f.evaluate({ temporal: T(0.9, 0.2), visual: V({ lockBlockedReason: 'UNINDEXED_ARTWORK_TWIN' }) }).decision, 'AMBIGUOUS');
  assert.notEqual(f.evaluate({ temporal: T(0.9, 0.2), visual: V(), ocr: { candidateId: null, contradiction: true } }).decision, 'LOCK');
  const proven = f.evaluate({ temporal: T(0.9, 0.2), visual: V({ resolvedLang: 'fr' }) });
  assert.equal(proven.decision, 'LOCK'); assert.equal(proven.languageUnverified, undefined);
});

test('twins printing the same number never lock on printed evidence', () => {
  const f = new EvidenceFusion(P);
  const ocr = { candidateId: 'x', collectorExact: true, strongNameMatch: true, contradiction: false };
  const same = f.evaluate({ temporal: T(0.9, 0.2, 5), visual: V({ twinFree: false, twinNumberDistinct: false }), ocr });
  assert.equal(same.decision, 'AMBIGUOUS'); assert.equal(same.reason, 'artwork_twins_same_number');
  const distinct = f.evaluate({ temporal: T(0.9, 0.2, 5), visual: V({ twinFree: false, twinNumberDistinct: true, resolvedLang: 'fr' }), ocr });
  assert.equal(distinct.decision, 'LOCK', 'a printed number unique among the twins does separate them');
});
