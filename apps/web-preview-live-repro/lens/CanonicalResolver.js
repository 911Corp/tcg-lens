export class CanonicalResolver {
  resolve({ visualCandidates = [], ocr = null }) {
    const top = visualCandidates[0] || null;
    if (!top) return { candidate: null, conflict: false, reason: 'no_visual_candidate' };
    if (ocr?.candidateId && ocr.candidateId !== top.id && (ocr.collectorExact || ocr.strongNameMatch)) {
      return { candidate: null, conflict: true, reason: 'strong_identifier_conflict' };
    }
    return { candidate: top, conflict: false, reason: ocr?.candidateId === top.id ? 'corroborated' : 'visual_ranked' };
  }
}
