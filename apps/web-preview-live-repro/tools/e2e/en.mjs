import { chromium } from 'playwright-core';
const [video, base] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-en', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'], hasTouch: true, locale: 'en-US',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
const french = () => page.evaluate(() => { const out = new Set(); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest('[hidden],[aria-hidden="true"]:not(.panel),.lens-debug,[translate="no"],script,style')) continue; const s = n.nodeValue.trim(); if (/[àâçéèêëîïôûùœ’]|\b(le|la|les|des|une|carte|cartes|prix|avec|pour)\b/i.test(s)) out.add(s.slice(0, 90)); }
  for (const e of document.querySelectorAll('[aria-label],[placeholder]')) for (const a of ['aria-label', 'placeholder']) { const v = e.getAttribute(a); if (v && /[àâçéèêëîïôûùœ’]|\b(le|la|les|des|une|carte|cartes|prix)\b/i.test(v)) out.add('@' + a + ': ' + v.slice(0, 60)); }
  return [...out]; });
await page.goto(base);
await page.waitForSelector('.lens-result-overlay .sheet-main', { timeout: 30000 }); await page.waitForTimeout(3000);
console.log('SHEET:', (await page.innerText('#lensResultOverlay')).replace(/\n+/g, ' | '));
await page.screenshot({ path: '/tmp/claude-0/ui/en-scan.png' });
await page.click('.sheet-add');
for (const panel of ['settings', 'collection', 'legend', 'search']) {
  await page.evaluate(p => go(p), panel); await page.waitForTimeout(700);
  if (panel === 'search') { await page.fill('#searchInput', 'pikachu'); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); }
  await page.screenshot({ path: `/tmp/claude-0/ui/en-${panel}.png` });
  console.log(panel, 'FRENCH LEFT:', JSON.stringify(await french()));
}
await page.click('#results .result'); await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/claude-0/ui/en-detail.png' });
console.log('detail FRENCH LEFT:', JSON.stringify(await french()));
await page.evaluate(() => go('settings')); await page.waitForTimeout(400); await page.click('[data-uilang="fr"]'); await page.waitForTimeout(500);
console.log('after FR switch:', (await page.innerText('#settings h2')), '|', await page.evaluate(() => document.querySelector('[data-go="lens"]').getAttribute('aria-label')));
await ctx.close();
