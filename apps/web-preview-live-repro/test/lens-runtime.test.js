import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LensStateMachine } from '../lens/LensStateMachine.js';
import { TemporalConsensus } from '../lens/TemporalConsensus.js';
import { EvidenceFusion } from '../lens/EvidenceFusion.js';
import { LENS_STATES } from '../lens/config.js';
import { TrackManager } from '../lens/TrackManager.js';

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
