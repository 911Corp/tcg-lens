import fs from 'node:fs';
const SRC = '/home/claude/tcg-lens/apps/web-preview-live-repro/lens/LanguageEvidence.js';
const A = '/home/claude/tcg-lens/apps/web-preview-live-repro/data/';
const names = {};
for (const l of ['fr', 'en', 'ja']) { const d = JSON.parse(fs.readFileSync(`${A}visual-index-${l}.json`)); const i = d.columns.indexOf('id'), n = d.columns.indexOf('name'); for (const r of d.rows) (names[r[i]] ||= {})[l] = { name: r[n] }; }
const corp = JSON.parse(fs.readFileSync('/tmp/claude-0/ui/langcorp/script.json'));
for (const th of (process.argv[2] || '2,3,4,5,6').split(',').map(Number)) {
  const f = `/tmp/claude-0/ui/gen/le-${th}.mjs`; fs.writeFileSync(f, fs.readFileSync(SRC, 'utf8').replace('const JA_STRONG_MIN = 2;', `const JA_STRONG_MIN = ${th};`));
  const m = await import(f);
  const st = {};
  for (const r of corp) {
    const byLang = names[r.id] || {}; const cand = { languages: Object.keys(byLang), byLang };
    const d = m.detectCardLanguage(r.text, cand, { latinStrong: r.latinStrong, jaStrong: r.jaStrong, jaText: r.jaText, latinConf: 0, jaConf: 0 });
    const k = `${r.lang === 'ja' ? 'JA' : 'LAT'}-${r.v}`; const s = st[k] ||= { n: 0, right: 0, wrong: 0, strong: 0, jaOnLatin: 0 };
    s.n++; const truth = r.lang;
    if (d.lang === truth) { s.right++; s.strong += d.strong; } else if (d.lang) { s.wrong++; if (d.lang === 'ja') s.jaOnLatin++; }
  }
  console.log('JA_STRONG_MIN', th, JSON.stringify(st));
}
