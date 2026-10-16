import { cardPrintingIdentityV1, cardPrintingSearchV1, normalizeCollectorNumberV1, normalizeTextV1 } from './normalization.js';

export type TcgdexLanguage = 'fr' | 'en' | 'ja';

export interface TcgdexCardBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

export interface TcgdexCard extends TcgdexCardBrief {
  category?: string;
  illustrator?: string;
  rarity?: string;
  set?: { id?: string; name?: string; cardCount?: { official?: number; total?: number } };
  variants?: Record<string, boolean>;
  pricing?: unknown;
  [key: string]: unknown;
}

export interface NormalizedTcgdexCard {
  sourceCode: 'tcgdex';
  namespace: 'cards';
  externalKey: string;
  languageCode: TcgdexLanguage;
  name: string;
  normalizedName: string;
  collectorNumberRaw: string;
  collectorNumberNormalized: string;
  setExternalId?: string;
  setName?: string;
  rarity?: string;
  illustrator?: string;
  imageUrl?: string;
  identityFingerprint?: ReturnType<typeof cardPrintingIdentityV1>;
  searchFingerprint: ReturnType<typeof cardPrintingSearchV1>;
  raw: TcgdexCard;
}

export class TcgdexClient {
  constructor(private readonly baseUrl = 'https://api.tcgdex.net/v2') {}

  async listCards(language: TcgdexLanguage, signal?: AbortSignal): Promise<TcgdexCardBrief[]> {
    return this.get<TcgdexCardBrief[]>(`${this.baseUrl}/${language}/cards`, signal);
  }

  async getCard(language: TcgdexLanguage, cardId: string, signal?: AbortSignal): Promise<TcgdexCard> {
    return this.get<TcgdexCard>(`${this.baseUrl}/${language}/cards/${encodeURIComponent(cardId)}`, signal);
  }

  async *iterateCards(language: TcgdexLanguage, options: { concurrency?: number; signal?: AbortSignal; limit?: number } = {}): AsyncGenerator<TcgdexCard> {
    const briefs = await this.listCards(language, options.signal);
    const selected = options.limit ? briefs.slice(0, options.limit) : briefs;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 12));
    let cursor = 0;
    const inFlight = new Set<Promise<{ index: number; card: TcgdexCard }>>();

    const start = (index: number) => {
      const promise = this.getCard(language, selected[index].id, options.signal).then(card => ({ index, card }));
      inFlight.add(promise);
      promise.finally(() => inFlight.delete(promise));
    };

    while (cursor < selected.length && inFlight.size < concurrency) start(cursor++);
    while (inFlight.size) {
      const next = await Promise.race(inFlight);
      yield next.card;
      if (cursor < selected.length) start(cursor++);
    }
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'TCGLens/0.1 (+data-ingestion)' }, signal });
    if (!response.ok) throw new Error(`TCGdex ${response.status} for ${url}`);
    return response.json() as Promise<T>;
  }
}

export function normalizeTcgdexCard(languageCode: TcgdexLanguage, card: TcgdexCard): NormalizedTcgdexCard {
  const collector = normalizeCollectorNumberV1(card.localId);
  const setExternalId = card.set?.id;
  const setName = card.set?.name ?? 'unknown-set';
  return {
    sourceCode: 'tcgdex',
    namespace: 'cards',
    externalKey: card.id,
    languageCode,
    name: card.name,
    normalizedName: normalizeTextV1(card.name),
    collectorNumberRaw: card.localId,
    collectorNumberNormalized: collector.normalized,
    setExternalId,
    setName: card.set?.name,
    rarity: card.rarity,
    illustrator: card.illustrator,
    imageUrl: card.image,
    identityFingerprint: setExternalId ? cardPrintingIdentityV1({ setIdentity: `tcgdex:${languageCode}:${setExternalId}`, languageCode, collectorNumber: card.localId }) : undefined,
    searchFingerprint: cardPrintingSearchV1({ setName, languageCode, collectorNumber: card.localId, cardName: card.name }),
    raw: card
  };
}
