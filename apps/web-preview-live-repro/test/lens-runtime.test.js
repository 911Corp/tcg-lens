import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LensStateMachine } from '../lens/LensStateMachine.js';
import { TemporalConsensus } from '../lens/TemporalConsensus.js';
import { EvidenceFusion } from '../lens/EvidenceFusion.js';
import { LENS_STATES } from '../lens/config.js';
import { TrackManager } from '../lens/TrackManager.js';
import { createIdentityToken, isIdentityTokenCurrent, createTrackToken, isTrackTokenCurrent } from '../lens/IdentityGuard.js';

function temporal(candidateId, votes, score = 0.97, margin = 0.10, quality = 0.7) {
  const c = new TemporalConsensus();
  for (let i = 0; i < votes; i++) c.observe({ candidateId, score, margin, quality });
  return c.summary();
}

const visual = (candidateId = 'sv01-001', score = 0.97, margin = 0.10, embeddingVerified = true) => ({ candidateId, score, margin, embeddingVerified });

test('state machine cannot jump from acquiring directly to locked', () => {
  const sm = new LensStateMachine();
  assert.throws(() => sm.transition(LENS_STATES.LOCKED), /Illegal Lens transition/);
  sm.transition(LENS_STATES.TRACKING);
  sm.transition(LENS_STATES.ANALYZING);
  sm.transition(LENS_STATES.VERIFYING);
  sm.transition(LENS_STATES.LOCKED);
  assert.equal(sm.state, LENS_STATES.LOCKED);
});

test('visual score alone does not lock before temporal policy is satisfied', () => {
  const fusion = new EvidenceFusion();
  const result = fusion.evaluate({ temporal: temporal('a', 3, 0.99, 0.14), visual: visual('a', 0.99, 0.14), canonical: { conflict: false } });
  assert.notEqual(result.decision, 'LOCK');
});

test('unverified visual prefilter never locks even with extreme votes', () => {
  const fusion = new EvidenceFusion();
  const result = fusion.evaluate({ temporal: temporal('a', 8, 0.995, 0.18), visual: visual('a', 0.995, 0.18, false), canonical: { conflict: false } });
  assert.notEqual(result.decision, 'LOCK');
});

test('exact OCR collector corroboration plus stable visual evidence can lock', () => {
  const fusion = new EvidenceFusion();
  const result = fusion.evaluate({
    temporal: temporal('a', 4, 0.95, 0.08),
    visual: visual('a', 0.95, 0.08, true),
    ocr: { candidateId: 'a', collectorExact: true, strongNameMatch: true, contradiction: false },
    canonical: { conflict: false },
  });
  assert.equal(result.decision, 'LOCK');
  assert.equal(result.candidateId, 'a');
  assert.ok(result.confidence >= 0.9);
});

test('small top1/top2 margin becomes ambiguous instead of confident identification', () => {
  const fusion = new EvidenceFusion();
  const result = fusion.evaluate({ temporal: temporal('a', 5, 0.98, 0.02), visual: visual('a', 0.98, 0.02), canonical: { conflict: false } });
  assert.equal(result.decision, 'AMBIGUOUS');
});

test('strong OCR contradiction blocks visual lock', () => {
  const fusion = new EvidenceFusion();
  const result = fusion.evaluate({
    temporal: temporal('a', 6, 0.99, 0.12),
    visual: visual('a', 0.99, 0.12),
    ocr: { candidateId: 'b', collectorExact: true, strongNameMatch: true },
    canonical: { conflict: true },
  });
  assert.equal(result.decision, 'AMBIGUOUS');
});

test('extreme visual-only consensus requires five verified observations', () => {
  const fusion = new EvidenceFusion();
  const four = fusion.evaluate({ temporal: temporal('a', 4, 0.98, 0.11), visual: visual('a', 0.98, 0.11), canonical: { conflict: false } });
  const five = fusion.evaluate({ temporal: temporal('a', 5, 0.98, 0.11), visual: visual('a', 0.98, 0.11), canonical: { conflict: false } });
  assert.notEqual(four.decision, 'LOCK');
  assert.equal(five.decision, 'LOCK');
});

test('track generation changes when a geometrically new card replaces the old one', () => {
  const tracker = new TrackManager({ minStableHits: 2, lostAfterMs: 800 });
  const d1 = { box: { x: 10, y: 10, w: 100, h: 140 }, quad: [{x:10,y:10},{x:110,y:10},{x:110,y:150},{x:10,y:150}] };
  const d2 = { box: { x: 500, y: 500, w: 100, h: 140 }, quad: [{x:500,y:500},{x:600,y:500},{x:600,y:640},{x:500,y:640}] };
  const first = tracker.update([d1], 0);
  const g1 = first.generation;
  const second = tracker.update([d2], 100);
  assert.ok(second.generation > g1);
});

test('camera-first HTML contains no manual identify UI or fake phone chrome', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
  assert.equal(html.includes('id="ocrBtn"'), false);
  assert.equal(html.includes('id="barcodeBtn"'), false);
  assert.equal(html.includes('class="status"'), false);
  assert.equal(html.includes('class="phone"'), false);
  assert.equal(html.includes('reticle'), false);
  assert.equal(html.includes('mock-card'), false);
  assert.match(html, /type="module" src="\/lens\/index\.js"/);
});


