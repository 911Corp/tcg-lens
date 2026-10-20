import test from 'node:test';
import assert from 'node:assert/strict';
import { multiDecision, twinFreeByScript } from '../lens/MultiScan.js';

const P = { instantScore: 0.82, instantMargin: 0.12, instantVotes: 2, instantMinQuality: 0.35 };
const ok = { id: 'a', score: 0.93, margin: 0.2, quality: 0.8, calibrated: true, twinFree: true, visualOnlyLockAllowed: true, lockBlockedReason: null };

test('a card is named only after two agreeing instant-grade passes', () => {
  assert.equal(multiDecision([ok], P).state, 'pending');
  assert.equal(multiDecision([ok, ok], P).state, 'identified');
  assert.equal(multiDecision([ok, { ...ok, id: 'b' }], P).state, 'pending');
});

test('twins, incomplete sets, blocked locks and weak matches stay "?"', () => {
  assert.equal(multiDecision([ok, { ...ok, twinFree: false }], P).state, 'ambiguous');
  assert.equal(multiDecision([ok, { ...ok, visualOnlyLockAllowed: false }], P).state, 'ambiguous');
  assert.equal(multiDecision([ok, { ...ok, lockBlockedReason: 'UNINDEXED_ARTWORK_TWIN' }], P).state, 'ambiguous');
  assert.equal(multiDecision([{ ...ok, margin: 0.05 }, { ...ok, margin: 0.06 }], P).state, 'ambiguous');
  assert.equal(multiDecision([{ ...ok, score: 0.7 }, { ...ok, score: 0.75 }], P).state, 'ambiguous');
  assert.equal(multiDecision([{ ...ok, calibrated: false }, { ...ok, calibrated: false }], P).state, 'unknown');
  assert.equal(multiDecision([{ id: null }, { id: null }], P).state, 'unknown');
});

test('twins: only other-script twins with a calibrated script gap are ruled out', () => {
  const pol = { scriptGap: 0.07 };
  assert.equal(twinFreeByScript({ twins: [] }, pol), true);
  const en = { languages: ['fr', 'en'], script: 'latin', scriptGap: 0.12, twins: [{ id: 'sv4a-1', languages: ['ja'] }] };
  assert.equal(twinFreeByScript(en, pol), true);
  assert.equal(twinFreeByScript({ ...en, scriptGap: 0.03 }, pol), false);
  assert.equal(twinFreeByScript({ ...en, twins: [...en.twins, { id: 'promo', languages: ['en'] }] }, pol), false);
  assert.equal(twinFreeByScript({ ...en, script: 'ja' }, pol), false);
});
