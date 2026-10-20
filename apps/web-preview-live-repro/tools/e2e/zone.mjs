import { chromium } from 'playwright-core';
const [video, base, tag] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-zone', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(base); const t0 = Date.now(); let res = null;
for (let i = 0; i < 100 && !res; i++) { await page.waitForTimeout(150); res = await page.evaluate(() => { const r = window.TCGLiveLens?.runtime; return r?.context?.locked ? 'LOCKED ' + r.context.locked.identity.name + ' · ' + r.context.locked.identity.setName + ' · ' + (r.context.locked.userConfirmed ? 'user' : 'auto') : null; }); }
console.log(tag, Date.now() - t0, 'ms', res || 'not locked', '|', await page.evaluate(() => document.querySelector('#lensResultOverlay')?.innerText.replace(/\n+/g, ' | ').slice(0, 200)));
console.log(await page.evaluate(() => JSON.stringify((window.TCGLiveLens.runtime.telemetry.events || []).filter(e => e.type === 'REGION_CHECK' || e.type === 'REGION_ERROR').slice(-4).map(e => e.detail))));
await ctx.close();
