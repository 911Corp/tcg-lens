/**
 * v0.3.1 — Raw TCGdex snapshot.
 *
 * Fetches every set (with release date and card briefs) and every card detail for the requested
 * languages and writes them to a dated snapshot directory. Imports and coverage audits then run
 * against the snapshot, so a bootstrap is reproducible and its source state is auditable.
 *
 *   npm run tcgdex:snapshot -w @tcglens/ingestion-worker -- fr,en,ja [--out=data/snapshots/tcgdex-YYYY-MM-DD] [--limit=N]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { TcgdexClient, boundedMap, type TcgdexCard, type TcgdexLanguage, type TcgdexSet } from '../../../packages/ingestion/src/index.js';

const requested = (process.argv[2] ?? 'fr,en,ja').split(',').filter(Boolean) as TcgdexLanguage[];
const allowed = new Set<TcgdexLanguage>(['fr', 'en', 'ja']);
for (const lang of requested) if (!allowed.has(lang)) throw new Error(`Unsupported language ${lang}`);
const today = new Date().toISOString().slice(0, 10);
const outArg = process.argv.find(v => v.startsWith('--out='));
const outDir = path.resolve(outArg ? outArg.slice('--out='.length) : `../../data/snapshots/tcgdex-${today}`);
const limitArg = process.argv.find(v => v.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const concurrency = Number(process.env.TCGDEX_CONCURRENCY ?? 8);

const client = new TcgdexClient();
await fs.mkdir(outDir, { recursive: true });

const manifest: Record<string, unknown> = { source: 'tcgdex', apiBase: 'https://api.tcgdex.net/v2', startedAt: new Date().toISOString(), languages: {} };

for (const language of requested) {
  const started = Date.now();
  const setBriefs = await client.listSets(language);
  const setFailures: Array<{ id: string; error: string }> = [];
  const sets: TcgdexSet[] = [];
  for await (const set of boundedMap(setBriefs, concurrency, brief => client.getSet(language, brief.id), (brief, error) => setFailures.push({ id: brief.id, error: String(error) }))) {
    sets.push(set);
  }
  sets.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(path.join(outDir, `${language}-sets.json`), JSON.stringify(sets));

  const briefs = await client.listCards(language);
  const selected = limit ? briefs.slice(0, limit) : briefs;
  const cardFailures: Array<{ id: string; error: string }> = [];
  const cards: TcgdexCard[] = [];
  let n = 0;
  for await (const card of boundedMap(selected, concurrency, brief => client.getCard(language, brief.id), (brief, error) => cardFailures.push({ id: brief.id, error: String(error) }))) {
    cards.push(card);
    if (++n % 1000 === 0) console.log(`[${language}] ${n}/${selected.length} cards`);
  }
  cards.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(path.join(outDir, `${language}-cards.json`), JSON.stringify(cards));

  (manifest.languages as Record<string, unknown>)[language] = {
    setsListed: setBriefs.length, setsFetched: sets.length, setFailures,
    cardsListed: briefs.length, cardsRequested: selected.length, cardsFetched: cards.length, cardFailures,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  console.log(`[${language}] sets ${sets.length}/${setBriefs.length}, cards ${cards.length}/${selected.length}, failures ${cardFailures.length}`);
}

manifest.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`snapshot written to ${outDir}`);
