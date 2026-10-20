import { chromium } from 'playwright-core';
const [video, base = 'http://127.0.0.1:4174/'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'], deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => m.type() === 'error' && console.log('CONSOLE', m.text().slice(0, 160)));
const t0 = Date.now();
await page.goto(base);
await page.waitForFunction(() => window.TCGLiveLens?.runtime);
await page.evaluate(() => document.addEventListener('tcglens:barcode', e => { window.__bc = { ...e.detail, at: performance.now() }; }));
let txt = '';
for (let i = 0; i < 80; i++) { txt = await page.evaluate(() => { const o = document.querySelector('#sealedOverlay'); return o.hidden ? '' : o.innerText; }); if (/Code-barres lu|reconnu|non reconnu/.test(txt) && !/recherche/.test(txt)) break; await page.waitForTimeout(250); }
console.log('barcode event', JSON.stringify(await page.evaluate(() => window.__bc)), 'after', Date.now() - t0, 'ms');
console.log(txt.replace(/\n+/g, ' | '));
await page.waitForTimeout(1500); await page.screenshot({ path: 'auto/bc.png' }); console.log('img', await page.evaluate(() => { const i = document.querySelector('#sealedOverlay img'); return i ? i.naturalWidth + ' ' + i.src : 'none'; }));
await browser.close();
