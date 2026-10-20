import { chromium } from 'playwright-core';
const [video, base] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-coll', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'], hasTouch: true, acceptDownloads: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(base);
await page.waitForSelector('.lens-result-overlay .sheet-add', { timeout: 30000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/claude-0/ui/coll-sheet.png' });
await page.click('.sheet-add'); await page.waitForTimeout(400); await page.click('.sheet-add');
console.log('toast:', await page.textContent('#toast'));
await page.evaluate(() => go('collection')); await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/claude-0/ui/coll-panel.png' });
console.log(await page.evaluate(() => document.querySelector('#collectionBody').innerText));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#collExport')]);
if (dl) { const p = await dl.path(); console.log('CSV:', (await import('node:fs')).readFileSync(p, 'utf8').slice(0, 300)); }
await page.click('.coll-qty [data-q="-1"]'); await page.waitForTimeout(300);
console.log('after −:', await page.evaluate(() => document.querySelector('.coll-qty span')?.textContent));
await ctx.close();
