import { chromium } from 'playwright-core';
const [video, base, tag, confirm] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/' + (process.env.PROFILE || 'profile-warm'), { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'], hasTouch: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(base);
const t0 = Date.now(); let shown = null;
for (let i = 0; i < 120 && !shown; i++) { await page.waitForTimeout(150); shown = await page.evaluate(() => { const o = document.querySelector('.proposals'); const l = document.querySelector('.sheet:not(.proposals) .sheet-name'); return o ? 'PROPOSALS: ' + o.innerText.replace(/\n+/g, ' | ') : l ? 'LOCKED: ' + l.textContent : null; }); }
console.log(tag, Date.now() - t0, 'ms', shown);
console.log('telemetry', await page.evaluate(() => JSON.stringify((window.TCGLiveLens.runtime.telemetry.events || []).filter(e => /PROPOSAL/.test(e.type)).slice(-3))));
await page.screenshot({ path: `/tmp/claude-0/ui/${tag}-prop.png` });
if (confirm && shown?.startsWith('PROPOSALS')) {
  await page.click('.prop-item'); await page.waitForTimeout(2500);
  console.log('after confirm:', (await page.innerText('#lensResultOverlay')).replace(/\n+/g, ' | '), '| memory', await page.evaluate(() => window.TCGLiveLens.runtime.memory.size));
}
await ctx.close();
