import { normalizeTextV1, sha256Hex, type VersionedFingerprint } from './normalization.js';
import type { NormalizedTcgdexCard, TcgdexLanguage } from './tcgdex.js';

export const TCGDEX_BOOTSTRAP_VERSION = 'tcgdex-bootstrap-v0.1';

export interface TcgdexSetPlan {
  canonicalKey: string;
  languageCode: TcgdexLanguage;
  externalId: string;
  officialName: string;
  officialSetCode: string;
  printedCardCount?: number;
  totalCardCount?: number;
}

export interface TcgdexAssertionPlan {
  fieldPath: string;
  value: unknown;
  normalizedValue: unknown;
  confidence: number;
  valueHashHex: string;
}

export interface TcgdexCanonicalPlan {
  sourceCode: 'tcgdex';
  sourceNamespace: 'cards';
  scopeLanguageCode: TcgdexLanguage;
  externalCardId: string;
  set: TcgdexSetPlan;
  cardCanonicalKey: string;
  printingDiscriminator: 'base';
  name: string;
  normalizedName: string;
  collectorNumberRaw: string;
  collectorNumberNormalized: string;
  rarity?: string;
  illustrator?: string;
  imageUrl?: string;
  fingerprints: VersionedFingerprint[];
  aliases: Array<{ languageCode: TcgdexLanguage; raw: string; normalized: string; aliasType: 'PRIMARY_NAME' }>;
  assertions: TcgdexAssertionPlan[];
}

export function buildTcgdexCanonicalPlan(card: NormalizedTcgdexCard): TcgdexCanonicalPlan {
  if (!card.setExternalId || !card.setName) {
    throw new Error(`TCGdex card ${card.externalKey} cannot be promoted without set id/name`);
  }

  const setKeyPart = canonicalKeyPart(card.setExternalId);
  const numberKeyPart = canonicalKeyPart(card.collectorNumberNormalized);
  const setCardCount = (card.raw.set as { cardCount?: { official?: number; total?: number } } | undefined)?.cardCount;
  const fingerprints = [card.identityFingerprint, card.searchFingerprint].filter(Boolean) as VersionedFingerprint[];

  const assertionValues: Array<[string, unknown, unknown, number]> = [
    ['name', card.name, card.normalizedName, 0.98],
    ['language_code', card.languageCode, card.languageCode, 1],
    ['collector_number_raw', card.collectorNumberRaw, card.collectorNumberRaw, 1],
    ['collector_number_normalized', card.collectorNumberNormalized, card.collectorNumberNormalized, 1],
    ['set_external_id', card.setExternalId, card.setExternalId, 1]
  ];
  if (card.rarity) assertionValues.push(['rarity', card.rarity, normalizeTextV1(card.rarity), 0.95]);
  if (card.illustrator) assertionValues.push(['illustrator', card.illustrator, normalizeTextV1(card.illustrator), 0.95]);
  if (card.imageUrl) assertionValues.push(['image_url', card.imageUrl, card.imageUrl, 0.9]);

  return {
    sourceCode: 'tcgdex',
    sourceNamespace: 'cards',
    scopeLanguageCode: card.languageCode,
    externalCardId: card.externalKey,
    set: {
      canonicalKey: `set:${card.languageCode}:${setKeyPart}`,
      languageCode: card.languageCode,
      externalId: card.setExternalId,
      officialName: card.setName,
      officialSetCode: card.setExternalId,
      printedCardCount: setCardCount?.official,
      totalCardCount: setCardCount?.total
    },
    cardCanonicalKey: `card:${card.languageCode}:${setKeyPart}:${numberKeyPart}:base`,
    printingDiscriminator: 'base',
    name: card.name,
    normalizedName: card.normalizedName,
    collectorNumberRaw: card.collectorNumberRaw,
    collectorNumberNormalized: card.collectorNumberNormalized,
    rarity: card.rarity,
    illustrator: card.illustrator,
    imageUrl: card.imageUrl,
    fingerprints,
    aliases: [{ languageCode: card.languageCode, raw: card.name, normalized: card.normalizedName, aliasType: 'PRIMARY_NAME' }],
    assertions: assertionValues.map(([fieldPath, value, normalizedValue, confidence]) => ({
      fieldPath,
      value,
      normalizedValue,
      confidence,
      valueHashHex: hashAssertion(fieldPath, normalizedValue)
    }))
  };
}

export function tcgdexScopedExternalIdentity(language: TcgdexLanguage, namespace: 'cards' | 'sets', externalValue: string): string {
  return `tcgdex|${namespace}|${language}|${externalValue}`;
}

function hashAssertion(fieldPath: string, normalizedValue: unknown): string {
  return sha256Hex(`${fieldPath}|${stableJson(normalizedValue)}`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function canonicalKeyPart(value: string): string {
  const normalized = normalizeTextV1(value)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length > 0) return normalized;
  return sha256Hex(value).slice(0, 16);
}
