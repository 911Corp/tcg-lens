import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepIndex } from '../lens/DeepIndex.js';

function synthetic(withWasm) {
  globalThis.__TCG_LENS_NO_WASM = !withWasm;
  const ix = new DeepIndex({ fetchImpl: async () => ({ ok: false }) });
  delete globalThis.__TCG_LENS_NO_WASM;
  const D = 128, n = 500;
  ix.meta = { dims: D }; let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const vec = Int8Array.from({ length: n * D }, () => Math.round(rnd() * 127));
  const fam = Int32Array.from({ length: n }, (_, i) => i % 200);
  ix.famIds = Array.from({ length: 200 }, (_, i) => `f${i}`); ix.famLangs = ix.famIds.map(() => ['fr']);
  ix.langs.set('fr', { vec, n, fam, slot: ix.dot ? ix.dot.add(vec, n) : null });
  const q = Float32Array.from({ length: D }, () => rnd() / 6);
  return { ix, q };
}

test('SIMD scores equal the JS loop', () => {
  const a = synthetic(true), b = synthetic(false);
  assert.ok(a.ix.dot, 'WebAssembly SIMD available in Node');
  assert.equal(b.ix.dot, null);
  const sa = a.ix.familyScores(a.q, ['fr']), sb = b.ix.familyScores(b.q, ['fr']);
  for (let f = 0; f < sa.length; f++) assert.ok(Math.abs(sa[f] - sb[f]) < 1e-4, `family ${f}: ${sa[f]} vs ${sb[f]}`);
  assert.deepEqual(a.ix.search(a.q, ['fr'], 5).map(x => x.id), b.ix.search(b.q, ['fr'], 5).map(x => x.id));
});
