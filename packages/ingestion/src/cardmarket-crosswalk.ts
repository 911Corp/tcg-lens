/**
 * v0.3.1 — Cardmarket <-> canonical printing crosswalk.
 *
 * The public Cardmarket product catalog (products_singles_6.json) carries no collector number and
 * no expansion name (only idProduct, name, idExpansion, idMetacard), so number-based enrichment
 * cannot map real products. TCGdex asserts a Cardmarket idProduct per variant. An assertion becomes
 * a VERIFIED mapping only when the Cardmarket catalog independently confirms it.
 *
 * Market mapping never participates in identity resolution.
 */
import { collectorNumberMatchKeyV1, normalizeTextV1 } from './normalization.js';

export const CARDMARKET_SINGLE_CATEGORY = 51;

export interface CrosswalkPrinting {
  entityId: string;
  languageCode: string;
  name: string;
  /** Name of the EN printing sharing the TCGdex card id, when the printing is not EN. */
  englishSiblingName?: string | null;
  /** True when the EN sibling asserts the same Cardmarket product. */
  englishSiblingAssertsSameProduct?: boolean;
}

export interface CrosswalkProduct {
  idProduct: number;
  name: string;
  idCategory?: number;
  idExpansion?: number;
}

export interface CrosswalkContext {
  /** Most common idExpansion among confirmed products of the printing's set (same language). */
  setExpansionMode: number | null;
  /** Share of the set's found products that carry setExpansionMode (0..1). */
  setExpansionModeShare: number;
  /** Number of distinct printings in the same language asserting this idProduct. */
  printingsAssertingSameProductInLanguage: number;
}

export interface CrosswalkDecision {
  status: 'AUTO_MATCH' | 'CANDIDATE_MATCH' | 'CONFLICT';
  ruleId: string;
  confidence: number;
}

/** "Charizard ex [Energy Flame | Slash]" -> "charizard ex"; also drops "(V.2)" and "Lv.27" suffixes. */
export function cardmarketBaseName(name: string): string {
  return normalizeTextV1(name
    .replace(/\s*\[[^\]]*\]\s*$/u, '')        // attack names
    .replace(/\s*\(V\.\s*\d+\)\s*$/iu, '')     // (V.2) duplicates
    .replace(/\s+Lv\.\s?\d+\s*$/iu, ''));        // DP/Platinum-era level suffix
}

export function decideCardmarketCrosswalk(printing: CrosswalkPrinting, product: CrosswalkProduct | undefined, context: CrosswalkContext): CrosswalkDecision {
  if (!product) return { status: 'CANDIDATE_MATCH', ruleId: 'CM_XWALK_PRODUCT_NOT_IN_CATALOG', confidence: 0.2 };
  if (product.idCategory != null && product.idCategory !== CARDMARKET_SINGLE_CATEGORY) {
    return { status: 'CONFLICT', ruleId: 'CM_XWALK_NOT_A_SINGLE', confidence: 1 };
  }
  if (context.printingsAssertingSameProductInLanguage > 1) {
    return { status: 'CANDIDATE_MATCH', ruleId: 'CM_XWALK_PRODUCT_CLAIMED_BY_MULTIPLE_PRINTINGS', confidence: 0.5 };
  }
  const base = cardmarketBaseName(product.name);
  const reference = printing.languageCode === 'en' ? printing.name : printing.englishSiblingName ?? null;
  if (!reference) return { status: 'CANDIDATE_MATCH', ruleId: 'CM_XWALK_NO_ENGLISH_REFERENCE_NAME', confidence: 0.4 };
  if (printing.languageCode !== 'en' && printing.englishSiblingAssertsSameProduct !== true) {
    return { status: 'CANDIDATE_MATCH', ruleId: 'CM_XWALK_ENGLISH_SIBLING_DISAGREES', confidence: 0.4 };
  }
  if (normalizeTextV1(reference) !== base) {
    return { status: 'CONFLICT', ruleId: 'CM_XWALK_NAME_MISMATCH', confidence: 1 };
  }
  if (context.setExpansionMode != null && product.idExpansion != null && product.idExpansion !== context.setExpansionMode && context.setExpansionModeShare >= 0.8) {
    return { status: 'CANDIDATE_MATCH', ruleId: 'CM_XWALK_EXPANSION_INCONSISTENT', confidence: 0.6 };
  }
  return { status: 'AUTO_MATCH', ruleId: printing.languageCode === 'en' ? 'CM_XWALK_TCGDEX_ID_NAME_CONFIRMED' : 'CM_XWALK_TCGDEX_ID_EN_SIBLING_CONFIRMED', confidence: 0.96 };
}

