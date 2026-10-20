import { chromium } from 'playwright-core';
const [video, base, profile = 'profile-warm', secs = '14'] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(`/tmp/claude-0/ui/${profile}`, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: { width: 390, height: 844 }, permissions: ['camera'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
const page = ctx.pages()[0] || await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start');
await page.goto(base); await page.waitForTimeout(Number(secs) * 1000);
const { profile: p } = await cdp.send('Profiler.stop');
const byId = new Map(p.nodes.map(n => [n.id, n])); const self = new Map();
const dt = p.timeDeltas; for (let i = 0; i < p.samples.length; i++) { const n = byId.get(p.samples[i]); const cf = n.callFrame; const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-1)[0].split('?')[0]}:${cf.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); }
const tot = [...self.values()].reduce((a, b) => a + b, 0);
console.log('total ms', Math.round(tot / 1000));
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(Math.round(v / 1000) + 'ms', k);
await ctx.close();
