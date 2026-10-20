import { chromium } from 'playwright-core';
const [video, base] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'], hasTouch: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(base); await page.waitForTimeout(2500);
await page.click('#multiToggle');
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => { const m = window.TCGLiveLens.runtime.multi; return { bar: document.querySelector('.mc-bar')?.innerText, slots: m?.slots.map(s => `${s.decision.state}(${s.decision.reason||""};tw=${JSON.stringify(window.__tw?.[s.key]||null)}):${s.card?.id || s.history.at(-1)?.id || '-'}:${s.history.at(-1)?.score?.toFixed?.(2)}`), passMs: m?.passMs }; });
  if (i % 2 === 1) console.log(Date.now() - t0, JSON.stringify(r));
  if (r.bar?.startsWith('4 / 4')) { console.log('all identified after', Date.now() - t0, 'ms'); break; }
}
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/claude-0/ui/multi.png' });
await page.click('.mc-add').catch(() => {}); await page.waitForTimeout(300); console.log('toast', await page.textContent('#toast'));
await page.click('#multiToggle'); await page.waitForTimeout(200);
await ctx.close();
