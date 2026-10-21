import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { proposalProbabilities, frameProposals, ProposalTracker, stablePrintedRead } from '../lens/Proposals.js';
import { ScanMemory } from '../lens/ScanMemory.js';

const cal = JSON.parse(fs.readFileSync(new URL('../data/deep-index.json', import.meta.url), 'utf8')).calibration.proposals;
const ranked = (...s) => s.map((score, i) => ({ id: `c${i}`, score }));

test('calibration is shipped with the index and passed its gate', () => {
  assert.ok(cal.coef.length === 7 && cal.rightAmongShown >= 0.97);
});

test('probabilities: a clear match is high, an isolated mediocre match is low, a near tie splits', () => {
  const clear = proposalProbabilities([0.95, 0.70, 0.68, 0.66, 0.65, 0.64], cal);
  assert.ok(clear[0] > 0.85 && clear[1] < 0.1);
  const weak = proposalProbabilities([0.62, 0.60, 0.59, 0.58, 0.57, 0.56], cal);
  assert.ok(weak[0] < cal.show, `weak top ${weak[0]}`);
  assert.deepEqual(frameProposals(ranked(0.62, 0.60, 0.59, 0.58, 0.57, 0.56), cal), []);
  const tie = frameProposals(ranked(0.93, 0.925, 0.70, 0.69, 0.68, 0.67), cal);
  assert.ok(tie.length >= 2 && tie[0].id === 'c0' && tie[1].id === 'c1', JSON.stringify(tie));
});

test('needs 3 of the last 4 frames, drops printed contradictions, promotes a number match', () => {
  const cands = [
    { id: 'c0', name: 'A', localId: '4', printedTotal: 102, languages: ['en'], lang: 'en' },
    { id: 'c1', name: 'B', localId: '11', printedTotal: 78, languages: ['en'], lang: 'en' },
  ];
  const t = new ProposalTracker();
  t.observe(ranked(0.93, 0.925, 0.70, 0.69, 0.68, 0.67), cal);
  t.observe(ranked(0.93, 0.925, 0.70, 0.69, 0.68, 0.67), cal);
  assert.deepEqual(t.stable(cands), [], 'two frames are not enough');
  t.observe(ranked(0.93, 0.925, 0.70, 0.69, 0.68, 0.67), cal);
  assert.deepEqual(t.stable(cands).map(x => x.id), ['c0', 'c1']);
  const printed = stablePrintedRead(['11/78 HP', 'xx 11/78']);
  const withNumber = t.stable(cands, { printed });
  assert.deepEqual(withNumber.map(x => x.id), ['c1'], 'c0 contradicted by the printed number');
  assert.equal(withNumber[0].numberMatch, true);
  assert.equal(stablePrintedRead(['11/78']), null, 'one reading is not enough');
  assert.deepEqual(t.stable(cands, { language: 'ja' }), [], 'proven language excludes');
});

test('scan memory: on-device, close descriptors only, proposals only', () => {
  const store = new Map(); const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const m = new ScanMemory(storage);
  const q = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i + 1)); const n = Math.hypot(...q); for (let i = 0; i < q.length; i++) q[i] /= n;
  m.add('S10b-011', q, { languages: ['ja'] });
  assert.equal(new ScanMemory(storage).size, 1, 'persisted');
  assert.equal(m.match(q)[0].id, 'S10b-011');
  const other = Float32Array.from({ length: 128 }, (_, i) => Math.cos(3 * i)); const n2 = Math.hypot(...other); for (let i = 0; i < 128; i++) other[i] /= n2;
  assert.deepEqual(m.match(other), []);
  const t = new ProposalTracker();
  for (let k = 0; k < 3; k++) t.observe([{ id: 'x', score: 0.7 }, { id: 'S10b-011', score: 0.69 }, { id: 'y', score: 0.6 }, { id: 'z', score: 0.59 }, { id: 'w', score: 0.58 }, { id: 'v', score: 0.57 }], cal, m.match(q));
  const st = t.stable([{ id: 'S10b-011', languages: ['ja'] }, { id: 'x', languages: ['en'] }]);
  assert.equal(st[0].id, 'S10b-011'); assert.equal(st[0].remembered, true);
});

test('v0.4.3: a card proven Latin-script is never proposed as its Japanese twin', () => {
  const t = new ProposalTracker();
  const cands = [
    { id: '30th-038', name: 'Pikachu', localId: '038', printedTotal: 128, languages: ['fr', 'en'], lang: 'fr' },
    { id: 'm6a-032', name: 'Pikachu', localId: '032', printedTotal: 103, languages: ['ja'], lang: 'ja' },
  ];
  for (let i = 0; i < 4; i++) t.observe(ranked(0.93, 0.925, 0.70, 0.69, 0.68, 0.67).map((h, k) => ({ ...h, id: cands[k]?.id || h.id })), cal);
  assert.deepEqual(t.stable(cands).map(x => x.id), ['30th-038', 'm6a-032'], 'two choices while the script is unknown');
  assert.deepEqual(t.stable(cands, { script: 'latin' }).map(x => x.id), ['30th-038']);
  assert.ok(!t.stable(cands, { script: 'ja' }).some(x => x.id === '30th-038'), 'and a Japanese card never as its Latin printing');
});
