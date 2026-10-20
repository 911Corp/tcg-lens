import { chromium } from 'playwright-core';
const [video, base] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(base);
for (let i = 0; i < 5; i++) { await page.waitForTimeout(2500);
  console.log(JSON.stringify(await page.evaluate(() => { const r = window.TCGLiveLens.runtime; return { sm: r.stateMachine.state, stats: { det: r.stats.detections, ticks: r.stats.ticks, src: r.stats.detectSource, top: r.stats.top, lang: r.stats.lang, ocr: r.stats.ocr }, cands: (r.lastCandidates||[]).slice(0,2), locked: r.context?.locked?.id, lr: r.context?.langConsensus?.reads?.length, tw: r.context?.locked?.group }; }), null, 0)); }
await page.screenshot({ path: '/tmp/claude-0/ui/why.png' });
await ctx.close();
