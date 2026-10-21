import fs from 'node:fs';
const mod = await import(process.argv[2]);
const A = '/home/claude/tcg-lens/apps/web-preview-live-repro/data/';
const names = {};
for (const l of ['fr', 'en']) { const d = JSON.parse(fs.readFileSync(`${A}visual-index-${l}.json`)); const i = d.columns.indexOf('id'), n = d.columns.indexOf('name'); for (const r of d.rows) (names[r[i]] ||= {})[l] = { name: r[n] }; }
const corp = [...JSON.parse(fs.readFileSync('/tmp/claude-0/ui/langcorp/ocr.json')), ...JSON.parse(fs.readFileSync('/tmp/claude-0/ui/langcorp/ocrja.json'))];
const jaSt = { latin: 0, n: 0 };
const st = { right: 0, wrong: 0, none: 0, strongRight: 0, strongWrong: 0 }, bad = [];
for (const r of corp) {
  const byLang = names[r.id] || {}; const cand = { languages: Object.keys(byLang), byLang };
  const d = mod.detectCardLanguage(r.text, cand, { latinStrong: r.latinStrong, jaStrong: 0, jaText: '' });
  if (r.lang === 'ja') { jaSt.n++; if (d.lang && d.lang !== 'ja') { jaSt.latin++; bad.push(['JA', r.id, r.v, d.lang, d.scores, r.latinStrong, r.text.slice(0, 160)]); } continue; }
  if (!d.lang) st.none++; else if (d.lang === r.lang) { st.right++; if (d.strong) st.strongRight++; } else { st.wrong++; if (d.strong) st.strongWrong++; bad.push([r.lang, r.id, r.v, d.lang, d.scores, d.strong, r.text.slice(0, 220)]); }
}
console.log(JSON.stringify(st), 'JA→latin', JSON.stringify(jaSt)); for (const b of bad.slice(0, +(process.argv[3] || 12))) console.log(JSON.stringify(b));
