export const LENS_STATES = Object.freeze({
  ACQUIRING: 'ACQUIRING',
  TRACKING: 'TRACKING',
  ANALYZING: 'ANALYZING',
  VERIFYING: 'VERIFYING',
  LOCKED: 'LOCKED',
  AMBIGUOUS: 'AMBIGUOUS',
  UNKNOWN: 'UNKNOWN',
  CHANGE_PENDING: 'CHANGE_PENDING',
  ERROR: 'ERROR',
});

export const DEFAULT_POLICY = Object.freeze({
  detectorIntervalMs: 125,
  visualIntervalMs: 300,
  lockedVisualIntervalMs: 1150,
  // OCR runs in a worker thread: chain passes back to back (never two at once).
  ocrIntervalMs: 600,
  ocrExactVotes: 2,
  ocrNameVotes: 2,
  ocrMaxObservations: 5,
  barcodeIntervalMs: 450,
  lostAfterMs: 850,
  changeGraceMs: 450,
  minStableHits: 4,
  minQualityForVisual: 0.34,
  minQualityForOcr: 0.44,
  topK: 6,
  provisionalVisualScore: 0.84,
  lockVisualScore: 0.94,
  // v0.3.2: with a 2-read exact printed number + total consensus on the visual top, the visual
  // score bar is lowered (camera vs catalogue scan); margin, votes and quality bars are unchanged.
  lockVisualScoreWithPrinting: 0.9,
  // v0.3.4: printed name read twice (OCR consensus) + same visual bars as the printed-number path.
  lockWithPrintedName: true,
  // v0.3.4: when the card is identified but its language cannot be read, lock after this delay
  // with the language shown as unverified (never guessed), unless a read contradicts the family.
  languageGraceMs: 2500,
  lockVisualMargin: 0.06,
  lockMinAverageQuality: 0.46,
  visualOnlyScore: 0.965,
  visualOnlyMargin: 0.09,
  visualOnlyMinAverageQuality: 0.54,
  minTemporalVotes: 4,
  visualOnlyVotes: 5,
  temporalSwitchScore: 0.94,
  temporalSwitchMargin: 0.06,
  temporalSwitchVotes: 2,
  changeVisualScore: 0.95,
  changeVisualMargin: 0.08,
  changeVotes: 3,
  maxIndexRefs: 1200,
  warmBatch: 18,
  rectifiedWidth: 224,
  ocrRectifiedWidth: 640,
  cardAspect: 63 / 88,
});

/**
 * v0.3.5 calibrated instant recognition (DeepIndex). Scores are on the learned-whitening scale;
 * thresholds come from held-out simulated camera crops: with score ≥ 0.80 and margin ≥ 0.06 against
 * the best non-twin family, 0 wrong locks and 0 open-set (missing reference) false locks outside
 * artwork twins. Applied by the runtime only once the calibrated index is loaded.
 */
export const CALIBRATED_POLICY = Object.freeze({
  calibratedInstant: true,
  instantScore: 0.8,
  instantMargin: 0.06,
  instantVotes: 2,
  instantMinQuality: 0.35,
  visualIntervalMs: 110,
  minStableHits: 2,
  temporalSwitchScore: 0.8,
  temporalSwitchMargin: 0.06,
  changeVisualScore: 0.8,
  changeVisualMargin: 0.06,
  provisionalVisualScore: 0.7,
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
