import { collectorNumberMatchKeyV1, normalizeTextV1 } from './normalization.js';
import { tcgplayerComparableName } from './cardmarket-crosswalk.js';
import type { NormalizedCardmarketProduct } from './cardmarket.js';
import type { NormalizedTcgcsvProduct } from './tcgcsv.js';

export interface CanonicalCardCandidate {
  [key: string]: unknown;
  entity_id: string;
  name: string;
  collector_number_normalized: string;
  language_code: string;
  set_name: string;
  set_code: string | null;
}

export interface CandidateDecision {
  status: 'AUTO_MATCH' | 'CANDIDATE_MATCH' | 'NEW_ENTITY';
  matches: CanonicalCardCandidate[];
  ruleId: string;
  confidence: number;
}

export function decideCardmarketEnrichment(product: NormalizedCardmarketProduct, candidates: CanonicalCardCandidate[]): CandidateDecision {
  if (product.productGroup !== 'single' || !product.collectorNumberNormalized) {
    return { status: 'CANDIDATE_MATCH', matches: [], ruleId: 'CARDMARKET_INSUFFICIENT_CARD_IDENTITY', confidence: 0.2 };
  }
  const numberKey = collectorNumberMatchKeyV1(product.collectorNumberNormalized);
  const numberCandidates = candidates.filter(c => collectorNumberMatchKeyV1(c.collector_number_normalized) === numberKey);
  const nameCandidates = numberCandidates.filter(c => normalizeTextV1(c.name) === product.normalizedName);
  if (product.normalizedExpansionName) {
    const setMatches = nameCandidates.filter(c => normalizeSetHint(c.set_name) === normalizeSetHint(product.normalizedExpansionName!));
    if (setMatches.length === 1) return { status: 'AUTO_MATCH', matches: setMatches, ruleId: 'CARDMARKET_NUMBER_NAME_SET_EXACT', confidence: 0.97 };
    if (setMatches.length > 1) return { status: 'CANDIDATE_MATCH', matches: setMatches, ruleId: 'CARDMARKET_MULTI_LANGUAGE_OR_SET_AMBIGUITY', confidence: 0.75 };
  }
  if (nameCandidates.length === 1) return { status: 'CANDIDATE_MATCH', matches: nameCandidates, ruleId: 'CARDMARKET_NUMBER_NAME_UNIQUE_NO_SET_AGREEMENT', confidence: 0.75 };
  if (nameCandidates.length > 1) return { status: 'CANDIDATE_MATCH', matches: nameCandidates, ruleId: 'CARDMARKET_AMBIGUOUS_PRODUCT', confidence: 0.7 };
  return { status: numberCandidates.length ? 'CANDIDATE_MATCH' : 'NEW_ENTITY', matches: numberCandidates, ruleId: numberCandidates.length ? 'CARDMARKET_NO_DETERMINISTIC_MATCH' : 'CARDMARKET_CANONICAL_GAP', confidence: numberCandidates.length ? 0.5 : 0.4 };
}

export function decideTcgcsvEnrichment(product: NormalizedTcgcsvProduct, candidates: CanonicalCardCandidate[]): CandidateDecision {
  if (!product.collectorNumberNormalized) {
    return { status: 'CANDIDATE_MATCH', matches: [], ruleId: 'TCGCSV_MISSING_COLLECTOR_NUMBER', confidence: 0.2 };
  }
  const exactName = candidates.filter(c =>
    c.language_code === product.languageCode &&
    collectorNumberMatchKeyV1(c.collector_number_normalized) === collectorNumberMatchKeyV1(product.collectorNumberNormalized) &&
    // TCGplayer names many cards "Greninja ex - 021/128": compare without the printed number suffix.
    (normalizeTextV1(c.name) === product.normalizedName
      || tcgplayerComparableName(c.name, c.collector_number_normalized) === tcgplayerComparableName(product.normalizedName, product.collectorNumberNormalized))
  );
  const setMatches = exactName.filter(c => setMatchesTcgcsv(c, product.groupName, product.groupAbbreviation));
  if (setMatches.length === 1) return { status: 'AUTO_MATCH', matches: setMatches, ruleId: 'TCGCSV_NUMBER_NAME_GROUP_EXACT', confidence: 0.98 };
  if (setMatches.length > 1) return { status: 'CANDIDATE_MATCH', matches: setMatches, ruleId: 'TCGCSV_GROUP_AMBIGUITY', confidence: 0.75 };
  // v0.3.1: name + number + language without group/set agreement is not deterministic. On the real
  // catalog 23% of such matches disagreed with TCGdex's asserted TCGplayer IDs.
  if (exactName.length === 1) return { status: 'CANDIDATE_MATCH', matches: exactName, ruleId: 'TCGCSV_NUMBER_NAME_LANGUAGE_UNIQUE_NO_SET_AGREEMENT', confidence: 0.75 };
  if (exactName.length > 1) return { status: 'CANDIDATE_MATCH', matches: exactName, ruleId: 'TCGCSV_AMBIGUOUS_PRODUCT', confidence: 0.7 };
  return { status: candidates.length ? 'CANDIDATE_MATCH' : 'NEW_ENTITY', matches: candidates, ruleId: candidates.length ? 'TCGCSV_NO_DETERMINISTIC_MATCH' : 'TCGCSV_CANONICAL_GAP', confidence: candidates.length ? 0.5 : 0.4 };
}

function setMatchesTcgcsv(candidate: CanonicalCardCandidate, groupName: string, abbreviation?: string): boolean {
  const set = normalizeSetHint(candidate.set_name);
  const code = candidate.set_code ? normalizeSetHint(candidate.set_code) : '';
  const group = normalizeSetHint(groupName);
  const abr = abbreviation ? normalizeSetHint(abbreviation) : '';
  return set === group || Boolean(abr && (code === abr || set === abr)) || group.endsWith(` ${set}`) || group.endsWith(`:${set}`);
}

export function normalizeSetHint(value: string): string {
  return normalizeTextV1(value).replace(/^pokemon\s+/u, '').replace(/^[a-z0-9.-]+:\s*/u, '').trim();
}
