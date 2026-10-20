/**
 * v0.3.1 catalog policy — pure, deterministic rules for:
 *   - product medium (physical vs digital-only),
 *   - TCGdex variant plans (CARD_PRINTING -> CARD_VARIANT),
 *   - per-set readiness ladder,
 *   - visual-index / live-candidate-pool eligibility.
 *
 * Doctrine:
 *   - Market coverage may raise a set to MARKET_READY / LENS_READY for the product overlay, but it
 *     NEVER affects candidate-pool membership or visual-only lock permission. Identity eligibility
 *     is computed exclusively from identity + visual metrics.
 *   - Missing reference images are a false-lock hazard (the true card is absent, a neighbour may
 *     match). Sets with incomplete visual coverage therefore never permit visual-only locks.
 */
import { normalizeTextV1, sha256Hex } from './normalization.js';
import type { TcgdexCard } from './tcgdex.js';

export const CATALOG_POLICY_VERSION = 'catalog-policy-v0.3.1';

// ---------------------------------------------------------------------------------------------
// Product medium
// ---------------------------------------------------------------------------------------------

export type ProductMedium = 'PHYSICAL' | 'DIGITAL_ONLY';

/** TCGdex series that contain no physical cards (Pokémon TCG Pocket). */
export const DIGITAL_ONLY_TCGDEX_SERIES = Object.freeze(['tcgp']);

export function classifyTcgdexSetMedium(set: { serie?: { id?: string } } | undefined): ProductMedium {
  const serieId = set?.serie?.id?.toLowerCase();
  return serieId && DIGITAL_ONLY_TCGDEX_SERIES.includes(serieId) ? 'DIGITAL_ONLY' : 'PHYSICAL';
}

// ---------------------------------------------------------------------------------------------
// Release status
// ---------------------------------------------------------------------------------------------

export type ReleaseStatus = 'RELEASED' | 'UPCOMING' | 'PRERELEASE' | 'WITHDRAWN' | 'UNKNOWN';

/** Mirrors SQL card_set_release_status(). `asOf` is an ISO date (YYYY-MM-DD). */
export function releaseStatus(releaseDate: string | null | undefined, override: ReleaseStatus | null | undefined, asOf: string): ReleaseStatus {
  if (override) return override;
  if (!releaseDate) return 'UNKNOWN';
  return releaseDate.slice(0, 10) > asOf ? 'UPCOMING' : 'RELEASED';
}

// ---------------------------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------------------------

export interface TcgdexVariantDetail {
  type?: string;
  size?: string;
  stamp?: string[];
  foil?: string;
  subtype?: string;
  variantId?: string;
  thirdParty?: { cardmarket?: number; tcgplayer?: number };
}

export interface VariantPlan {
  variantCode: string;
  finish: string | null;
  sizeCode: string;
  stamp: string | null;
  foilPattern: string | null;
  editionMark: string | null;
  sourceVariantId: string | null;
  fingerprint: string;
  /** Marketplace IDs asserted by TCGdex. Provenance-only: never a verified mapping. */
  assertedCardmarketId: number | null;
  assertedTcgplayerId: number | null;
}

const FINISH_BY_TYPE: Record<string, string> = {
  normal: 'NON_HOLO',
  holo: 'HOLO',
  reverse: 'REVERSE_HOLO',
  lenticular: 'LENTICULAR',
  metal: 'METAL'
};

const FIRST_EDITION_STAMP = /^(1st edition|1re edition|1ere edition|first edition)$/;

