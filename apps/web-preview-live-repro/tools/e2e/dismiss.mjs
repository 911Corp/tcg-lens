import { chromium } from 'playwright-core';
const [video, base, mode] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
const t0 = Date.now();
await page.goto(base, { waitUntil: 'commit' });
const st = () => page.evaluate(() => { const r = window.TCGLiveLens?.runtime; const o = document.querySelector('.lens-result-overlay .sheet'); return { lamp: document.querySelector('[data-lamp]:not(.tl-lamp)')?.dataset.lamp, sm: r?.stateMachine?.state, track: !!r?.context, locked: !!r?.context?.locked, dismissed: !!r?.context?.locked?.dismissed, state: r?.state || r?.machine?.state, sheet: !!o && getComputedStyle(o).display !== 'none' && o.offsetParent !== null, name: o?.querySelector('.sheet-name')?.textContent }; }).catch(() => ({}));
let lockedAt = null, shown = null;
for (let i = 0; i < 150; i++) { const s = await st(); if (s.sheet) { lockedAt = Date.now() - t0; shown = s; break; } await page.waitForTimeout(100); }
console.log('fiche affichée', lockedAt, 'ms', shown);
await page.screenshot({ path: `/tmp/claude-0/ui/${mode}-shown.png` });
if (mode === 'x') {
  await page.click('.sheet-x'); const tx = Date.now();
  let back = false;
  for (let i = 0; i < 30; i++) { const s = await st(); if (s.sheet) back = true; await page.waitForTimeout(100); }
  console.log('après ✕ : réapparition =', back, await st());
} else {
  let goneAt = null;
  for (let i = 0; i < 150; i++) { const s = await st(); if (!s.sheet) { goneAt = Date.now() - t0; break; } await page.waitForTimeout(100); }
  console.log('fiche retirée à', goneAt, 'ms', await st()); for (let i=0;i<6;i++){ await page.waitForTimeout(1000); console.log(i, JSON.stringify(await st())); }
}
await page.screenshot({ path: `/tmp/claude-0/ui/${mode}-after.png` });
await ctx.close();
