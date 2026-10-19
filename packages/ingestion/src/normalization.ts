import { createHash } from 'node:crypto';

export const NORMALIZATION_VERSION = 'norm-v1';

export function normalizeTextV1(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('und');
}

export interface NormalizedCollectorNumber {
  raw: string;
  normalized: string;
  numerator?: string;
  denominator?: string;
  suffix?: string;
}

export function normalizeCollectorNumberV1(raw: string): NormalizedCollectorNumber {
  const trimmed = raw.normalize('NFC').trim();
  const compact = trimmed.replace(/\s+/g, '').replace(/[‐‑‒–—]/g, '-').toLowerCase();
  const fraction = compact.match(/^([^/]+)\/([^/]+)$/);
  if (fraction) {
    return { raw, normalized: `${fraction[1]}/${fraction[2]}`, numerator: fraction[1], denominator: fraction[2] };
  }
  const suffix = compact.match(/^([0-9]+)([a-z-].*)$/i);
  return { raw, normalized: compact, numerator: suffix?.[1], suffix: suffix?.[2] };
}

/**
 * v0.3.1 — Cross-source collector-number comparison key. Sources disagree on zero padding
 * (TCGdex "33" vs TCGplayer "033/192"; TCGdex pads some sets but not others). The key strips
 * leading zeros from every digit run and whitespace, lowercases, and is used ONLY to compare
 * numbers across providers. It never replaces collector_number_normalized or canonical keys.
 * Mirrors SQL collector_number_match_key() in migration 0008.
 */
export function collectorNumberMatchKeyV1(value: string | null | undefined): string {
  if (value == null) return '';
  return String(value).normalize('NFC').replace(/\s+/g, '').toLowerCase().replace(/(^|[^0-9])0+([0-9])/g, '$1$2');
}

export function canonicalPayload(parts: Record<string, unknown>): string {
  return Object.keys(parts)
    .sort()
    .map(key => `${key}=${canonicalScalar(parts[key])}`)
    .join('|');
}

function canonicalScalar(value: unknown): string {
  if (value === undefined) return 'unknown';
  if (value === null) return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'invalid';
  return normalizeTextV1(String(value));
}

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface VersionedFingerprint {
  type: string;
  version: number;
  payload: string;
  sha256: string;
}

function fingerprint(type: string, version: number, parts: Record<string, unknown>): VersionedFingerprint {
  const payload = canonicalPayload(parts);
  return { type, version, payload, sha256: sha256Hex(payload) };
}

export function cardPrintingIdentityV1(input: {
  setIdentity: string;
  languageCode: string;
  collectorNumber: string;
  printingDiscriminator?: string;
}): VersionedFingerprint {
  return fingerprint('CARD_PRINTING_IDENTITY', 1, {
    set: input.setIdentity,
    language: input.languageCode,
    collector_number: normalizeCollectorNumberV1(input.collectorNumber).normalized,
    discriminator: input.printingDiscriminator ?? 'base'
  });
}

export function cardPrintingSearchV1(input: {
  setName: string;
  languageCode: string;
  collectorNumber: string;
  cardName: string;
}): VersionedFingerprint {
  return fingerprint('CARD_PRINTING_SEARCH', 1, {
    set_name: input.setName,
    language: input.languageCode,
    collector_number: normalizeCollectorNumberV1(input.collectorNumber).normalized,
    card_name: input.cardName
  });
}

export function cardVariantPhysicalV1(input: {
  printingId: string;
  finish?: string | null;
  foilPattern?: string | null;
  editionMark?: string | null;
  stamp?: string | null;
  textureType?: string | null;
}): VersionedFingerprint {
  return fingerprint('CARD_VARIANT_PHYSICAL', 1, {
    printing: input.printingId,
    finish: input.finish,
    foil_pattern: input.foilPattern,
    edition_mark: input.editionMark,
    stamp: input.stamp,
    texture: input.textureType
  });
}

export function sealedStructuralV1(input: {
  productType: string;
  productFamily: string;
  languageCode?: string | null;
  regionCode?: string | null;
  setContext?: string | null;
  packagingVariant?: string | null;
}): VersionedFingerprint {
  return fingerprint('SEALED_STRUCTURAL', 1, {
    product_type: input.productType,
    family: input.productFamily,
    language: input.languageCode,
    region: input.regionCode,
    set_context: input.setContext,
    packaging: input.packagingVariant ?? 'standard'
  });
}
