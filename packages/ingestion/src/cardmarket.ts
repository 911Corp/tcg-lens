import { normalizeCollectorNumberV1, normalizeTextV1 } from './normalization.js';

export const CARDMARKET_POKEMON_GAME_ID = 6;
export const CARDMARKET_PRODUCTS_SINGLES_URL = `https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_${CARDMARKET_POKEMON_GAME_ID}.json`;
export const CARDMARKET_PRODUCTS_NONSINGLES_URL = `https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_${CARDMARKET_POKEMON_GAME_ID}.json`;
export const CARDMARKET_PRICE_GUIDE_URL = `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_${CARDMARKET_POKEMON_GAME_ID}.json`;

export interface CardmarketProductsFile {
  version?: number;
  createdAt?: string;
  products: CardmarketProduct[];
}

export interface CardmarketProduct {
  idProduct: number;
  name: string;
  idCategory?: number;
  categoryName?: string;
  idExpansion?: number;
  expansionName?: string;
  idMetacard?: number;
  dateAdded?: string;
  number?: string | number;
  rarity?: string;
  [key: string]: unknown;
}

export interface CardmarketPriceGuideFile {
  version?: number;
  createdAt?: string;
  priceGuides: CardmarketPriceGuide[];
}

export interface CardmarketPriceGuide {
  idProduct: number;
  idCategory?: number;
  avg?: number | null;
  low?: number | null;
  trend?: number | null;
  avg1?: number | null;
  avg7?: number | null;
  avg30?: number | null;
  'avg-holo'?: number | null;
  'low-holo'?: number | null;
  'trend-holo'?: number | null;
  'avg1-holo'?: number | null;
  'avg7-holo'?: number | null;
  'avg30-holo'?: number | null;
  [key: string]: unknown;
}

export interface NormalizedCardmarketProduct {
  sourceCode: 'cardmarket';
  namespace: 'products';
  externalKey: string;
  idProduct: number;
  productGroup: 'single' | 'non_single';
  name: string;
  normalizedName: string;
  collectorNumberRaw?: string;
  collectorNumberNormalized?: string;
  expansionId?: number;
  expansionName?: string;
  normalizedExpansionName?: string;
  categoryId?: number;
  categoryName?: string;
  metacardId?: number;
  rarity?: string;
  dateAdded?: string;
  raw: CardmarketProduct;
}

export interface NormalizedCardmarketPrice {
  sourceCode: 'cardmarket';
  namespace: 'prices';
  externalKey: string;
  idProduct: number;
  categoryId?: number;
  observedAt: string;
  currency: 'EUR';
  metrics: Array<{ metricType: string; amount: number; precisionScope: 'PRODUCT_LEVEL'; metadata?: Record<string, unknown> }>;
  raw: CardmarketPriceGuide;
}

export class CardmarketClient {
  constructor(private readonly urls = {
    singles: CARDMARKET_PRODUCTS_SINGLES_URL,
    nonSingles: CARDMARKET_PRODUCTS_NONSINGLES_URL,
    prices: CARDMARKET_PRICE_GUIDE_URL
  }) {}

  async fetchSingles(signal?: AbortSignal): Promise<CardmarketProductsFile> {
    return this.getJson<CardmarketProductsFile>(this.urls.singles, signal);
  }

  async fetchNonSingles(signal?: AbortSignal): Promise<CardmarketProductsFile> {
    return this.getJson<CardmarketProductsFile>(this.urls.nonSingles, signal);
  }

  async fetchPrices(signal?: AbortSignal): Promise<CardmarketPriceGuideFile> {
    return this.getJson<CardmarketPriceGuideFile>(this.urls.prices, signal);
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, {
      signal,
      headers: { accept: 'application/json', 'user-agent': 'TCGLens/0.1 (+data-ingestion)' }
    });
    if (!response.ok) throw new Error(`Cardmarket ${response.status} for ${url}`);
    return response.json() as Promise<T>;
  }
}

export function normalizeCardmarketProduct(product: CardmarketProduct, productGroup: 'single' | 'non_single'): NormalizedCardmarketProduct {
  const rawNumber = product.number == null ? undefined : String(product.number);
  const parsedFromName = productGroup === 'single' && !rawNumber ? inferCollectorNumberFromName(product.name) : undefined;
  const collectorRaw = rawNumber ?? parsedFromName;
  return {
    sourceCode: 'cardmarket',
    namespace: 'products',
    externalKey: String(product.idProduct),
    idProduct: product.idProduct,
    productGroup,
    name: product.name,
    normalizedName: normalizeCardmarketName(product.name, collectorRaw ? localCollectorNumber(collectorRaw) : undefined),
    collectorNumberRaw: collectorRaw,
    collectorNumberNormalized: collectorRaw ? localCollectorNumber(collectorRaw) : undefined,
    expansionId: product.idExpansion,
    expansionName: product.expansionName,
    normalizedExpansionName: product.expansionName ? normalizeTextV1(product.expansionName) : undefined,
    categoryId: product.idCategory,
    categoryName: product.categoryName,
    metacardId: product.idMetacard,
    rarity: product.rarity,
    dateAdded: product.dateAdded,
    raw: product
  };
}

export function normalizeCardmarketPrice(price: CardmarketPriceGuide, createdAt?: string): NormalizedCardmarketPrice {
  const metrics: NormalizedCardmarketPrice['metrics'] = [];
  const add = (field: keyof CardmarketPriceGuide, metricType: string, variant: 'standard' | 'holo' = 'standard') => {
    const value = price[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      metrics.push({ metricType, amount: value, precisionScope: 'PRODUCT_LEVEL', metadata: { cardmarket_variant: variant, source_field: field } });
    }
  };
  add('avg', 'LISTING_AVERAGE');
  add('low', 'LISTING_LOW');
  add('trend', 'TREND');
  add('avg1', 'AVG_1D');
  add('avg7', 'AVG_7D');
  add('avg30', 'AVG_30D');
  add('avg-holo', 'LISTING_AVERAGE', 'holo');
  add('low-holo', 'LISTING_LOW', 'holo');
  add('trend-holo', 'TREND', 'holo');
  add('avg1-holo', 'AVG_1D', 'holo');
  add('avg7-holo', 'AVG_7D', 'holo');
  add('avg30-holo', 'AVG_30D', 'holo');
  return {
    sourceCode: 'cardmarket',
    namespace: 'prices',
    externalKey: String(price.idProduct),
    idProduct: price.idProduct,
    categoryId: price.idCategory,
    observedAt: normalizeTimestamp(createdAt),
    currency: 'EUR',
    metrics,
    raw: price
  };
}

function normalizeTimestamp(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function inferCollectorNumberFromName(name: string): string | undefined {
  // Cardmarket display/catalog names commonly end with a parenthesized set-code + number.
  // Example: "Pikachu (30C 025)". We only use the final token as a candidate key.
  const match = name.match(/\((?:[^()]*)\s([A-Za-z0-9-]+)\)\s*$/u);
  return match?.[1];
}

function normalizeCardmarketName(name: string, collector?: string): string {
  let candidate = name;
  if (collector) {
    candidate = candidate.replace(new RegExp(`\\s*\\([^()]*\\s${escapeRegExp(collector)}\\)\\s*$`, 'iu'), '');
  }
  return normalizeTextV1(candidate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localCollectorNumber(raw: string): string {
  const parsed = normalizeCollectorNumberV1(raw);
  return parsed.denominator && parsed.numerator ? parsed.numerator : parsed.normalized;
}
