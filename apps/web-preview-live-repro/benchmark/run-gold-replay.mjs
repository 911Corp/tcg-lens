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
    // v0.3.2: ocrIntervalMs 2600 -> 1600 lets the 2-read consensus complete within segment A1 too
    // (v0.3.1 only locked B and A2). Real-device latency must still be measured.
    requirements: { minSegmentCoverage: 1, lockSequence: ['test-a', 'test-b', 'test-a'] },
  },
  {
    id: 'unindexed-artwork-twin-never-locks-even-with-ocr',
    run: () => runReplay({ visualOnlyLockAllowed: false, lockBlockedReason: 'UNINDEXED_ARTWORK_TWIN', ocrRead: ({ candidateId }) => ({ candidateId, collectorExact: true, strongNameMatch: true, contradiction: false }) }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
  {
    // Recall gate: one garbage OCR read (e.g. "EO1/38") must not poison the track.
    id: 'single-noisy-printed-read-does-not-block',
    run: () => { let reads = 0; return runReplay({ visualOnlyLockAllowed: true, ocrRead: () => (reads++ === 0 ? { candidateId: null, contradiction: true, contradictionKind: 'printed_metadata', contradictionSignature: 'EO1/38' } : null) }); },
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    id: 'printed-metadata-contradiction-blocks-extreme-visual',
    run: () => runReplay({ visualOnlyLockAllowed: true, ocrRead: () => ({ candidateId: null, contradiction: true }) }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
  // v0.3.2 auto-language: FR and EN printings share the artwork; the language must be proven.
  // v0.3.4: when it cannot be read, the printing still locks after languageGraceMs with the
  // language shown as unverified (never guessed); a read of a foreign language still blocks.
  {
    id: 'multi-language-family-locks-with-language-unverified-after-grace',
    run: () => runReplay({ languages: ['fr', 'en'] }),
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    id: 'multi-language-family-locks-after-two-agreeing-language-reads',
    run: () => runReplay({ languages: ['fr', 'en'], langRead: () => 'fr' }),
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    id: 'conflicting-fr-en-reads-lock-printing-with-language-unverified',
    run: () => { let n = 0; return runReplay({ languages: ['fr', 'en'], langRead: () => (n++ % 2 ? 'en' : 'fr') }); },
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    // Japanese card whose artwork matches an English-only printing (JA twin absent from the index).
    id: 'japanese-text-on-english-only-printing-never-locks',
    run: () => runReplay({ languages: ['en'], langRead: () => 'ja' }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
  {
    id: 'japanese-text-on-fr-en-printing-never-locks',
    run: () => runReplay({ languages: ['fr', 'en'], langRead: () => 'ja' }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
  {
    id: 'japanese-printing-locks-with-japanese-reads',
    run: () => runReplay({ languages: ['ja'], langRead: () => 'ja' }),
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    id: 'auto-scan-single-language-printing-locks-after-grace',
    run: () => runReplay({ languages: ['en'] }),
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  {
    id: 'fixed-scan-language-needs-no-language-read',
    run: () => runReplay({ languages: ['ja'], autoLanguage: false }),
    requirements: { minSegmentCoverage: 2 / 3, lockSequence: ['test-a', 'test-a'] },
  },
  // v0.3.5 calibrated instant recognition (scores on the calibrated scale in production; the replay
  // fixture scores clear the calibrated bars).
  {
    // Instant: every segment locks (A1, B and A2), ~270 ms after the track is stable.
    id: 'calibrated-instant-locks-twin-free-cards-in-every-segment',
    run: () => runReplay({ calibrated: true, visualOnlyLockAllowed: false, languages: ['fr', 'en'] }),
    requirements: { minSegmentCoverage: 1, lockSequence: ['test-a', 'test-b', 'test-a'] },
  },
  {
    id: 'calibrated-artwork-twins-never-lock-without-printed-evidence',
    run: () => runReplay({ calibrated: true, twinFree: false, languages: ['fr', 'en'] }),
    requirements: { minSegmentCoverage: 0, lockSequence: [] },
  },
  {
    // Japanese card matched to a Latin-only printing: the instant lock is withdrawn by the background
    // language reads and the same printing is never locked again on this track.
    id: 'calibrated-japanese-read-withdraws-latin-lock-and-never-relocks',
    run: () => runReplay({ calibrated: true, languages: ['fr', 'en'], langRead: () => 'ja' }),
    requirements: { minSegmentCoverage: 0, lockSequence: ['test-a'], maxLocksAfterRetraction: 0 },
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