// ---------------------------------------------------------------------------------------------
// TCGplayer (via TCGCSV) crosswalk
// ---------------------------------------------------------------------------------------------

export interface TcgplayerCrosswalkPrinting {
  entityId: string;
  languageCode: string;
  name: string;
  collectorNumber: string;
}

export interface TcgplayerCrosswalkProduct {
  productId: number;
  languageCode: string;
  name: string;
  collectorNumber?: string | null;
  groupId: number;
}

export interface TcgplayerCrosswalkContext {
  setGroupMode: number | null;
  setGroupModeShare: number;
  printingsAssertingSameProductInLanguage: number;
}

/**
 * TCGplayer cleanName drops punctuation and often appends the collector number / printed total
 * ("Glimmet 125 193", "Pikachu SM162"). Strip only trailing number tokens equal to the (already
 * verified) collector number or purely numeric; variant words ("Master Ball Pattern",
 * "Prerelease Staff") are kept, so those products stay unmatched at printing level.
 */
export function tcgplayerComparableName(name: string, collectorNumber?: string | null): string {
  const tokens = normalizeTextV1(name)
    .replace(/♀/g, ' f').replace(/♂/g, ' m')
    .replace(/['’`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(' ').filter(Boolean);
  const key = collectorNumberMatchKeyV1(collectorNumber ?? '');
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (/^\d+$/.test(last) || (key && collectorNumberMatchKeyV1(last) === key)) tokens.pop();
    else break;
  }
  return tokens.join(' ');
}

/**
 * TCGdex asserts a TCGplayer productId per variant. A mapping is VERIFIED only if the staged TCGCSV
 * product is in the same language scope (TCGplayer EN products never price FR printings), carries
 * the same collector number, belongs to the set's consistent TCGplayer group, is claimed by a single
 * printing, and (EN only) has the same name. JA names are English on TCGplayer, so JA relies on
 * number + group consistency.
 */
export function decideTcgplayerCrosswalk(printing: TcgplayerCrosswalkPrinting, product: TcgplayerCrosswalkProduct | undefined, context: TcgplayerCrosswalkContext): CrosswalkDecision {
  if (!product) return { status: 'CANDIDATE_MATCH', ruleId: 'TP_XWALK_PRODUCT_NOT_STAGED', confidence: 0.2 };
  if (product.languageCode !== printing.languageCode) return { status: 'CANDIDATE_MATCH', ruleId: 'TP_XWALK_LANGUAGE_SCOPE_MISMATCH', confidence: 0.3 };
  if (context.printingsAssertingSameProductInLanguage > 1) return { status: 'CANDIDATE_MATCH', ruleId: 'TP_XWALK_PRODUCT_CLAIMED_BY_MULTIPLE_PRINTINGS', confidence: 0.5 };
  if (!product.collectorNumber) return { status: 'CANDIDATE_MATCH', ruleId: 'TP_XWALK_PRODUCT_WITHOUT_NUMBER', confidence: 0.4 };
  if (collectorNumberMatchKeyV1(product.collectorNumber) !== collectorNumberMatchKeyV1(printing.collectorNumber)) {
    return { status: 'CONFLICT', ruleId: 'TP_XWALK_NUMBER_MISMATCH', confidence: 1 };
  }
  if (context.setGroupMode != null && product.groupId !== context.setGroupMode && context.setGroupModeShare >= 0.8) {
    return { status: 'CANDIDATE_MATCH', ruleId: 'TP_XWALK_GROUP_INCONSISTENT', confidence: 0.6 };
  }
  if (printing.languageCode === 'en') {
    return tcgplayerComparableName(product.name, printing.collectorNumber) === tcgplayerComparableName(printing.name, printing.collectorNumber)
      ? { status: 'AUTO_MATCH', ruleId: 'TP_XWALK_ID_NUMBER_NAME_CONFIRMED', confidence: 0.97 }
      : { status: 'CANDIDATE_MATCH', ruleId: 'TP_XWALK_NAME_DIFFERS', confidence: 0.6 };
  }
  return { status: 'AUTO_MATCH', ruleId: 'TP_XWALK_ID_NUMBER_GROUP_CONFIRMED', confidence: 0.93 };
}
