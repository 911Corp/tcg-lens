export type ResolutionStatus = 'AUTO_MATCH' | 'CANDIDATE_MATCH' | 'CONFLICT' | 'NEW_ENTITY';
export type EntityType = 'CARD_PRINTING' | 'CARD_VARIANT' | 'SEALED_PRODUCT' | 'SET';

export interface CandidateEvidence {
  kind: string;
  weight?: number;
  value?: string | number | boolean;
}

export interface ResolutionCandidate {
  entityId: string;
  entityType: EntityType;
  score: number;
  hardIdentityExact?: boolean;
  verifiedExternalId?: boolean;
  verifiedBarcode?: boolean;
  verifiedManufacturerSku?: boolean;
  contradictions?: string[];
  evidence: CandidateEvidence[];
}

export interface ResolutionInput {
  entityHint: EntityType | 'UNKNOWN';
  sourceCode: string;
  externalId?: { namespace: string; value: string; verified?: boolean };
  barcode?: { gtin14: string; checksumValid: boolean };
  manufacturerSku?: { manufacturer: string; sku: string; region?: string };
  languageCode?: string;
  regionCode?: string;
  setKey?: string;
  collectorNumber?: string;
  printingDiscriminator?: string;
  candidates: ResolutionCandidate[];
}

export interface ResolutionDecision {
  status: ResolutionStatus;
  matchedEntityId?: string;
  confidence: number;
  ruleId: string;
  candidates: ResolutionCandidate[];
  contradictions: string[];
}

export interface MarketSummary {
  entityId: string;
  currency: string;
  low?: number;
  center?: number;
  high?: number;
  trend30d?: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  freshness: 'FRESH' | 'AGING' | 'STALE' | 'ARCHIVAL' | 'UNAVAILABLE';
  computedAt?: string;
}

export interface HeatSummary {
  entityId: string;
  score?: number;
  classification: 'FROZEN' | 'COLD' | 'COOL' | 'WARM' | 'HOT' | 'SURGING' | 'UNAVAILABLE';
  trend?: 'HEATING_FAST' | 'HEATING' | 'STABLE' | 'COOLING' | 'COOLING_FAST';
  demandScore?: number;
  liquidityScore?: number;
  momentumScore?: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
}
