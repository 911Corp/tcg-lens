import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load /i18n.js in a minimal page-like context.
function loadI18n(stored = null) {
  const store = new Map(stored ? [['uiLang', stored]] : []);
  const ctx = { navigator: { language: 'fr-FR' }, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { readyState: 'loading', documentElement: {}, addEventListener() {}, dispatchEvent() {}, body: null }, CustomEvent: class {}, Intl };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8'), ctx);
  return ctx.I18N;
}

test('every t() key used in the app has an English entry', () => {
  const src = fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8');
  const I = loadI18n('en');
  const files = ['lens/LensHud.js', 'lens/MarketOverlay.js', 'lens/MultiScan.js', 'collection.js', 'sealed.js'];
  const missing = [];
  for (const f of files) {
    const code = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const m of code.matchAll(/\b(?:t|T)\('((?:[^'\\]|\\.)+)'/g)) if (I.t(m[1]) === m[1] && /[a-zà-ÿ]{3}/i.test(m[1]) && !/^[A-Z][a-z]+$/.test(m[1])) missing.push(`${f}: ${m[1]}`);
  }
  assert.ok(src.includes('const EN = {'));
  assert.deepEqual(missing, []);
});

test('French by default on a French phone, English otherwise; formats follow the language', () => {
  const fr = loadI18n(); assert.equal(fr.lang, 'fr'); assert.equal(fr.t('Carte identifiée'), 'Carte identifiée'); assert.equal(fr.market(), 'eu');
  assert.match(fr.money(12.5, 'EUR'), /12,50\s?€/);
  const en = loadI18n('en'); assert.equal(en.lang, 'en'); assert.equal(en.t('Carte identifiée'), 'Card identified'); assert.equal(en.market(), 'us');
  assert.equal(en.money(12.5, 'USD'), '$12.50');
  assert.equal(en.t('dès {price}', { price: '$4.00' }), 'from $4.00');
  assert.equal(en.translateText('12 cartes trouvées.'), '12 cards found.');
  assert.equal(en.translateText('Pokémon GO, n° 027/078 (Anglais)'), 'Pokémon GO · #027/078 (English)');
});
