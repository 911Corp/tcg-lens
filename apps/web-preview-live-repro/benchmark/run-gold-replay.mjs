import { BenchmarkEvaluator } from './BenchmarkEvaluator.js';
import { replaySegments, runReplay } from '../test/helpers/replayHarness.js';

const evaluator = new BenchmarkEvaluator();
const scenarios = [
  {
    id: 'a-empty-b-a-no-ocr',
    run: () => runReplay(),
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    id: 'a-empty-b-a-with-exact-ocr-consensus',
    run: () => runReplay({ corroborateB: true }),
    requirements: { minSegmentCoverage: 1, lockSequence: ['test-a', 'test-b', 'test-a'] },
  },
  // v0.3.1 candidate intelligence
  {
    id: 'incomplete-set-no-ocr-refuses-visual-only',
    run: () => runReplay({ visualOnlyLockAllowed: false }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
  {
    id: 'incomplete-set-locks-only-with-printed-number-consensus',
    run: () => runReplay({ visualOnlyLockAllowed: false, ocrRead: ({ candidateId }) => ({ candidateId, collectorExact: true, strongNameMatch: true, contradiction: false }) }),
    // 2-read OCR consensus at ocrIntervalMs=2600 needs >= ~5.3 s of stable track; segment A1 (~5.0 s)
    // is too short, so only B and A2 can lock. This latency cost must be measured on real devices.
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-b', 'test-a'] },
  },
  {
    id: 'printed-metadata-contradiction-blocks-extreme-visual',
    run: () => runReplay({ visualOnlyLockAllowed: true, ocrRead: () => ({ candidateId: null, contradiction: true }) }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
];

const results = scenarios.map(scenario => {
  const { events } = scenario.run();
  return evaluator.evaluateScenario({ id: scenario.id, events, segments: replaySegments, requirements: scenario.requirements });
});
const report = evaluator.aggregate(results, { productionEvidence: false });
report.datasetTier = 'REPLAY_PROXY';
report.warning = 'This benchmark is a reproducible regression proxy, not physical-device production evidence.';
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