test('temporal consensus isolates a new candidate instead of mixing identities', () => {
  const c = new TemporalConsensus({ switchVotes: 2, strongSwitchScore: 0.94, strongSwitchMargin: 0.06 });
  c.observe({ candidateId: 'b', score: 0.98, margin: 0.11, quality: 0.8 });
  c.observe({ candidateId: 'b', score: 0.98, margin: 0.11, quality: 0.8 });
  const pending = c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  assert.equal(pending.top.candidateId, 'b');
  assert.equal(pending.top.votes, 2);
  assert.deepEqual(pending.pendingSwitch, { candidateId: 'a', votes: 1 });
  assert.equal(pending.ranked.some(x => x.candidateId === 'a'), false);
});

test('temporal consensus switches only after consecutive strong observations and resets the active window', () => {
  const c = new TemporalConsensus({ switchVotes: 2, strongSwitchScore: 0.94, strongSwitchMargin: 0.06 });
  for (let i = 0; i < 5; i++) c.observe({ candidateId: 'b', score: 0.98, margin: 0.11, quality: 0.8 });
  c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  const switched = c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  assert.equal(switched.top.candidateId, 'a');
  assert.equal(switched.top.votes, 2);
  assert.equal(switched.total, 2);
  assert.equal(switched.epoch, 1);
  assert.equal(switched.lastAction, 'SWITCH_ACCEPTED');
  assert.equal(switched.ranked.some(x => x.candidateId === 'b'), false);
});

test('a weak one-frame mismatch cannot replace the active temporal identity', () => {
  const c = new TemporalConsensus({ switchVotes: 2, strongSwitchScore: 0.94, strongSwitchMargin: 0.06 });
  c.observe({ candidateId: 'a', score: 0.98, margin: 0.11, quality: 0.8 });
  const result = c.observe({ candidateId: 'b', score: 0.91, margin: 0.04, quality: 0.8 });
  assert.equal(result.top.candidateId, 'a');
  assert.equal(result.pendingSwitch, null);
  assert.equal(result.lastAction, 'MISMATCH_REJECTED');
});

test('visual and temporal identities must agree before VERIFY or LOCK is possible', () => {
  const fusion = new EvidenceFusion();
  const result = fusion.evaluate({
    temporal: temporal('b', 6, 0.99, 0.12),
    visual: visual('a', 0.99, 0.12),
    ocr: { candidateId: 'b', collectorExact: true, strongNameMatch: true, contradiction: false },
    canonical: { conflict: false },
  });
  assert.equal(result.decision, 'CONTINUE');
  assert.equal(result.candidateId, 'a');
  assert.equal(result.reason, 'temporal_visual_mismatch');
});

test('switching back A after B starts a clean A temporal epoch', () => {
  const c = new TemporalConsensus({ switchVotes: 2, strongSwitchScore: 0.94, strongSwitchMargin: 0.06 });
  c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  c.observe({ candidateId: 'b', score: 0.99, margin: 0.12, quality: 0.8 });
  c.observe({ candidateId: 'b', score: 0.99, margin: 0.12, quality: 0.8 });
  c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  const final = c.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  assert.equal(final.top.candidateId, 'a');
  assert.equal(final.top.votes, 2);
  assert.equal(final.epoch, 2);
  assert.equal(final.ranked.length, 1);
});


test('identity token rejects OCR evidence after visual identity changes inside the same track generation', () => {
  const consensus = new TemporalConsensus({ switchVotes: 2 });
  consensus.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  const track = { id: 7, generation: 3 };
  const context = { generation: 3, visualEvidence: { candidateId: 'a' }, consensus };
  const token = createIdentityToken(context, track);
  assert.equal(isIdentityTokenCurrent({ running: true, context, track }, token), true);
  context.visualEvidence = { candidateId: 'b' };
  assert.equal(isIdentityTokenCurrent({ running: true, context, track }, token), false);
});

test('identity token rejects OCR evidence after temporal epoch changes even if candidate id cycles back', () => {
  const consensus = new TemporalConsensus({ switchVotes: 2 });
  consensus.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  const track = { id: 9, generation: 4 };
  const context = { generation: 4, visualEvidence: { candidateId: 'a' }, consensus };
  const token = createIdentityToken(context, track);
  consensus.observe({ candidateId: 'b', score: 0.99, margin: 0.12, quality: 0.8 });
  consensus.observe({ candidateId: 'b', score: 0.99, margin: 0.12, quality: 0.8 });
  consensus.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  consensus.observe({ candidateId: 'a', score: 0.99, margin: 0.12, quality: 0.8 });
  context.visualEvidence = { candidateId: 'a' };
  assert.equal(consensus.summary().epoch, 2);
  assert.equal(isIdentityTokenCurrent({ running: true, context, track }, token), false);
});

test('track token rejects delayed barcode result after a new generation or track', () => {
  const context = { generation: 5 };
  const track = { id: 10, generation: 5 };
  const token = createTrackToken(context, track);
  assert.equal(isTrackTokenCurrent({ running: true, context, track }, token), true);
  const replacementContext = { generation: 6 };
  const replacementTrack = { id: 11, generation: 6 };
  assert.equal(isTrackTokenCurrent({ running: true, context: replacementContext, track: replacementTrack }, token), false);
});
