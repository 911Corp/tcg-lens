import { DEFAULT_POLICY } from './config.js';
import { ContradictionEngine } from './ContradictionEngine.js';

export class EvidenceFusion {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.contradictions = new ContradictionEngine();
  }

  evaluate({ temporal, visual, ocr = null, barcode = null, canonical = null }) {
    if (barcode?.verified && barcode.candidateId) {
      return { decision: 'LOCK', candidateId: barcode.candidateId, confidence: 0.995, reason: 'verified_barcode' };
    }
    if (!temporal?.top || !visual?.candidateId) {
      return { decision: 'CONTINUE', confidence: 0, reason: 'insufficient_visual_evidence' };
    }

    const top = temporal.top;
    if (top.candidateId !== visual.candidateId) {
      return {
        decision: 'CONTINUE',
        candidateId: visual.candidateId,
        confidence: 0,
        reason: 'temporal_visual_mismatch',
      };
    }

    const p = this.policy;
    const marginOk = top.avgMargin >= p.lockVisualMargin;
    const scoreOk = top.avgScore >= p.lockVisualScore && visual.embeddingVerified === true;
    const votesOk = top.votes >= p.minTemporalVotes;
    const qualityOk = top.avgQuality >= p.lockMinAverageQuality;
    const candidateId = top.candidateId;

    const contradiction = this.contradictions.evaluate({ candidateId, temporal, visual, ocr, barcode, canonical });
    if (contradiction.hardBlock) {
      return {
        decision: 'AMBIGUOUS',
        candidateId: null,
        confidence: 0,
        reason: contradiction.hardReasons[0],
        contradictions: contradiction,
      };
    }

    if (!marginOk && top.votes >= p.minTemporalVotes) {
      return { decision: 'AMBIGUOUS', candidateId: null, confidence: 0, reason: 'top1_top2_margin_too_small' };
    }

    const ocrPrintingSupports = Boolean(
      ocr?.candidateId === candidateId && ocr.collectorExact === true && !ocr.contradiction
    );
    const ocrConceptSupports = Boolean(
      ocr?.candidateId === candidateId && ocr.strongNameMatch === true && !ocr.contradiction
    );
    if (votesOk && scoreOk && marginOk && !qualityOk) {
      return { decision: 'CONTINUE', candidateId, confidence: 0, reason: 'frame_quality_insufficient_for_lock' };
    }

    if (votesOk && scoreOk && marginOk && qualityOk && ocrPrintingSupports) {
      const confidence = Math.min(0.995, 0.72 + top.avgScore * 0.16 + top.avgMargin * 0.6 + Math.min(top.votes, 6) * 0.012);
      return {
        decision: 'LOCK', candidateId, confidence, reason: 'visual_temporal_plus_exact_collector',
        evidence: { ocrPrintingSupports: true, ocrConceptSupports, softContradictions: contradiction.softReasons },
      };
    }

    const visualOnlyExtreme = visual.embeddingVerified === true
      && top.votes >= p.visualOnlyVotes
      && top.avgScore >= p.visualOnlyScore
      && top.avgMargin >= p.visualOnlyMargin
      && top.avgQuality >= p.visualOnlyMinAverageQuality;
    if (visualOnlyExtreme && !ocr?.contradiction) {
      const confidence = Math.min(0.985, 0.78 + top.avgScore * 0.12 + top.avgMargin * 0.45 + Math.min(top.votes, 7) * 0.009);
      return {
        decision: 'LOCK', candidateId, confidence, reason: 'extreme_temporal_visual_consensus',
        evidence: { ocrPrintingSupports: false, ocrConceptSupports, softContradictions: contradiction.softReasons },
      };
    }

    if (top.votes >= p.visualOnlyVotes && top.avgScore >= p.visualOnlyScore && top.avgMargin >= p.visualOnlyMargin && top.avgQuality < p.visualOnlyMinAverageQuality) {
      return { decision: 'CONTINUE', candidateId, confidence: 0, reason: 'frame_quality_insufficient_for_visual_only_lock' };
    }

    if (visual.score >= p.provisionalVisualScore) {
      return { decision: 'VERIFY', candidateId, confidence: Math.min(0.89, visual.score * 0.86), reason: 'visual_candidate_needs_corroboration' };
    }
    return { decision: 'CONTINUE', candidateId: null, confidence: 0, reason: 'visual_below_threshold' };
  }
}
