export class CanonicalResolver {
  resolve({ visualCandidates = [], ocr = null }) {
    const top = visualCandidates[0] || null;
    if (!top) return { candidate: null, conflict: false, reason: 'no_visual_candidate' };
    if (ocr?.contradiction === true) {
      return { candidate: null, conflict: true, reason: 'ocr_explicit_contradiction' };
    }
    if (ocr?.candidateId && ocr.candidateId !== top.id && ocr.collectorExact === true) {
      return { candidate: null, conflict: true, reason: 'collector_identifier_conflict' };
    }
    if (ocr?.candidateId === top.id && ocr.collectorExact === true) {
      return { candidate: top, conflict: false, reason: 'exact_collector_corroborated' };
    }
    if (ocr?.candidateId === top.id && ocr.strongNameMatch === true) {
      return { candidate: top, conflict: false, reason: 'concept_only_corroborated' };
    }
    return { candidate: top, conflict: false, reason: 'visual_ranked' };
  }
}
