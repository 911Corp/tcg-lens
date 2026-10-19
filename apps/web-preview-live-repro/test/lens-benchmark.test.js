import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkEvaluator } from '../benchmark/BenchmarkEvaluator.js';
import { replaySegments, runReplay } from './helpers/replayHarness.js';

const evaluator = new BenchmarkEvaluator();

test('benchmark evaluator reports zero FCIR for the no-OCR safety replay', () => {
  const { events } = runReplay();
  const result = evaluator.evaluateScenario({
    id: 'no-ocr',
    events,
    segments: replaySegments,
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  });
  assert.equal(result.metrics.falseConfidentIdentificationRate, 0);
  assert.equal(result.metrics.emptyFalseLocks, 0);
  assert.equal(result.metrics.crossIdentityDecisions, 0);
  assert.equal(result.pass, true);
});

test('benchmark evaluator requires full segment coverage when exact OCR consensus is available', () => {
  const { events } = runReplay({ corroborateB: true });
  const result = evaluator.evaluateScenario({
    id: 'with-ocr',
    events,
    segments: replaySegments,
    requirements: { minSegmentCoverage: 1, lockSequence: ['test-a', 'test-b', 'test-a'] },
  });
  assert.equal(result.metrics.segmentLockCoverage, 1);
  assert.equal(result.metrics.falseConfidentIdentificationRate, 0);
  assert.equal(result.pass, true);
});

test('benchmark evaluator fails a scenario containing a false confident lock', () => {
  const events = [{ t: 1000, type: 'LOCK', candidateId: 'wrong', expected: 'test-a' }];
  const result = evaluator.evaluateScenario({ id: 'negative-control', events, segments: replaySegments });
  assert.equal(result.metrics.falseConfidentLocks, 1);
  assert.equal(result.metrics.falseConfidentIdentificationRate, 1);
  assert.equal(result.pass, false);
});
