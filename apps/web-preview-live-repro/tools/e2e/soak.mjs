import { chromium } from 'playwright-core';
const [video, base, secs = '180'] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/' + (process.env.PROFILE || 'profile-warm'), { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push('console: ' + m.text().slice(0, 140)));
await page.addInitScript(() => { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  window.__locks = []; document.addEventListener('tcglens:card-locked', e => window.__locks.push([Math.round(performance.now()), e.detail?.name])); });
await page.goto(base);
const t0 = Date.now(); let lastTicks = 0;
for (let s = 15; s <= Number(secs); s += 15) {
  await page.waitForTimeout(15000);
  const r = await page.evaluate(() => { window.gc?.(); const rt = window.TCGLiveLens.runtime; const lt = window.__lt.splice(0);
    return { heap: Math.round(performance.memory.usedJSHeapSize / 1e6), ticks: rt.stats.ticks, state: rt.stateMachine.state, worker: rt.frames ? (rt.frames.ready ? 'ok' : rt.frames.broken ? 'broken:' + rt.frames.reason : 'init') : 'none', pending: rt.frames?.pending?.size, lt: lt.length, ltMax: Math.round(Math.max(0, ...lt)), locks: window.__locks.length, dom: document.getElementsByTagName('*').length }; });
  console.log(`${s}s heap=${r.heap}MB ticks/s=${((r.ticks - lastTicks) / 15).toFixed(1)} state=${r.state} worker=${r.worker} pend=${r.pending} longtasks=${r.lt} max=${r.ltMax}ms locks=${r.locks} dom=${r.dom}`);
  lastTicks = r.ticks;
}
console.log('locks', JSON.stringify(await page.evaluate(() => window.__locks)));
console.log('errors', errors.length, errors.slice(0, 8));
await ctx.close();
