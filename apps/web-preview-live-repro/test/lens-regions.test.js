import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RegionIndex } from '../lens/RegionIndex.js';

const meta = JSON.parse(fs.readFileSync(new URL('../data/region-index.json', import.meta.url), 'utf8'));

test('region model shipped with passing gates', () => {
  const c = meta.calibration;
  assert.equal(meta.schema, 'tcg-lens-region-index-v1');
  assert.equal(c.twinWrongAtMargin, 0);
  assert.ok(c.twinMargin > 0 && c.twinAgreeMargin > 0 && c.twinAgreeRequired >= 3);
  assert.equal(c.scriptMode, 'confirm-only');
  assert.ok(c.scriptWrongAtThreshold <= Math.floor(c.scriptCases / 5000));
});

test('edition decision needs the whole twin group and the calibrated margin', () => {
  const r = new RegionIndex({ fetchImpl: async () => ({ ok: false }) });
  r.meta = { calibration: { twinMargin: 0.13, scriptThreshold: 0.9995 } };
  const D = 4, v = a => Int8Array.from(a.map(x => Math.round(x * 127)));
  r.byLangRow.set('en:1', v([1, 0, 0, 0])); r.byLangRow.set('ja:7', v([0.8, 0.6, 0, 0]));
  const q = Float32Array.from([1, 0, 0, 0]);
  const d = r.decide(q, [{ id: 'A', rows: [['en', 1]] }, { id: 'B', rows: [['ja', 7]] }]);
  assert.equal(d.id, 'A'); assert.ok(Math.abs(d.margin - 0.2) < 0.01); assert.equal(d.decided, true);
  const missing = r.decide(q, [{ id: 'A', rows: [['en', 1]] }, { id: 'B', rows: [['ja', 7]] }, { id: 'C', rows: [['fr', 99]] }]);
  assert.equal(missing.decided, false, 'a twin without zone reference blocks the decision');
  const close = r.decide(Float32Array.from([0.95, 0.31, 0, 0]), [{ id: 'A', rows: [['en', 1]] }, { id: 'B', rows: [['ja', 7]] }]);
  assert.equal(close.decided, false);
});
