import { normalizeCollectorNumberV1, normalizeTextV1 } from './normalization.js';

export const TCGCSV_BASE_URL = 'https://tcgcsv.com/tcgplayer';
export const TCGCSV_POKEMON_CATEGORY = 3;
export const TCGCSV_POKEMON_JAPAN_CATEGORY = 85;

export interface TcgcsvEnvelope<T> {
  totalItems?: number;
  success: boolean;
  errors?: unknown[];
  results: T[];
}

export interface TcgcsvGroup {
  groupId: number;
  name: string;
  abbreviation?: string;
  categoryId: number;
  publishedOn?: string;
  modifiedOn?: string;
}

export interface TcgcsvExtendedData { name: string; displayName?: string; value: string }
export interface TcgcsvProduct {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string;
  categoryId: number;
  groupId: number;
  url?: string;
  modifiedOn?: string;
  extendedData?: TcgcsvExtendedData[];
  [key: string]: unknown;
}

export interface TcgcsvPrice {
  productId: number;
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
  marketPrice?: number | null;
  directLowPrice?: number | null;
  subTypeName?: string;
  [key: string]: unknown;
}

export type TcgcsvLanguage = 'en' | 'ja';

export interface NormalizedTcgcsvProduct {
  sourceCode: 'tcgcsv';
  originSourceCode: 'tcgplayer';
  namespace: 'products';
  externalKey: string;
  productId: number;
  categoryId: number;
  groupId: number;
  groupName: string;
  groupAbbreviation?: string;
  languageCode: TcgcsvLanguage;
  name: string;
  normalizedName: string;
  collectorNumberRaw?: string;
  collectorNumberNormalized?: string;
  rarity?: string;
  imageUrl?: string;
  raw: TcgcsvProduct;
}

export interface NormalizedTcgcsvPrice {
  sourceCode: 'tcgcsv';
  originSourceCode: 'tcgplayer';
  namespace: 'prices';
  externalKey: string;
  productId: number;
  languageCode: TcgcsvLanguage;
  subtype: string;
  observedAt: string;
  currency: 'USD';
  metrics: Array<{ metricType: string; amount: number; precisionScope: 'PRINTING_LEVEL'; metadata: Record<string, unknown> }>;
  raw: TcgcsvPrice;
}

export class TcgcsvClient {
  constructor(private readonly baseUrl = TCGCSV_BASE_URL) {}

  async listGroups(categoryId: number, signal?: AbortSignal): Promise<TcgcsvGroup[]> {
    return (await this.get<TcgcsvGroup>(`${this.baseUrl}/${categoryId}/groups`, signal)).results;
  }

  async listProducts(categoryId: number, groupId: number, signal?: AbortSignal): Promise<TcgcsvProduct[]> {
    return (await this.get<TcgcsvProduct>(`${this.baseUrl}/${categoryId}/${groupId}/products`, signal)).results;
  }

  async listPrices(categoryId: number, groupId: number, signal?: AbortSignal): Promise<TcgcsvPrice[]> {
    return (await this.get<TcgcsvPrice>(`${this.baseUrl}/${categoryId}/${groupId}/prices`, signal)).results;
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<TcgcsvEnvelope<T>> {
    const response = await fetch(url, {
      signal,
      headers: { accept: 'application/json', 'user-agent': 'TCGLens/0.1 (+data-ingestion)' }
    });
    if (!response.ok) throw new Error(`TCGCSV ${response.status} for ${url}`);
    const body = await response.json() as TcgcsvEnvelope<T>;
    if (!body.success) throw new Error(`TCGCSV unsuccessful response for ${url}: ${JSON.stringify(body.errors ?? [])}`);
    return body;
  }
}

export function tcgcsvLanguageForCategory(categoryId: number): TcgcsvLanguage {
  if (categoryId === TCGCSV_POKEMON_JAPAN_CATEGORY) return 'ja';
  return 'en';
}

export function normalizeTcgcsvProduct(group: TcgcsvGroup, product: TcgcsvProduct): NormalizedTcgcsvProduct {
  const languageCode = tcgcsvLanguageForCategory(product.categoryId);
  const number = extended(product.extendedData, ['Number', 'Card Number', 'Collector Number']);
  const rarity = extended(product.extendedData, ['Rarity']);
  return {
    sourceCode: 'tcgcsv',
    originSourceCode: 'tcgplayer',
    namespace: 'products',
    externalKey: String(product.productId),
    productId: product.productId,
    categoryId: product.categoryId,
    groupId: product.groupId,
    groupName: group.name,
    groupAbbreviation: group.abbreviation,
    languageCode,
    name: product.cleanName ?? product.name,
    normalizedName: normalizeTextV1(product.cleanName ?? product.name),
    collectorNumberRaw: number,
    collectorNumberNormalized: number ? localCollectorNumber(number) : undefined,
    rarity,
    imageUrl: product.imageUrl,
    raw: product
  };
}

export function normalizeTcgcsvPrice(categoryId: number, price: TcgcsvPrice, observedAt = new Date().toISOString()): NormalizedTcgcsvPrice {
  const languageCode = tcgcsvLanguageForCategory(categoryId);
  const subtype = price.subTypeName ?? 'Unknown';
  const metrics: NormalizedTcgcsvPrice['metrics'] = [];
  const add = (value: number | null | undefined, metricType: string) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      metrics.push({ metricType, amount: value, precisionScope: 'PRINTING_LEVEL', metadata: { tcgplayer_subtype: subtype } });
    }
  };
  add(price.lowPrice, 'LISTING_LOW');
  add(price.midPrice, 'LISTING_MEDIAN');
  add(price.highPrice, 'LISTING_HIGH');
  add(price.marketPrice, 'MARKET');
  add(price.directLowPrice, 'DIRECT_LOW');
  return {
    sourceCode: 'tcgcsv',
    originSourceCode: 'tcgplayer',
    namespace: 'prices',
    externalKey: `${price.productId}:${subtype}`,
    productId: price.productId,
    languageCode,
    subtype,
    observedAt: new Date(observedAt).toISOString(),
    currency: 'USD',
    metrics,
    raw: price
  };
}

function extended(data: TcgcsvExtendedData[] | undefined, names: string[]): string | undefined {
  if (!data) return undefined;
  const normalizedNames = new Set(names.map(normalizeTextV1));
  const found = data.find(item => normalizedNames.has(normalizeTextV1(item.name)) || (item.displayName && normalizedNames.has(normalizeTextV1(item.displayName))));
  return found?.value?.trim() || undefined;
}

function localCollectorNumber(raw: string): string {
  const parsed = normalizeCollectorNumberV1(raw);
  return parsed.denominator && parsed.numerator ? parsed.numerator : parsed.normalized;
}
