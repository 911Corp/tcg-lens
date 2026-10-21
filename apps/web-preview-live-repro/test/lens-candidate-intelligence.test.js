// v0.3.1 — Candidate intelligence: canonical pool, printed-metadata corroboration, visual-only gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCollectorText, corroborateCandidate, normalizeNumberToken } from '../lens/MetadataCorroboration.js';
import { EvidenceFusion } from '../lens/EvidenceFusion.js';
import { TemporalConsensus } from '../lens/TemporalConsensus.js';
import { OCRConsensus } from '../lens/OCRConsensus.js';
import { OCRAdapter } from '../lens/OCRAdapter.js';
import { runReplay } from './helpers/replayHarness.js';

function temporal(candidateId, votes, score = 0.98, margin = 0.11, quality = 0.7) {
  const c = new TemporalConsensus();
  for (let i = 0; i < votes; i++) c.observe({ candidateId, score, margin, quality });
  return c.summary();
}
const charizard = { id: 'sv03.5-199', localId: '199', printedTotal: 165, setAbbreviation: 'MEW', lang: 'en', name: 'Charizard ex' };

test('printed collector text keeps the printed total and set code', () => {
  assert.deepEqual(parseCollectorText('MEW 199/165'), { number: '199', printedTotal: 165, setCode: 'MEW' });
  assert.deepEqual(parseCollectorText('199 / 165'), { number: '199', printedTotal: 165, setCode: null });
  assert.equal(parseCollectorText('TG05/TG30').number, 'TG5');
  assert.equal(parseCollectorText('TG05/TG30').printedTotal, null, 'subset denominators are not the set printed total');
  assert.equal(parseCollectorText('SVP 123').number, 'SVP123');
  assert.equal(parseCollectorText('illustration Ryota').number, null);
  assert.equal(normalizeNumberToken('007'), '7');
  assert.equal(normalizeNumberToken('GG01'), 'GG1');
});

test('number + printed total is printing-level support; a bare number is not', () => {
  const full = corroborateCandidate(charizard, { number: '199', printedTotal: 165, setCode: null });
  assert.equal(full.printingSupport, true);
  const bare = corroborateCandidate(charizard, { number: '199', printedTotal: null, setCode: null });
  assert.equal(bare.printingSupport, false);
  assert.equal(bare.numberOnly, true);
  const withSet = corroborateCandidate(charizard, { number: '199', printedTotal: null, setCode: 'MEW' });
  assert.equal(withSet.printingSupport, true);
});

test('printed metadata that disagrees with the visual top is a physical contradiction', () => {
  const wrongTotal = corroborateCandidate(charizard, { number: '199', printedTotal: 198, setCode: null });
  assert.equal(wrongTotal.contradicts, true);
  assert.deepEqual(wrongTotal.reasons, ['printed_total_mismatch']);
  const wrongNumber = corroborateCandidate(charizard, { number: '187', printedTotal: 165, setCode: null });
  assert.equal(wrongNumber.contradicts, true);
  assert.equal(wrongNumber.printingSupport, false);
  // v0.4.4: one digit off with the total matching is an OCR slip (unreadable), neither support nor contradiction.
  const slip = corroborateCandidate(charizard, { number: '198', printedTotal: 165, setCode: null });
  assert.equal(slip.contradicts, false); assert.equal(slip.printingSupport, false);
  // A lone number read without a total is too weak to contradict (likely OCR noise) and never supports.
  const noisy = corroborateCandidate(charizard, { number: '189', printedTotal: null, setCode: null });
  assert.equal(noisy.contradicts, false);
  assert.equal(noisy.printingSupport, false);
  // Set-code token alone never contradicts.
  assert.equal(corroborateCandidate(charizard, { number: '199', printedTotal: 165, setCode: 'OBF' }).contradicts, false);
});

test('visual-only lock requires an explicit pool permission; default is refusal', () => {
  const fusion = new EvidenceFusion();
  const base = { temporal: temporal('a', 7, 0.99, 0.12, 0.7), canonical: { conflict: false } };
  const absent = fusion.evaluate({ ...base, visual: { candidateId: 'a', score: 0.99, margin: 0.12, embeddingVerified: true } });
  assert.notEqual(absent.decision, 'LOCK');
  assert.equal(absent.reason, 'visual_only_lock_not_permitted_for_candidate_set');
  const denied = fusion.evaluate({ ...base, visual: { candidateId: 'a', score: 0.99, margin: 0.12, embeddingVerified: true, visualOnlyLockAllowed: false } });
  assert.notEqual(denied.decision, 'LOCK');
  const allowed = fusion.evaluate({ ...base, visual: { candidateId: 'a', score: 0.99, margin: 0.12, embeddingVerified: true, visualOnlyLockAllowed: true } });
  assert.equal(allowed.decision, 'LOCK');
  assert.equal(allowed.reason, 'extreme_temporal_visual_consensus');
});

