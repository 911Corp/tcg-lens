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
