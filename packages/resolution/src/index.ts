import type { ResolutionCandidate, ResolutionDecision, ResolutionInput } from '../../contracts/src/index.js';

const hasHardConflict = (candidate: ResolutionCandidate): boolean => (candidate.contradictions?.length ?? 0) > 0;
const unique = (items: ResolutionCandidate[]): ResolutionCandidate | undefined => items.length === 1 ? items[0] : undefined;

export function resolve(input: ResolutionInput): ResolutionDecision {
  const hardConflicts = input.candidates.filter(hasHardConflict);
  const external = input.candidates.filter(c => c.verifiedExternalId);
  const barcode = input.candidates.filter(c => c.verifiedBarcode);
  const sku = input.candidates.filter(c => c.verifiedManufacturerSku);
  const identity = input.candidates.filter(c => c.hardIdentityExact);

  const contradictoryStrongMappings = [external, barcode, sku, identity]
    .filter(group => group.length > 0)
    .flatMap(group => group.map(c => c.entityId));
  if (new Set(contradictoryStrongMappings).size > 1 || hardConflicts.some(c => c.verifiedExternalId || c.verifiedBarcode || c.verifiedManufacturerSku || c.hardIdentityExact)) {
    return {
      status: 'CONFLICT',
      confidence: 1,
      ruleId: 'HARD_CONFLICT',
      candidates: sortCandidates(input.candidates),
      contradictions: hardConflicts.flatMap(c => c.contradictions ?? [])
    };
  }

  const exactExternal = unique(external);
  if (exactExternal) return auto(exactExternal, 'VERIFIED_EXTERNAL_ID');

  const exactBarcode = unique(barcode);
  if (exactBarcode && input.barcode?.checksumValid) return auto(exactBarcode, 'VERIFIED_GTIN');

  const exactSku = unique(sku);
  if (exactSku) return auto(exactSku, 'VERIFIED_MANUFACTURER_SKU');

  const exactIdentity = unique(identity.filter(c => !hasHardConflict(c)));
  if (exactIdentity) return auto(exactIdentity, 'DETERMINISTIC_IDENTITY');

  if (input.candidates.length === 0) {
    return { status: 'NEW_ENTITY', confidence: 0.8, ruleId: 'NO_CANDIDATES', candidates: [], contradictions: [] };
  }

  return {
    status: 'CANDIDATE_MATCH',
    confidence: candidateConfidence(input.candidates),
    ruleId: 'PROBABILISTIC_CANDIDATES_ONLY',
    candidates: sortCandidates(input.candidates),
    contradictions: hardConflicts.flatMap(c => c.contradictions ?? [])
  };
}

function auto(candidate: ResolutionCandidate, ruleId: string): ResolutionDecision {
  return {
    status: 'AUTO_MATCH',
    matchedEntityId: candidate.entityId,
    confidence: 0.999,
    ruleId,
    candidates: [candidate],
    contradictions: []
  };
}

function sortCandidates(candidates: ResolutionCandidate[]) {
  return [...candidates].sort((a, b) => b.score - a.score);
}

function candidateConfidence(candidates: ResolutionCandidate[]) {
  const sorted = sortCandidates(candidates);
  if (!sorted[0]) return 0;
  const top = Math.max(0, Math.min(100, sorted[0].score));
  const margin = sorted[1] ? Math.max(0, top - sorted[1].score) : top;
  return Math.min(0.99, Math.max(0.05, (top / 100) * 0.8 + Math.min(margin / 100, 0.19)));
}