test('incomplete-set candidates can still lock with 2-read printed-number consensus', () => {
  const fusion = new EvidenceFusion();
  const ocr = new OCRConsensus();
  ocr.observe({ available: true, candidateId: 'a', collectorExact: true, strongNameMatch: true }, 'a');
  const one = fusion.evaluate({ temporal: temporal('a', 5, 0.96, 0.09), visual: { candidateId: 'a', score: 0.96, margin: 0.09, embeddingVerified: true, visualOnlyLockAllowed: false }, ocr: ocr.summary('a'), canonical: { conflict: false } });
  assert.notEqual(one.decision, 'LOCK', 'one OCR read is not consensus');
  const two = ocr.observe({ available: true, candidateId: 'a', collectorExact: true, strongNameMatch: true }, 'a');
  const locked = fusion.evaluate({ temporal: temporal('a', 5, 0.96, 0.09), visual: { candidateId: 'a', score: 0.96, margin: 0.09, embeddingVerified: true, visualOnlyLockAllowed: false }, ocr: two, canonical: { conflict: false } });
  assert.equal(locked.decision, 'LOCK');
  assert.equal(locked.reason, 'visual_temporal_plus_exact_collector');
});

test('pool permission never overrides a physical contradiction', () => {
  const fusion = new EvidenceFusion();
  const ocr = new OCRConsensus();
  const summary = ocr.observe({ available: true, candidateId: 'a', contradiction: true }, 'a');
  const result = fusion.evaluate({ temporal: temporal('a', 8, 0.995, 0.2, 0.8), visual: { candidateId: 'a', score: 0.995, margin: 0.2, embeddingVerified: true, visualOnlyLockAllowed: true }, ocr: summary, canonical: { conflict: false } });
  assert.equal(result.decision, 'AMBIGUOUS');
  assert.equal(result.reason, 'ocr_explicit_contradiction');
});

