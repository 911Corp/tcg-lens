import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, LENS_STATES } from '../lens/config.js';
import { runReplay } from './helpers/replayHarness.js';

function assertNoFalseLocks(events) {
  const locks = events.filter(e => e.type === 'LOCK');
  for (const lock of locks) assert.equal(lock.candidateId, lock.expected, `false lock at ${lock.t}ms`);
  const emptyLocks = locks.filter(e => e.t >= 5067 && e.t < 7067);
  assert.equal(emptyLocks.length, 0, 'must never lock during empty frames');
  const crossIdentity = events.filter(e => e.type === 'FUSION' && ['VERIFY', 'LOCK'].includes(e.decision.decision) && e.temporal?.candidateId && e.decision.candidateId !== e.temporal.candidateId);
  assert.equal(crossIdentity.length, 0, 'VERIFY/LOCK must never cross temporal identities');
  const rejected = events.filter(e => e.type === 'STATE_REJECTED');
  assert.equal(rejected.length, 0, `unexpected illegal state transitions: ${JSON.stringify(rejected)}`);
}

test('A -> empty -> B -> A replay has no false confident identification without OCR corroboration', () => {
  const { events, state, context } = runReplay();
  assertNoFalseLocks(events);
  const locks = events.filter(e => e.type === 'LOCK').map(e => e.candidateId);
  assert.deepEqual(locks, ['test-a', 'test-a']);
  assert.equal(events.some(e => e.type === 'LOCK' && e.candidateId === 'test-b'), false);
  assert.equal(events.some(e => e.type === 'FUSION' && e.decision.reason === 'temporal_visual_mismatch'), true);
  assert.equal(state, LENS_STATES.LOCKED);
  assert.equal(context?.locked?.id, 'test-a');
});

test('A -> empty -> B -> A replay locks B only with corroboration then requires confirmed change back to A', () => {
  const { events, state, context } = runReplay({ corroborateB: true });
  assertNoFalseLocks(events);
  const locks = events.filter(e => e.type === 'LOCK').map(e => e.candidateId);
  assert.deepEqual(locks, ['test-a', 'test-b', 'test-a']);
  const confirmed = events.filter(e => e.type === 'CHANGE_EVIDENCE' && e.action === 'CONFIRMED');
  assert.ok(confirmed.some(e => e.candidateId === 'test-a' && e.votes >= DEFAULT_POLICY.changeVotes));
  const generations = events.filter(e => e.type === 'GENERATION').map(e => e.generation);
  assert.ok(new Set(generations).size >= 3);
  assert.equal(state, LENS_STATES.LOCKED);
  assert.equal(context?.locked?.id, 'test-a');
});
