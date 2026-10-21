import fs from 'node:fs';
const { collectorCandidates, plausibleCollector } = await import('/home/claude/tcg-lens/apps/web-preview-live-repro/lens/OCRAdapter.js');
const R = JSON.parse(fs.readFileSync('/tmp/claude-0/s/numreads.json'));
for (const v of ['app', 'auto']) {
  let right = 0, wrongOnly = 0, old = 0, oldWrong = 0;
  for (const r of R) {
    const tr = `${Number(r.truth[0])}/${r.truth[1]}`;
    const c = r[v].flatMap(x => collectorCandidates(x)).map(x => x.split('/').map(Number).join('/'));
    if (c.includes(tr)) right++; else if (c.length) wrongOnly++;
    const o = r[v].filter(plausibleCollector).map(x => x.split('/').map(Number).join('/'));
    if (o.includes(tr)) old++; else if (o.length) oldWrong++;
  }
  console.log(v, R.length, 'new right', right, 'wrong-only', wrongOnly, '| old right', old, 'wrong', oldWrong);
}
