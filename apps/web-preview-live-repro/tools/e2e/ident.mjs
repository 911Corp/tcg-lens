import { chromium } from 'playwright-core';
const [video, base, tag] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
const t0 = Date.now(); await page.goto(base, { waitUntil: 'commit' });
const sheet = () => page.evaluate(() => { const o = document.querySelector('.lens-result-overlay .sheet'); return o && o.offsetParent ? [o.querySelector('.sheet-name')?.textContent, o.querySelector('.sheet-amount')?.textContent, o.querySelector('.sheet-meta')?.textContent].join(' · ') : null; }).catch(() => null);
let first = null;
for (let i = 0; i < 200 && !first; i++) { first = await sheet(); if (!first) await page.waitForTimeout(100); }
console.log(tag, 'identifiée en', Date.now() - t0, 'ms :', first);
await page.waitForTimeout(6000); console.log(tag, '6 s plus tard :', await sheet());
await page.screenshot({ path: `/tmp/claude-0/ui/${tag}.png` });
await ctx.close();