test('OCR adapter corroborates visual candidates from their canonical metadata, never from a bare number', async () => {
  const adapter = new OCRAdapter();
  const originalFetch = globalThis.fetch;
  const lookups = [];
  globalThis.fetch = async url => { lookups.push(String(url)); return { ok: true, json: async () => ({ items: [] }) }; };
  try {
    const visualCandidates = [{ ...charizard, score: 0.97 }, { id: 'sv03.5-198', localId: '198', printedTotal: 165, setAbbreviation: 'MEW', lang: 'en', name: 'Venusaur ex', score: 0.9 }];
    const exact = await adapter.resolveCandidates(adapter.parse('Charizard ex MEW 199/165', 'MEW 199/165'), 'en', visualCandidates);
    assert.equal(exact[0].id, charizard.id);
    assert.equal(exact[0].collectorExact, true);
    assert.match(lookups[0], /\/api\/candidate-lookup\?lang=en&number=199&total=165/);

    const bare = await adapter.resolveCandidates(adapter.parse('Charizard 199', '199'), 'en', visualCandidates);
    assert.equal(bare.find(x => x.id === charizard.id).collectorExact, false, 'bare local number is not printing support');

    const contradicted = await adapter.resolveCandidates(adapter.parse('Charizard ex 199/198', '199/198'), 'en', visualCandidates);
    assert.equal(contradicted[0].id, charizard.id);
    assert.equal(contradicted[0].contradiction, true);
    assert.deepEqual(contradicted[0].contradictionReasons, ['printed_total_mismatch']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metadata lookup never promotes a non-visual candidate; a strong other read blocks instead', async () => {
  const adapter = new OCRAdapter();
  const originalFetch = globalThis.fetch;
  const other = { id: 'sv01-199', localId: '199', printedTotal: 165, setAbbreviation: 'SVI', lang: 'en', name: 'Charizard ex' };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [other] }) });
  try {
    // Visual top is a different card with no printed-metadata support.
    const visualTop = { id: 'me01-050', localId: '50', printedTotal: 132, lang: 'en', name: 'Pikachu', score: 0.95 };
    const ranked = await adapter.resolveCandidates(adapter.parse('Charizard ex 199/165', '199/165'), 'en', [visualTop]);
    const top = ranked.find(x => x.id === visualTop.id);
    assert.equal(top.contradiction, true, 'visual top contradicted by the printed number/total');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('candidate-pool API serves only the canonical export and filters by printed total', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-pool-'));
  fs.writeFileSync(path.join(dir, 'candidate-pool-en.json'), JSON.stringify({
    schema: 'tcg-lens-candidate-pool-v1', asOf: '2026-10-20', buildId: 'b1', lang: 'en', items: [
      { ...charizard, entityId: 'e1', setId: 'sv03.5', setName: '151', image: 'https://x/low.webp', setReadiness: 'LENS_READY', visualOnlyLockAllowed: true, releaseDate: '2023-09-22' },
      { id: 'sv01-199', entityId: 'e2', localId: '199', printedTotal: 198, lang: 'en', name: 'Charizard ex', setId: 'sv01', image: 'https://y/low.webp', setReadiness: 'IDENTITY_COMPLETE', visualOnlyLockAllowed: false }
    ]
  }));
  const prev = process.env.TCG_LENS_POOL_DIR;
  process.env.TCG_LENS_POOL_DIR = dir;
  const { clearCandidatePoolCache } = await import('../api/_candidate-pool.js');
  clearCandidatePoolCache();
  const lookup = (await import('../api/candidate-lookup.js')).default;
  const visualCards = (await import('../api/visual-cards.js')).default;
  const res = () => { const r = { code: 0, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
  try {
    const all = res(); await lookup({ query: { lang: 'en', number: '199' } }, all);
    assert.equal(all.code, 200); assert.equal(all.body.count, 2);
    const filtered = res(); await lookup({ query: { lang: 'en', number: '199', total: '165' } }, filtered);
    assert.deepEqual(filtered.body.items.map(x => x.id), ['sv03.5-199']);
    const page = res(); await visualCards({ query: { lang: 'en', cursor: '0', size: '8' } }, page);
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.exhausted, true);
    assert.equal(page.body.items[1].visualOnlyLockAllowed, false);
    const missing = res(); await lookup({ query: { lang: 'ja', number: '1' } }, missing);
    assert.equal(missing.code, 503, 'no silent fallback to raw source data');
  } finally {
    if (prev === undefined) delete process.env.TCG_LENS_POOL_DIR; else process.env.TCG_LENS_POOL_DIR = prev;
    clearCandidatePoolCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay: candidates from a visually incomplete set never lock without corroboration', () => {
  const { events } = runReplay({ visualOnlyLockAllowed: false });
  assert.equal(events.filter(e => e.type === 'LOCK').length, 0);
});

test('replay: a printed-metadata contradiction beats extreme visual consensus', () => {
  const { events } = runReplay({ visualOnlyLockAllowed: true, ocrRead: () => ({ candidateId: null, contradiction: true }) });
  assert.equal(events.filter(e => e.type === 'LOCK').length, 0);
});

test('a candidate with an unindexed artwork twin never locks, even with printed-number consensus', () => {
  const fusion = new EvidenceFusion();
  const ocr = new OCRConsensus();
  ocr.observe({ available: true, candidateId: 'base1-4', collectorExact: true, strongNameMatch: true }, 'base1-4');
  const two = ocr.observe({ available: true, candidateId: 'base1-4', collectorExact: true, strongNameMatch: true }, 'base1-4');
  const result = fusion.evaluate({
    temporal: temporal('base1-4', 8, 0.99, 0.2, 0.8),
    visual: { candidateId: 'base1-4', score: 0.99, margin: 0.2, embeddingVerified: true, visualOnlyLockAllowed: false, lockBlockedReason: 'UNINDEXED_ARTWORK_TWIN' },
    ocr: two, canonical: { conflict: false }
  });
  assert.equal(result.decision, 'AMBIGUOUS');
  assert.equal(result.reason, 'candidate_lock_blocked:UNINDEXED_ARTWORK_TWIN');
  const { events } = runReplay({ lockBlockedReason: 'UNINDEXED_ARTWORK_TWIN', ocrRead: ({ candidateId }) => ({ candidateId, collectorExact: true, strongNameMatch: true }) });
  assert.equal(events.filter(e => e.type === 'LOCK').length, 0);
});

import { ANNIndex } from '../lens/ANNIndex.js';

test('targeted warming adds canonical refs with pool flags, bounded and language-scoped', async () => {
  const index = new ANNIndex();
  const embedding = { model: null, imageCanvas: async () => ({}), fastDescriptor: () => [1, 0, 0] };
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, lang: 'en', name: 'Charizard', localId: '4', printedTotal: 102, image: `https://x/${i}/low.webp`, visualOnlyLockAllowed: i === 0, lockBlockedReason: i === 1 ? 'UNINDEXED_ARTWORK_TWIN' : null }));
  items.push({ id: 'fr-1', lang: 'fr', name: 'Dracaufeu', localId: '4', image: 'https://x/fr/low.webp' });
  const added = await index.warmTargeted(items, 'en', embedding);
  assert.equal(added.length, 12, 'bounded');
  assert.equal(index.count('en'), 12);
  assert.equal(index.count('fr'), 0, 'language scoped');
  assert.equal(index.refs.get('en:old-0').visualOnlyLockAllowed, true);
  assert.equal(index.refs.get('en:old-1').lockBlockedReason, 'UNINDEXED_ARTWORK_TWIN');
  assert.equal(index.refs.get('en:old-2').visualOnlyLockAllowed, false);
  assert.deepEqual(await index.warmTargeted(items.slice(0, 3), 'en', embedding), [], 'idempotent');
});

