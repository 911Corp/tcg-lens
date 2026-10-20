import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHud, qualityProblem, HudView } from '../lens/LensHud.js';

test('HUD speaks plain French and never exposes machine state names', () => {
  for (const state of ['ACQUIRING', 'TRACKING', 'ANALYZING', 'VERIFYING', 'AMBIGUOUS', 'UNKNOWN', 'CHANGE_PENDING', 'LOCKED', 'ERROR']) {
    const m = describeHud({ state, decision: { decision: state === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'CONTINUE', reason: 'x' } });
    assert.ok(m.title && !/[A-Z]{4,}/.test(m.title), `${state}: ${m.title}`);
    assert.ok(['idle', 'work', 'attention', 'fail', 'locked'].includes(m.tone));
  }
});

test('the last fusion decision keeps AMBIGUOUS stable while the state machine hops through ANALYZING', () => {
  const decision = { decision: 'AMBIGUOUS', reason: 'top1_top2_margin_too_small' };
  assert.equal(describeHud({ state: 'ANALYZING', decision }).key, describeHud({ state: 'AMBIGUOUS', decision }).key);
});

test('actionable quality hints take priority over generic progress', () => {
  assert.equal(describeHud({ state: 'ANALYZING', quality: { glare: 0.05 } }).title, 'Reflet sur la carte');
  assert.equal(describeHud({ state: 'ANALYZING', geometryReason: 'quad_too_small' }).title, 'Rapprochez la carte');
  assert.equal(describeHud({ state: 'ANALYZING', geometryReason: 'extreme_perspective' }).title, 'Mettez la carte à plat');
  assert.equal(qualityProblem({ quality: { glare: 0, dark: 0, exposure: 0.1, sharpness: 0.9 } }), null);
});

test('lock-blocked and contradiction reasons explain why the Lens refuses to decide', () => {
  assert.match(describeHud({ state: 'AMBIGUOUS', decision: { decision: 'AMBIGUOUS', reason: 'candidate_lock_blocked:UNINDEXED_ARTWORK_TWIN' } }).hint, /réédition/);
  assert.match(describeHud({ state: 'AMBIGUOUS', lang: 'ja', decision: { decision: 'AMBIGUOUS', reason: 'ocr_explicit_contradiction' } }).hint, /japonais/);
});

test('index loading progress is visible while acquiring and explains UNKNOWN', () => {
  const a = describeHud({ state: 'ACQUIRING', indexCount: 54, indexTarget: 1200, lang: 'fr' });
  assert.match(a.hint, /cartes de référence \(français\) : 54 sur 1\s200/);
  assert.match(describeHud({ state: 'AMBIGUOUS', indexCount: 54, indexTarget: 1200, decision: { decision: 'AMBIGUOUS', reason: 'top1_top2_margin_too_small' } }).hint, /pas encore chargée/, 'incomplete index is the honest explanation');
  assert.equal(describeHud({ state: 'UNKNOWN', indexCount: 54, indexTarget: 1200 }).key, 'unknown-index');
  assert.equal(describeHud({ state: 'UNKNOWN', indexCount: 1200, indexTarget: 1200 }).title, 'Carte non reconnue');
});

test('progress grows monotonically across the pipeline stages', () => {
  const t = describeHud({ state: 'TRACKING', trackHits: 4, minStableHits: 4 }).progress;
  const a = describeHud({ state: 'ANALYZING', temporalVotes: 4, minTemporalVotes: 4 }).progress;
  const v = describeHud({ state: 'VERIFYING', ocrExactVotes: 1, requiredOcrVotes: 2 }).progress;
  assert.ok(t <= 0.25 && t < a && a < v && v < 1);
});

test('HudView holds a message for the minimum time but shows locked/idle instantly', () => {
  let clock = 0; const timers = [];
  const view = new HudView(null, { minHoldMs: 700, now: () => clock, schedule: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, cancel: () => {} });
  view.render({ key: 'analyze', tone: 'work', title: 'A' });
  clock = 100; view.render({ key: 'amb', tone: 'attention', title: 'B' });
  assert.equal(view.current.key, 'analyze', 'held');
  clock = 200; view.render({ key: 'analyze', tone: 'work', title: 'A' });
  clock = 700; timers.forEach(t => t.fn());
  assert.equal(view.current.key, 'analyze', 'latest pending wins; no flicker to B');
  clock = 750; view.render({ key: 'locked', tone: 'locked', title: 'L' });
  assert.equal(view.current.key, 'locked');
});

import { MarketOverlay, lockedSheetModel } from '../lens/MarketOverlay.js';

test('locked sheet shows identity from the pool, French market labels and never an unproven variant', () => {
  const m = lockedSheetModel({ id: 'me05-001', name: 'Tropius', localId: '001', printedTotal: 84, setName: 'Nuit Noire', lang: 'fr', variantLabel: 'Reverse' },
    { market: { center: 0.24, currency: 'EUR' }, heat: { score: 52, label: 'WARM', trend: 'HEATING', beta: true }, supplyDemand: { score: null } }, 0.973);
  assert.equal(m.number, '001/084', 'printed form');
  assert.equal(m.language, 'Français');
  assert.equal(m.variant, null, 'variant only when physically proven');
  assert.equal(m.heat.label, 'Tiède');
  assert.equal(m.trend.text, 'En hausse');
  assert.equal(m.supplyDemand, null);
  assert.equal(m.confidence, 97);
  assert.match(m.price, /0,24/);
  assert.equal(lockedSheetModel({ id: 'x', name: 'X' }, {}, 0.9).price, null, 'missing price is never invented');
});

test('a late market response never paints over a newer card', async () => {
  const originalFetch = globalThis.fetch;
  const resolvers = [];
  globalThis.fetch = () => new Promise(r => resolvers.push(r));
  const overlay = new MarketOverlay(null);
  try {
    const first = overlay.showLocked({ id: 'a', name: 'A' }, 0.97);
    const second = overlay.showLocked({ id: 'b', name: 'B' }, 0.97);
    resolvers[1]({ ok: true, json: async () => ({ id: 'b', name: 'B' }) });
    await second;
    resolvers[0]({ ok: true, json: async () => ({ id: 'a', name: 'A' }) });
    await first;
    assert.equal(overlay.current.id, 'b');
  } finally { globalThis.fetch = originalFetch; }
});

test('a long wait on the printed number escalates to a precise instruction', () => {
  assert.equal(describeHud({ state: 'VERIFYING', verifyingMs: 2000 }).key, 'verify');
  const stuck = describeHud({ state: 'VERIFYING', verifyingMs: 7000 });
  assert.equal(stuck.tone, 'attention');
  assert.match(stuck.hint, /numéro/);
});
