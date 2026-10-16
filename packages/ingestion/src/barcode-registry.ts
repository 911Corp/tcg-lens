import { normalizeBarcode, type BarcodeScheme } from './gtin.js';

export interface NormalizedBarcodeClaim {
  scheme: BarcodeScheme;
  rawValue: string;
  gtin14: string;
  checksumValid: boolean;
  sourceExternalValue?: string;
  entityId?: string;
  confidence: number;
  evidence?: Record<string, unknown>;
}

export function detectBarcodeScheme(raw: string): BarcodeScheme {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12) return 'UPC_A';
  if (digits.length === 13) return digits.startsWith('45') || digits.startsWith('49') ? 'JAN_13' : 'EAN_13';
  return 'GTIN_14';
}

export function normalizeBarcodeClaim(input: {
  rawValue: string;
  sourceExternalValue?: string;
  entityId?: string;
  confidence?: number;
  evidence?: Record<string, unknown>;
}): NormalizedBarcodeClaim {
  const normalized = normalizeBarcode(input.rawValue);
  if (!normalized) throw new Error(`Unsupported barcode length: ${input.rawValue}`);
  return {
    scheme: detectBarcodeScheme(input.rawValue), rawValue: input.rawValue,
    gtin14: normalized.gtin14, checksumValid: normalized.checksumValid,
    sourceExternalValue: input.sourceExternalValue, entityId: input.entityId,
    confidence: input.confidence ?? (normalized.checksumValid ? 0.8 : 0.1), evidence: input.evidence
  };
}
