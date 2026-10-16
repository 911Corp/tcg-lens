import { createHash } from 'node:crypto';
import { normalizeTextV1 } from './normalization.js';
import type { NormalizedCardmarketProduct } from './cardmarket.js';
import type { NormalizedTcgcsvProduct } from './tcgcsv.js';

export type SealedProductType =
  | 'ETB' | 'BOOSTER_BOX' | 'BOOSTER_PACK' | 'BOOSTER_BUNDLE' | 'BLISTER'
  | 'TIN' | 'COLLECTION_BOX' | 'DECK' | 'CASE' | 'DISPLAY' | 'OTHER';

export interface NormalizedSealedProduct {
  sourceCode: 'cardmarket' | 'tcgcsv';
  originSourceCode: 'cardmarket' | 'tcgplayer';
  externalKey: string;
  name: string;
  normalizedName: string;
  productType: SealedProductType;
  languageCode?: string;
  regionCode?: string;
  setHint?: string;
  normalizedSetHint?: string;
  manufacturer?: string;
  manufacturerSku?: string;
  imageUrl?: string;
  structuralPayload: string;
  structuralFingerprint: string;
  matchingPayload: string;
  matchingFingerprint: string;
  raw: unknown;
}

export function normalizeCardmarketSealed(product: NormalizedCardmarketProduct): NormalizedSealedProduct | undefined {
  if (product.productGroup !== 'non_single') return undefined;
  const productType = classifySealedProduct(product.name, product.categoryName);
  if (!productType) return undefined;
  const setHint = product.expansionName;
  return finalize({
    sourceCode: 'cardmarket', originSourceCode: 'cardmarket', externalKey: product.externalKey,
    name: product.name, normalizedName: normalizeTextV1(product.name), productType,
    setHint, normalizedSetHint: setHint ? normalizeSetHint(setHint) : undefined,
    raw: product.raw
  });
}

export function normalizeTcgcsvSealed(product: NormalizedTcgcsvProduct): NormalizedSealedProduct | undefined {
  if (product.collectorNumberNormalized) return undefined;
  const productType = classifySealedProduct(product.name);
  if (!productType) return undefined;
  return finalize({
    sourceCode: 'tcgcsv', originSourceCode: 'tcgplayer', externalKey: product.externalKey,
    name: product.name, normalizedName: product.normalizedName, productType,
    languageCode: product.languageCode,
    setHint: product.groupName, normalizedSetHint: normalizeSetHint(product.groupName),
    imageUrl: product.imageUrl, raw: product.raw
  });
}

export function classifySealedProduct(name: string, categoryName?: string): SealedProductType | undefined {
  const n = normalizeTextV1(`${name} ${categoryName ?? ''}`);
  if (/code card|online code|redeem/i.test(n)) return undefined;
  if (/elite trainer box|\betb\b/i.test(n)) return 'ETB';
  if (/booster bundle/i.test(n)) return 'BOOSTER_BUNDLE';
  if (/booster box|display box|36 booster|24 booster|20 booster|30 booster/i.test(n)) return 'BOOSTER_BOX';
  if (/booster pack|single booster|sleeved booster/i.test(n)) return 'BOOSTER_PACK';
  if (/blister/i.test(n)) return 'BLISTER';
  if (/\btin\b|mini tin/i.test(n)) return 'TIN';
  if (/collection box|collection set|premium collection|poster collection|binder collection|box set/i.test(n)) return 'COLLECTION_BOX';
  if (/theme deck|battle deck|starter deck|league battle deck|ex battle deck|deck/i.test(n)) return 'DECK';
  if (/sealed case|case of|case \(/i.test(n)) return 'CASE';
  if (/display/i.test(n)) return 'DISPLAY';
  if (/booster|sealed|box|bundle|collection|tin|deck/i.test(n)) return 'OTHER';
  return undefined;
}

export function sealedStructuralPayload(input: {
  productType: SealedProductType; normalizedName: string; languageCode?: string; regionCode?: string; normalizedSetHint?: string;
}): string {
  return [
    'sealed-structural-v1',
    `type=${input.productType}`,
    `name=${input.normalizedName}`,
    `lang=${input.languageCode ?? 'unknown'}`,
    `region=${input.regionCode ?? 'unknown'}`,
    `set=${input.normalizedSetHint ?? 'unknown'}`
  ].join('|');
}

function finalize<T extends Omit<NormalizedSealedProduct, 'structuralPayload' | 'structuralFingerprint' | 'matchingPayload' | 'matchingFingerprint'>>(input: T): NormalizedSealedProduct {
  const structuralPayload = sealedStructuralPayload(input);
  const structuralFingerprint = createHash('sha256').update(structuralPayload).digest('hex');
  const matchingPayload = ['sealed-match-v1', `type=${input.productType}`, `name=${canonicalSealedName(input.normalizedName)}`, `set=${input.normalizedSetHint ?? 'unknown'}`].join('|');
  const matchingFingerprint = createHash('sha256').update(matchingPayload).digest('hex');
  return { ...input, structuralPayload, structuralFingerprint, matchingPayload, matchingFingerprint };
}

function canonicalSealedName(value: string): string {
  return value
    .replace(/pokemon trading card game|pokemon tcg|pokemon card game|pokemon/g, ' ')
    .replace(/elite trainer box/g, ' etb ')
    .replace(/booster display box|display box/g, ' booster box ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSetHint(value: string): string {
  return normalizeTextV1(value).replace(/^pokemon\s+/u, '').replace(/^[a-z0-9.-]+:\s*/u, '').trim();
}
