import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=/tmp/claude-0/ui/gone.y4m`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:4174/'); await page.waitForTimeout(4000);
const st = () => page.evaluate(() => { const r = window.TCGLiveLens.runtime; return { worker: r.frames.ready ? 'ok' : r.frames.broken ? 'broken' : 'init', restarts: r.frameRestarts || 0, ticks: r.stats.ticks, sm: r.stateMachine.state }; });
await page.evaluate(() => window.TCGLiveLens.runtime.frames.disable('test_crash'));
for (const s of [1, 6, 12, 16]) { await page.waitForTimeout(s === 1 ? 1000 : 5000); console.log(`t+${s}s`, JSON.stringify(await st())); }
await ctx.close();
