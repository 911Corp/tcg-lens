export class ContradictionEngine {
  evaluate({ candidateId, temporal = null, visual = null, ocr = null, barcode = null, canonical = null }) {
    const hardReasons = [];
    const softReasons = [];

    if (temporal?.top?.candidateId && visual?.candidateId && temporal.top.candidateId !== visual.candidateId) {
      hardReasons.push('temporal_visual_mismatch');
    }
    if (canonical?.conflict) hardReasons.push(canonical.reason || 'canonical_conflict');
    if (ocr?.contradiction === true) hardReasons.push('ocr_explicit_contradiction');
    if (ocr?.candidateId && candidateId && ocr.candidateId !== candidateId) {
      if (ocr.collectorExact) hardReasons.push('ocr_collector_contradiction');
      else if (ocr.strongNameMatch) softReasons.push('ocr_name_only_disagreement');
    }
    if (barcode?.verified && barcode?.candidateId && candidateId && barcode.candidateId !== candidateId) {
      hardReasons.push('verified_barcode_contradiction');
    }

    return {
      hardBlock: hardReasons.length > 0,
      hardReasons: [...new Set(hardReasons)],
      softReasons: [...new Set(softReasons)],
    };
  }
}
