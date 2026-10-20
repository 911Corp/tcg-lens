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
  });
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
