import { LensRuntime } from './LensRuntime.js';

const $ = s => document.querySelector(s);
let runtime = null;

function ensureRuntime() {
  if (runtime) return runtime;
  // Diagnostics panel: long press on the status light (or ?debug=1).
  const debug = $('#lensDebug');
  if (new URLSearchParams(location.search).get('debug') === '1') debug.hidden = false;
  runtime = new LensRuntime({
    video: $('#camera'),
    trackLayer: $('#trackLayer'),
    resultOverlay: $('#lensResultOverlay'),
    hudRoot: $('#lensHud'),
    debugNode: debug,
    multiLayer: $('#multiLayer'),
  });
  // v0.4.0: app language changed → HUD and the shown result follow (market and wording).
  document.addEventListener('tcglens:uilang', () => runtime.onUiLanguage?.());
  // v0.3.9: multi-card mode toggle (remembered on this device).
  const btn = $('#multiToggle');
  const apply = on => { const ok = runtime.setMultiMode(on); btn?.setAttribute('aria-pressed', String(ok && on)); if (on && !ok) window.toast?.('Mode plusieurs cartes indisponible sur cet appareil'); return ok && on; };
  btn?.addEventListener('click', () => { const on = apply(!runtime.multiMode); try { localStorage.setItem('multiMode', on ? '1' : '0'); } catch {} window.toast?.(on ? 'Mode plusieurs cartes' : 'Mode une carte'); });
  try { if (localStorage.getItem('multiMode') === '1') { const t = setInterval(() => { if (runtime.frames?.ready || runtime.frames?.broken || !runtime.frames) { clearInterval(t); apply(true); } }, 200); } } catch {}
  return runtime;
}

window.TCGLiveLens = {
  start: stream => ensureRuntime().start(stream),
  pause: () => ensureRuntime().pause(),
  resume: () => ensureRuntime().resume(),
  stop: () => runtime?.stop(),
  setLanguage: lang => ensureRuntime().setLanguage(lang),
  cameraError: error => ensureRuntime().showCameraError(error),
  cameraPending: () => ensureRuntime().markCameraPending(),
  preload: () => ensureRuntime().preload(),
  manual: () => ensureRuntime().analyzeCurrentFrame(), // diagnostic/test only, not exposed in normal UI
  get runtime() { return runtime; },
};

window.addEventListener('load', ensureRuntime, { once: true });
