import { chromium } from 'playwright-core';
const [video, base, profile = 'profile-warm'] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(`/tmp/claude-0/ui/${profile}`, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.addInitScript(() => { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration), e.attribution?.[0]?.containerSrc || '']); }).observe({ type: 'longtask', buffered: true }); });
const t0 = Date.now(); await page.goto(base, { waitUntil: 'commit' });
await page.waitForTimeout(14000);
const r = await page.evaluate(() => { const lt = window.__lt; const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource').filter(e => /data\/|tfjs|mobilenet|tesseract|zxing/.test(e.name)).map(e => [e.name.split('/').slice(-1)[0].slice(0, 40), Math.round(e.transferSize / 1024) + 'KB', Math.round(e.duration) + 'ms']);
  return { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), longTasks: lt.length, longTotalMs: lt.reduce((a, x) => a + x[1], 0), worst: lt.sort((a, b) => b[1] - a[1]).slice(0, 8), mem: Math.round((performance.memory?.usedJSHeapSize || 0) / 1e6) + 'MB', res, stats: window.TCGLiveLens?.runtime?.stats }; });
console.log(JSON.stringify(r, null, 1));
await ctx.close();
