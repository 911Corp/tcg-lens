import { chromium } from 'playwright-core';
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-warm', { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=/tmp/claude-0/ui/s30fr.y4m`] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:4174/'); await page.waitForTimeout(5000);
const st = () => page.evaluate(() => ({ sm: window.TCGLiveLens.runtime.stateMachine.state, paused: window.TCGLiveLens.runtime.paused, ticks: window.TCGLiveLens.runtime.stats.ticks, track: state.stream?.getVideoTracks()[0]?.readyState }));
console.log('running', JSON.stringify(await st()));
// Simulate the OS stopping the camera while the app is in background.
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); state.stream.getVideoTracks()[0].stop(); });
await page.waitForTimeout(1500); console.log('hidden', JSON.stringify(await st()));
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(6000); console.log('back', JSON.stringify(await st()));
await ctx.close();
