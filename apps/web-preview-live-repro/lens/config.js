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
  ocrIntervalMs: 1600,
  ocrExactVotes: 2,
  ocrNameVotes: 2,
  ocrMaxObservations: 5,
  barcodeIntervalMs: 700,
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

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
