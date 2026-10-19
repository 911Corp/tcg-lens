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
import { normalizeTextV1 } from './normalization.js';

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
