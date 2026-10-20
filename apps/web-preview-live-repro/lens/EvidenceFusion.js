import { DEFAULT_POLICY } from './config.js';
import { ContradictionEngine } from './ContradictionEngine.js';

export class EvidenceFusion {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.contradictions = new ContradictionEngine();
  }

  /**
   * v0.3.2 auto-language: a printing family present in several languages (FR/EN share artwork)
   * may only lock once its physical language is proven (`visual.resolvedLang`). Otherwise the lock
   * is held as VERIFY: identity of the printing, including language, is never guessed.
   */
  evaluate(input) {
    const d = this._evaluate(input);
    const v = input.visual || {};
    if (d.decision === 'LOCK' && d.reason !== 'verified_barcode' && v.languageContradiction) {
      // Printed text says the card is in a language this printing does not exist in.
      return { decision: 'AMBIGUOUS', candidateId: null, confidence: 0, reason: `language_contradiction:${v.languageContradiction}` };
    }
    if (d.decision === 'LOCK' && d.reason !== 'verified_barcode' && (v.languages?.length || 0) > 0 && !v.resolvedLang) {
      // Identity is proven but the language is not readable (blur, glare, slow OCR): after a grace
      // delay, lock the printing and show the language as unverified, unless a read pointed to a
      // language the printing does not exist in.
      const grace = this.policy.languageGraceMs ?? Infinity;
      if ((v.languageWaitMs ?? 0) >= grace && !v.languageOutside) {
        return { ...d, languageUnverified: true, reason: `${d.reason}+language_unverified` };
      }
      return { decision: 'VERIFY', candidateId: d.candidateId, confidence: Math.min(0.89, d.confidence), reason: 'language_unresolved', pendingLock: d.reason };
    }
    return d;
  }

  _evaluate({ temporal, visual, ocr = null, barcode = null, canonical = null }) {
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

    // v0.3.1: the canonical pool can mark a candidate as never lockable, e.g. it has an artwork twin
    // (reprint / classic collection) with no usable reference image. Neither visual consensus nor a
    // printed number can tell them apart, so the honest outcome is AMBIGUOUS.
    if (visual.lockBlockedReason) {
      return { decision: 'AMBIGUOUS', candidateId: null, confidence: 0, reason: `candidate_lock_blocked:${visual.lockBlockedReason}` };
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
    // v0.3.4: the printed name (2-read consensus) confirms the card; the visual margin separates
    // printings (identical-artwork reprints are excluded above by lockBlockedReason / margin).
    // Only for candidates whose set is visually complete (visualOnlyLockAllowed): every printing of
    // the set is indexed, so the visual margin really separates printings. Elsewhere a name read
    // alone still cannot lock an exact printing.
    if (p.lockWithPrintedName && visual.visualOnlyLockAllowed === true && votesOk && marginOk && qualityOk && ocrConceptSupports
      && top.avgScore >= (p.lockVisualScoreWithPrinting ?? p.lockVisualScore) && visual.embeddingVerified === true) {
      const confidence = Math.min(0.985, 0.7 + top.avgScore * 0.16 + top.avgMargin * 0.6 + Math.min(top.votes, 6) * 0.01);
      if (!ocrPrintingSupports) return {
        decision: 'LOCK', candidateId, confidence, reason: 'visual_temporal_plus_printed_name',
        evidence: { ocrPrintingSupports: false, ocrConceptSupports: true, softContradictions: contradiction.softReasons },
      };
    }
    if (votesOk && scoreOk && marginOk && !qualityOk) {
      return { decision: 'CONTINUE', candidateId, confidence: 0, reason: 'frame_quality_insufficient_for_lock' };
    }

    const printingScoreOk = top.avgScore >= (p.lockVisualScoreWithPrinting ?? p.lockVisualScore) && visual.embeddingVerified === true;
    if (votesOk && printingScoreOk && marginOk && qualityOk && ocrPrintingSupports) {
      const confidence = Math.min(0.995, 0.72 + top.avgScore * 0.16 + top.avgMargin * 0.6 + Math.min(top.votes, 6) * 0.012);
      return {
        decision: 'LOCK', candidateId, confidence, reason: 'visual_temporal_plus_exact_collector',
        evidence: { ocrPrintingSupports: true, ocrConceptSupports, softContradictions: contradiction.softReasons },
      };
    }

    // v0.3.1: visual-only locks are only permitted for candidates whose canonical set is visually
    // complete and released (candidate-pool flag). Missing references elsewhere in a set mean a
    // neighbour may be the true card; such candidates need OCR/printing corroboration to lock.
    const visualOnlyPermitted = visual.visualOnlyLockAllowed === true;
    const visualOnlyExtreme = visual.embeddingVerified === true
      && visualOnlyPermitted
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

    if (!visualOnlyPermitted && visual.embeddingVerified === true && top.votes >= p.visualOnlyVotes && top.avgScore >= p.visualOnlyScore && top.avgMargin >= p.visualOnlyMargin) {
      return { decision: 'VERIFY', candidateId, confidence: Math.min(0.89, visual.score * 0.86), reason: 'visual_only_lock_not_permitted_for_candidate_set' };
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