function slug(value: string): string {
  return normalizeTextV1(value)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Deterministic variant plan. Prefers `variants_detailed` (stable variantId, stamps, size, foil);
 * falls back to the boolean `variants` flags. Same input always yields the same codes/fingerprints.
 */
export function buildTcgdexVariantPlan(card: Pick<TcgdexCard, 'variants'> & { variants_detailed?: TcgdexVariantDetail[] }): VariantPlan[] {
  const detailed = Array.isArray(card.variants_detailed) ? card.variants_detailed : [];
  const plans: VariantPlan[] = [];
  if (detailed.length) {
    for (const detail of detailed) {
      const typeSlug = slug(detail.type ?? 'unknown') || 'unknown';
      const sizeSlug = slug(detail.size ?? 'standard') || 'standard';
      const stamps = (detail.stamp ?? []).map(s => slug(s)).filter(Boolean).sort();
      const foilSlug = detail.foil ? slug(detail.foil) : '';
      const subtypeSlug = detail.subtype ? slug(detail.subtype) : '';
      const firstEdition = (detail.stamp ?? []).some(s => FIRST_EDITION_STAMP.test(normalizeTextV1(s).normalize('NFD').replace(/\p{Diacritic}/gu, '')));
      const parts = [typeSlug, sizeSlug !== 'standard' ? sizeSlug : '', ...stamps.map(s => `stamp-${s}`), foilSlug ? `foil-${foilSlug}` : '', subtypeSlug ? `sub-${subtypeSlug}` : ''].filter(Boolean);
      const variantCode = parts.join('+');
      plans.push({
        variantCode,
        finish: FINISH_BY_TYPE[typeSlug] ?? `OTHER:${typeSlug}`,
        sizeCode: sizeSlug.toUpperCase(),
        stamp: stamps.length ? stamps.join(',') : null,
        foilPattern: foilSlug || null,
        editionMark: firstEdition ? '1ST_EDITION' : null,
        sourceVariantId: detail.variantId ?? null,
        fingerprint: sha256Hex(`variant-v1|${variantCode}`),
        assertedCardmarketId: typeof detail.thirdParty?.cardmarket === 'number' ? detail.thirdParty.cardmarket : null,
        assertedTcgplayerId: typeof detail.thirdParty?.tcgplayer === 'number' ? detail.thirdParty.tcgplayer : null
      });
    }
  } else {
    const flags = (card.variants ?? {}) as Record<string, boolean>;
    const flagMap: Array<[string, string, string | null, string | null]> = [
      ['normal', 'normal', 'NON_HOLO', null],
      ['holo', 'holo', 'HOLO', null],
      ['reverse', 'reverse', 'REVERSE_HOLO', null],
      ['firstEdition', 'normal+stamp-1st-edition', 'NON_HOLO', '1ST_EDITION'],
      ['wPromo', 'normal+stamp-w-promo', 'NON_HOLO', null]
    ];
    for (const [flag, code, finish, edition] of flagMap) {
      if (!flags[flag]) continue;
      plans.push({
        variantCode: code, finish, sizeCode: 'STANDARD', stamp: flag === 'wPromo' ? 'w-promo' : flag === 'firstEdition' ? '1st-edition' : null,
        foilPattern: null, editionMark: edition, sourceVariantId: null, fingerprint: sha256Hex(`variant-v1|${code}`),
        assertedCardmarketId: null, assertedTcgplayerId: null
      });
    }
  }
  // Deduplicate by code (sources occasionally repeat an identical variant row).
  const byCode = new Map<string, VariantPlan>();
  for (const plan of plans) if (!byCode.has(plan.variantCode)) byCode.set(plan.variantCode, plan);
  return [...byCode.values()].sort((a, b) => a.variantCode.localeCompare(b.variantCode));
}

// ---------------------------------------------------------------------------------------------
// Readiness ladder
// ---------------------------------------------------------------------------------------------

export type Readiness = 'EXCLUDED' | 'DISCOVERED' | 'CATALOGUED' | 'IDENTITY_COMPLETE' | 'VISUAL_COMPLETE' | 'MARKET_READY' | 'LENS_READY';
export const READINESS_ORDER: readonly Readiness[] = Object.freeze(['EXCLUDED', 'DISCOVERED', 'CATALOGUED', 'IDENTITY_COMPLETE', 'VISUAL_COMPLETE', 'MARKET_READY', 'LENS_READY']);

export interface SetCoverageMetrics {
  expectedCards: number | null;
  canonicalPrintings: number;
  collectorNumberCovered: number;
  variantsCovered: number;
  imagesListed: number;
  imagesProbed: number;
  imagesOk: number;
  visualIndexEligible: number;
  cardmarketMapped: number;
  tcgplayerMapped: number;
  priced: number;
  openConflicts: number;
  quarantinedRecords: number;
}

export interface ReadinessThresholds {
  /** Fraction of canonical printings that must have a probed-OK reference image. */
  minImageOk: number;
  /** Fraction of canonical printings that must be visual-index eligible. */
  minVisualIndexed: number;
  /** Fraction of printings with at least one source-asserted variant. */
  minVariants: number;
  /** Best of Cardmarket / TCGplayer verified mapping fraction. */
  minMarketMapped: number;
  /** Fraction of printings with a fresh market observation. */
  minPriced: number;
}

export const DEFAULT_READINESS_THRESHOLDS: ReadinessThresholds = Object.freeze({
  minImageOk: 1,
  minVisualIndexed: 1,
  minVariants: 1,
  minMarketMapped: 0.9,
  minPriced: 0.8
});

export interface ReadinessResult {
  readiness: Readiness;
  /** Highest level reachable from identity + visual metrics only (market-independent). */
  identityVisualReadiness: Readiness;
  blockers: string[];
  ratios: Record<string, number | null>;
}

function ratio(n: number, d: number | null): number | null {
  return d && d > 0 ? n / d : null;
}

export function computeSetReadiness(input: {
  metrics: SetCoverageMetrics;
  releaseStatus: ReleaseStatus;
  productMedium: ProductMedium;
  thresholds?: ReadinessThresholds;
}): ReadinessResult {
  const t = input.thresholds ?? DEFAULT_READINESS_THRESHOLDS;
  const m = input.metrics;
  const p = m.canonicalPrintings;
  const ratios = {
    identity: ratio(p, m.expectedCards),
    collector: ratio(m.collectorNumberCovered, p),
    variants: ratio(m.variantsCovered, p),
    imagesListed: ratio(m.imagesListed, p),
    imagesOk: ratio(m.imagesOk, p),
    visualIndexed: ratio(m.visualIndexEligible, p),
    cardmarket: ratio(m.cardmarketMapped, p),
    tcgplayer: ratio(m.tcgplayerMapped, p),
    priced: ratio(m.priced, p)
  };
  const blockers: string[] = [];

  if (input.productMedium === 'DIGITAL_ONLY') {
    return { readiness: 'EXCLUDED', identityVisualReadiness: 'EXCLUDED', blockers: ['DIGITAL_ONLY_PRODUCT'], ratios };
  }
  if (input.releaseStatus === 'WITHDRAWN') {
    return { readiness: 'EXCLUDED', identityVisualReadiness: 'EXCLUDED', blockers: ['WITHDRAWN'], ratios };
  }

  let level: Readiness = 'DISCOVERED';
  if (p > 0) level = 'CATALOGUED';
  else blockers.push('NO_CANONICAL_PRINTINGS');

  const identityOk = p > 0
    && m.expectedCards != null
    && p >= m.expectedCards
    && m.collectorNumberCovered === p
    && m.openConflicts === 0;
  if (p > 0) {
    if (m.expectedCards == null) blockers.push('EXPECTED_CARD_COUNT_UNKNOWN');
    else if (p < m.expectedCards) blockers.push(`MISSING_PRINTINGS:${m.expectedCards - p}`);
    if (m.collectorNumberCovered < p) blockers.push(`MISSING_COLLECTOR_NUMBERS:${p - m.collectorNumberCovered}`);
    if (m.openConflicts > 0) blockers.push(`OPEN_CONFLICTS:${m.openConflicts}`);
  }
  if (level === 'CATALOGUED' && identityOk) level = 'IDENTITY_COMPLETE';

  const variantsOk = (ratios.variants ?? 0) >= t.minVariants;
  const imagesOk = (ratios.imagesOk ?? 0) >= t.minImageOk;
  const indexOk = (ratios.visualIndexed ?? 0) >= t.minVisualIndexed;
  if (p > 0) {
    if (!variantsOk) blockers.push(`MISSING_VARIANTS:${p - m.variantsCovered}`);
    if (m.imagesProbed < m.imagesListed) blockers.push(`IMAGES_NOT_PROBED:${m.imagesListed - m.imagesProbed}`);
    if (!imagesOk) blockers.push(`MISSING_OR_BROKEN_IMAGES:${p - m.imagesOk}`);
    if (!indexOk) blockers.push(`NOT_VISUALLY_INDEXED:${p - m.visualIndexEligible}`);
  }
  if (level === 'IDENTITY_COMPLETE' && variantsOk && imagesOk && indexOk) level = 'VISUAL_COMPLETE';
  const identityVisualReadiness = level;

  const marketMapped = Math.max(ratios.cardmarket ?? 0, ratios.tcgplayer ?? 0);
  const marketOk = marketMapped >= t.minMarketMapped && (ratios.priced ?? 0) >= t.minPriced;
  if (p > 0 && !marketOk) blockers.push('MARKET_COVERAGE_INSUFFICIENT');
  if (level === 'VISUAL_COMPLETE' && marketOk) level = 'MARKET_READY';

  if (input.releaseStatus !== 'RELEASED') blockers.push(`RELEASE_STATUS:${input.releaseStatus}`);
  if (level === 'MARKET_READY' && input.releaseStatus === 'RELEASED') level = 'LENS_READY';

  return { readiness: level, identityVisualReadiness, blockers, ratios };
}

// ---------------------------------------------------------------------------------------------
// Visual index + live candidate pool eligibility
// ---------------------------------------------------------------------------------------------

export interface PrintingEligibilityInput {
  productMedium: ProductMedium;
  releaseStatus: ReleaseStatus;
  entityActiveCanonical: boolean;
  hasOpenConflict: boolean;
  imageProbeOk: boolean | null;
  /** False when the source lists no reference image at all (distinct from an unprobed URL). */
  hasReferenceImage?: boolean;
  /** Set-level readiness from identity + visual metrics only. */
  setIdentityVisualReadiness: Readiness;
  includePrerelease?: boolean;
}

export interface PrintingEligibility {
  /** Usable as a visual reference (index build). */
  indexable: boolean;
  /** Part of the live candidate pool served to the Lens. */
  inLivePool: boolean;
  /** May lock on extreme visual-only consensus. False forces OCR / other corroboration. */
  visualOnlyLockAllowed: boolean;
  reason: string | null;
}

export function decidePrintingEligibility(input: PrintingEligibilityInput): PrintingEligibility {
  const reasons: string[] = [];
  if (input.productMedium !== 'PHYSICAL') reasons.push('DIGITAL_ONLY_PRODUCT');
  if (!input.entityActiveCanonical) reasons.push('NOT_ACTIVE_CANONICAL');
  if (input.hasOpenConflict) reasons.push('OPEN_CONFLICT');
  if (input.hasReferenceImage === false) reasons.push('NO_REFERENCE_IMAGE');
  else if (input.imageProbeOk === null) reasons.push('IMAGE_NOT_PROBED');
  else if (!input.imageProbeOk) reasons.push('IMAGE_MISSING_OR_BROKEN');
  const indexable = reasons.length === 0;

  const releasedForPool = input.releaseStatus === 'RELEASED'
    || (input.includePrerelease === true && (input.releaseStatus === 'PRERELEASE' || input.releaseStatus === 'UPCOMING'));
  if (indexable && !releasedForPool) reasons.push(`STAGED_${input.releaseStatus}`);
  const inLivePool = indexable && releasedForPool;

  const visualOnlyLockAllowed = inLivePool
    && input.releaseStatus === 'RELEASED'
    && READINESS_ORDER.indexOf(input.setIdentityVisualReadiness) >= READINESS_ORDER.indexOf('VISUAL_COMPLETE');

  return { indexable, inLivePool, visualOnlyLockAllowed, reason: reasons[0] ?? null };
}

// ---------------------------------------------------------------------------------------------
// Artwork twins (reprints / classic collections)
// ---------------------------------------------------------------------------------------------

/**
 * Printings in the same language with the same normalized name and the same illustrator are
 * treated as probable artwork twins (reprints, classic collections). A twin that is absent from the
 * visual index cannot be told apart visually, and reprints may carry the original printed number,
 * so OCR cannot disambiguate either.
 *
 *   - any unindexed twin  -> the candidate may never lock (`lockBlockedReason`)
 *   - any twin            -> no visual-only lock (printed-number corroboration required)
 */
export function artworkTwinKey(input: { languageCode: string; name: string; illustrator: string | null | undefined }): string | null {
  const illustrator = input.illustrator ? normalizeTextV1(input.illustrator) : '';
  if (!illustrator || illustrator === 'unknown') return null;
  return `${input.languageCode}|${normalizeTextV1(input.name)}|${illustrator}`;
}

export interface ArtworkTwinPolicyResult {
  visualOnlyLockAllowed: boolean;
  lockBlockedReason: string | null;
}

export function applyArtworkTwinPolicy(eligibility: PrintingEligibility, twins: { total: number; unindexed: number }): ArtworkTwinPolicyResult {
  if (!eligibility.inLivePool) return { visualOnlyLockAllowed: false, lockBlockedReason: null };
  if (twins.unindexed > 0) return { visualOnlyLockAllowed: false, lockBlockedReason: 'UNINDEXED_ARTWORK_TWIN' };
  if (twins.total > 0) return { visualOnlyLockAllowed: false, lockBlockedReason: null };
  return { visualOnlyLockAllowed: eligibility.visualOnlyLockAllowed, lockBlockedReason: null };
}
