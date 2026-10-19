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

export interface TcgdexSetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: { official?: number; total?: number };
}

export interface TcgdexSet extends TcgdexSetBrief {
  releaseDate?: string;
  serie?: { id?: string; name?: string };
  tcgOnline?: string;
  abbreviation?: { official?: string; [key: string]: unknown };
  cards?: TcgdexCardBrief[];
  [key: string]: unknown;
}

export interface TcgdexFetchFailure { id: string; error: string }

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class TcgdexClient {
  constructor(
    private readonly baseUrl = 'https://api.tcgdex.net/v2',
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly retry = { attempts: 4, baseDelayMs: 500 }
  ) {}

  async listCards(language: TcgdexLanguage, signal?: AbortSignal): Promise<TcgdexCardBrief[]> {
    return this.get<TcgdexCardBrief[]>(`${this.baseUrl}/${language}/cards`, signal);
  }

  async getCard(language: TcgdexLanguage, cardId: string, signal?: AbortSignal): Promise<TcgdexCard> {
    return this.get<TcgdexCard>(`${this.baseUrl}/${language}/cards/${encodeURIComponent(cardId)}`, signal);
  }

  async listSets(language: TcgdexLanguage, signal?: AbortSignal): Promise<TcgdexSetBrief[]> {
    return this.get<TcgdexSetBrief[]>(`${this.baseUrl}/${language}/sets`, signal);
  }

  async getSet(language: TcgdexLanguage, setId: string, signal?: AbortSignal): Promise<TcgdexSet> {
    return this.get<TcgdexSet>(`${this.baseUrl}/${language}/sets/${encodeURIComponent(setId)}`, signal);
  }

  /**
   * Yields every requested card exactly once (in completion order). Fetch failures are reported
   * through `onFailure` instead of aborting the whole language, so the run can be audited.
   *
   * v0.3.1 fix: the previous implementation removed each promise from the in-flight set as soon as
   * it settled, so cards that resolved while the consumer was busy were silently dropped.
   */
  async *iterateCards(language: TcgdexLanguage, options: {
    concurrency?: number; signal?: AbortSignal; limit?: number; onFailure?: (failure: TcgdexFetchFailure) => void;
  } = {}): AsyncGenerator<TcgdexCard> {
    const briefs = await this.listCards(language, options.signal);
    const selected = options.limit ? briefs.slice(0, options.limit) : briefs;
    yield* boundedMap(selected, Math.max(1, Math.min(options.concurrency ?? 6, 12)), brief => this.getCard(language, brief.id, options.signal), (brief, error) => {
      options.onFailure?.({ id: brief.id, error: String(error) });
    });
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        const response = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'TCGLens/0.1 (+data-ingestion)' }, signal });
        if (response.ok) return (await response.json()) as T;
        lastError = new Error(`TCGdex ${response.status} for ${url}`);
        if (response.status < 500 && response.status !== 429) break; // 4xx other than 429 is not transient
      } catch (error) {
        lastError = error;
        if (signal?.aborted) break;
      }
      if (attempt < this.retry.attempts) await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
    }
    throw lastError;
  }
}

/**
 * Bounded-concurrency map that yields every successful result exactly once. Settled results are
 * buffered until the consumer pulls them; nothing is dropped while the consumer is busy.
 */
export async function* boundedMap<I, O>(
  items: readonly I[],
  concurrency: number,
  task: (item: I) => Promise<O>,
  onError: (item: I, error: unknown) => void
): AsyncGenerator<O> {
  let cursor = 0;
  const pending = new Map<number, Promise<{ index: number; ok: boolean; value?: O; error?: unknown }>>();
  const start = (index: number) => {
    pending.set(index, task(items[index]).then(
      value => ({ index, ok: true, value }),
      error => ({ index, ok: false, error })
    ));
  };
  while (cursor < items.length && pending.size < concurrency) start(cursor++);
  while (pending.size) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.index);
    if (cursor < items.length) start(cursor++);
    if (settled.ok) yield settled.value as O;
    else onError(items[settled.index], settled.error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
