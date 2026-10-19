import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY, LENS_STATES } from '../lens/config.js';
import { TrackManager } from '../lens/TrackManager.js';
import { TemporalConsensus } from '../lens/TemporalConsensus.js';
import { EvidenceFusion } from '../lens/EvidenceFusion.js';
import { LensStateMachine } from '../lens/LensStateMachine.js';
import { ChangeDetector } from '../lens/ChangeDetector.js';
import { OCRConsensus } from '../lens/OCRConsensus.js';

const rows = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/a-empty-b-a-vision.json'), 'utf8'));
const detection = { box: { x: 78, y: 94, w: 203, h: 278 }, quad: [{ x: 86, y: 98 }, { x: 272, y: 100 }, { x: 274, y: 364 }, { x: 80, y: 358 }] };

function expectedIdentityAt(t) {
  if (t < 5.067) return 'test-a';
  if (t < 7.067) return null;
  if (t < 12.0) return 'test-b';
  return 'test-a';
}

function runReplay({ corroborateB = false } = {}) {
  const policy = { ...DEFAULT_POLICY };
  const events = [];
  let now = 0;
  const sm = new LensStateMachine(({ state, previous, detail, sequence, reset }) => events.push({ t: now, type: 'STATE', state, previous, detail, sequence, reset: Boolean(reset) }));
  const tracker = new TrackManager(policy);
  tracker.reset();
  const fusion = new EvidenceFusion(policy);
  let context = null;
  sm.reset({ reason: 'camera_start' });

  function transition(next, detail = null) {
    try { return sm.transition(next, detail); }
    catch (error) {
      events.push({ t: now, type: 'STATE_REJECTED', from: sm.state, to: next, message: error.message });
      return false;
    }
  }

  function newContext(track, { resetState = false, reason = 'track_generation' } = {}) {
    context = {
      generation: track.generation,
      consensus: new TemporalConsensus({
        strongSwitchScore: policy.temporalSwitchScore,
        strongSwitchMargin: policy.temporalSwitchMargin,
        switchVotes: policy.temporalSwitchVotes,
      }),
      visualEvidence: null,
      ocrEvidence: null,
      ocrConsensus: new OCRConsensus({
        requiredExactVotes: policy.ocrExactVotes,
        requiredNameVotes: policy.ocrNameVotes,
        maxObservations: policy.ocrMaxObservations,
      }),
      lastOcrAt: 0,
      lastVisualAt: 0,
      locked: null,
      changeDetector: new ChangeDetector({
        minScore: policy.changeVisualScore,
        minMargin: policy.changeVisualMargin,
        votesRequired: policy.changeVotes,
      }),
    };
    if (resetState) sm.reset({ reason, generation: track.generation, trackId: track.id });
    events.push({ t: now, type: 'GENERATION', generation: track.generation, trackId: track.id, reason });
  }

  function lock(decision) {
    if (!transition(LENS_STATES.LOCKED, { id: decision.candidateId, reason: decision.reason, confidence: decision.confidence })) return false;
    context.locked = { id: decision.candidateId, confidence: decision.confidence };
    events.push({ t: now, type: 'LOCK', candidateId: decision.candidateId, reason: decision.reason, confidence: decision.confidence, expected: expectedIdentityAt(now / 1000) });
    return true;
  }

  function evaluate() {
    const temporal = context.consensus.summary();
    const decision = fusion.evaluate({ temporal, visual: context.visualEvidence, ocr: context.ocrEvidence, canonical: { conflict: false } });
    events.push({ t: now, type: 'FUSION', decision, temporal: temporal.top, temporalEpoch: temporal.epoch, temporalAction: temporal.lastAction });
    if (decision.decision === 'LOCK') lock(decision);
    else if (decision.decision === 'AMBIGUOUS') transition(LENS_STATES.AMBIGUOUS, { reason: decision.reason });
    else if (decision.decision === 'VERIFY') transition(LENS_STATES.VERIFYING, { candidateId: decision.candidateId, reason: decision.reason });
    else transition(LENS_STATES.ANALYZING, { reason: decision.reason });
  }

  function observeChange(candidate) {
    const result = context.changeDetector.observe({ lockedCandidateId: context.locked.id, candidate });
    events.push({ t: now, type: 'CHANGE_EVIDENCE', ...result });
    if (['SAME', 'INSUFFICIENT', 'RESET'].includes(result.action)) {
      if (sm.state === LENS_STATES.CHANGE_PENDING) transition(LENS_STATES.LOCKED, { id: context.locked.id, reason: result.reason });
      return;
    }
    if (!transition(LENS_STATES.CHANGE_PENDING, { candidateId: result.candidateId, votes: result.votes, reason: result.reason })) return;
    if (result.action === 'CONFIRMED') {
      const track = tracker.bumpGeneration();
      newContext(track, { reason: 'confirmed_card_change' });
      transition(LENS_STATES.TRACKING, { reason: 'confirmed_card_change', candidateId: result.candidateId });
    }
  }

  for (const row of rows) {
    now = Math.round(row.t * 1000);
    const priorGeneration = tracker.track?.generation;
    const track = tracker.update(row.detected ? [detection] : [], now);
    if (!track) {
      if (context) events.push({ t: now, type: 'TRACK_LOST', locked: context.locked?.id || null });
      context = null;
      sm.reset({ reason: 'no_card' });
      continue;
    }
    if (!context || priorGeneration !== track.generation || context.generation !== track.generation) {
      const resetState = Boolean(context && context.generation !== track.generation);
      newContext(track, { resetState, reason: resetState ? 'tracker_generation_changed' : 'track_context_created' });
    }
    if (!track.stable) {
      transition(LENS_STATES.TRACKING, { hits: track.hits });
      continue;
    }
    if ([LENS_STATES.TRACKING, LENS_STATES.UNKNOWN, LENS_STATES.AMBIGUOUS].includes(sm.state)) transition(LENS_STATES.ANALYZING, { generation: track.generation });

    const interval = context.locked ? policy.lockedVisualIntervalMs : policy.visualIntervalMs;
    if (now - context.lastVisualAt < interval) continue;
    context.lastVisualAt = now;
    const id = row.top === 'a' ? 'test-a' : 'test-b';
    const candidate = { id, score: row.score, margin: row.margin, embeddingVerified: true };
    context.visualEvidence = { candidateId: id, score: row.score, margin: row.margin, embeddingVerified: true, quality: 0.8 };
    const temporal = context.consensus.observe({ candidateId: id, score: row.score, margin: row.margin, quality: 0.8, at: now });
    events.push({ t: now, type: 'VISUAL', candidateId: id, score: row.score, margin: row.margin, temporalActive: temporal.activeCandidateId, temporalAction: temporal.lastAction, temporalEpoch: temporal.epoch, locked: context.locked?.id || null });
    if (!context.locked && corroborateB && id === 'test-b' && temporal.top?.candidateId === 'test-b' && temporal.top.votes >= 4 && now - context.lastOcrAt >= policy.ocrIntervalMs) {
      context.lastOcrAt = now;
      context.ocrEvidence = context.ocrConsensus.observe({
        available: true,
        candidateId: 'test-b',
        collectorExact: true,
        strongNameMatch: true,
        contradiction: false,
        at: now,
      }, 'test-b');
      events.push({ t: now, type: 'OCR_CONSENSUS', candidateId: context.ocrEvidence.candidateId, exactVotes: context.ocrEvidence.exactVotes, collectorExact: context.ocrEvidence.collectorExact });
    }
    if (context.locked) observeChange(candidate);
    else evaluate();
  }

  return { events, state: sm.state, context, tracker };
}

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