test('a single noisy printed-number read does not poison the track; two identical reads do block', () => {
  const ocr = new OCRConsensus();
  const noisy = { available: true, candidateId: 'a', contradiction: true, contradictionKind: 'printed_metadata', contradictionSignature: 'EO1/38' };
  assert.equal(ocr.observe(noisy, 'a').contradiction, false, 'one garbage read is not a contradiction');
  assert.equal(ocr.observe({ ...noisy, contradictionSignature: 'E01/36' }, 'a').contradiction, false, 'different garbage does not accumulate');
  assert.equal(ocr.observe(noisy, 'a').contradiction, true, 'the same mismatching read twice is a real contradiction');
  const other = new OCRConsensus();
  assert.equal(other.observe({ available: true, candidateId: 'b', collectorExact: true, contradiction: true, contradictionKind: 'exact_other_candidate' }, 'a').contradiction, true, 'exact other candidate still blocks immediately');
});

test('replay: one noisy printed read during A does not prevent the A locks', () => {
  let reads = 0;
  const { events } = runReplay({ visualOnlyLockAllowed: true, ocrRead: () => (reads++ === 0 ? { candidateId: null, contradiction: true, contradictionKind: 'printed_metadata', contradictionSignature: 'EO1/38' } : null) });
  const locks = events.filter(e => e.type === 'LOCK').map(e => e.candidateId);
  assert.deepEqual(locks, ['test-a', 'test-a']);
});

test('background warming indexes every pool item of a page (no silent skips)', async () => {
  const index = new ANNIndex({ maxRefs: 100 });
  const pool = Array.from({ length: 40 }, (_, i) => ({ id: `c-${i}`, lang: 'en', name: `C${i}`, localId: String(i), image: `https://x/${i}/low.webp` }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = new URL(url, 'http://local');
    const offset = Number(u.searchParams.get('cursor')), size = Number(u.searchParams.get('size'));
    return { ok: true, json: async () => ({ total: pool.length, buildId: 'b', items: pool.slice(offset, offset + size), nextCursor: String(offset + size), exhausted: offset + size >= pool.length }) };
  };
  const embedding = { model: { ok: true }, imageCanvas: async () => ({}), fastDescriptor: () => [1, 0], embed: async () => { throw new Error('deep embedding must not run during background warm'); } };
  try {
    for (let i = 0; i < 3; i++) await index.warm('en', embedding, { batch: 18 });
    assert.equal(index.count('en'), 40);
    assert.equal(index.target('en'), 40);
    assert.ok([...index.refs.values()].every(r => r.deep === null), 'deep computed lazily at query time');
  } finally { globalThis.fetch = originalFetch; }
});

import { corroborateCandidate as corroborateV036 } from '../lens/MetadataCorroboration.js';
test('Classic Collection reprints are corroborated by the number printed on the card, not the catalogue numbering', () => {
  const charizard = { localId: '001', printedTotal: 0, printedNumber: '4/102', setAbbreviation: null };
  const ok = corroborateV036(charizard, { number: '4', printedTotal: 102 });
  assert.equal(ok.printingSupport, true); assert.equal(ok.contradicts, false);
  assert.equal(corroborateV036(charizard, { number: '1', printedTotal: 30 }).contradicts, true, 'catalogue numbering is not what is printed');
});
