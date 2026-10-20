import { chromium } from 'playwright-core';
const [video, base, tag] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'], hasTouch: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(base);
await page.waitForSelector('.lens-result-overlay .sheet-main', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.click('.lens-result-overlay .sheet-main');
await page.waitForTimeout(2500);
await page.screenshot({ path: `/tmp/claude-0/ui/${tag}-detail.png`, fullPage: false });
console.log(await page.evaluate(() => document.querySelector('#detail')?.innerText.slice(0, 600)));
await ctx.close();
