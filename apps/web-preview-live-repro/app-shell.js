// Shell glue (v0.3.2): camera-first. The scanner is always the base layer and opens on launch;
// catalogue, collection, settings, help and card details are sheets over the live camera.
(() => {
  const LANGS = ['fr', 'en', 'ja'];
  const SCAN_LANGS = ['auto', ...LANGS];
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  function markScreen(id) {
    document.body.dataset.screen = id;
    document.querySelectorAll('[data-nav]').forEach(b => {
      if (b.dataset.nav === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  const originalGo = window.go;
  window.go = id => { originalGo(id); markScreen(id === 'home' ? 'lens' : id); };
  document.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => window.go(b.dataset.go); });
  document.querySelector('#sheetScrim')?.addEventListener('click', () => window.go('lens'));

  // Focusing a field inside a sliding panel must never scroll the fixed shell behind the camera.
  const shell = document.querySelector('#app');
  shell?.addEventListener('scroll', () => { if (shell.scrollTop || shell.scrollLeft) { shell.scrollTop = 0; shell.scrollLeft = 0; } });
  window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });

  // Swipe a sheet down from its grabber/top bar to close it.
  document.querySelectorAll('.screen.panel').forEach(sheet => {
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', e => {
      const t = e.target.closest('.panel-grab, .topbar');
      y0 = t && sheet.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0;
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      sheet.style.transform = dy ? `translateY(${dy}px)` : '';
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (y0 == null) return;
      sheet.style.transform = '';
      if (dy > 90) window.go('lens');
      y0 = null;
    });
  });

  /** Catalogue language (search only). Scanning never needs it. */
  function currentLang() { const v = read('lang', 'fr'); return LANGS.includes(v) ? v : 'fr'; }
  function applyLang(lang) {
    if (!LANGS.includes(lang)) return;
    write('lang', lang);
    const search = document.querySelector('#langSelect'); if (search && search.value !== lang) search.value = lang;
  }

  /** Scan scope: 'auto' (default) searches every language and proves the card's language. */
  function scanLang() { const v = read('scanLang', 'auto'); return SCAN_LANGS.includes(v) ? v : 'auto'; }
  function applyScanLang(lang) {
    if (!SCAN_LANGS.includes(lang)) return;
    write('scanLang', lang);
    const sel = document.querySelector('#scanLang'); if (sel && sel.value !== lang) sel.value = lang;
    window.TCGLiveLens?.setLanguage?.(lang);
  }

  document.querySelector('#scanLang')?.addEventListener('change', e => applyScanLang(e.target.value));
  document.querySelector('#langSelect')?.addEventListener('change', e => applyLang(e.target.value));
  document.addEventListener('tcglens:action', e => {
    if (e.detail?.id === 'retry-camera') window.startCamera?.();
    if (e.detail?.id === 'share-diagnostic') window.TCGLiveLens?.runtime?.shareDiagnostic();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('#modal.on')) window.closeModal?.(); else window.go('lens');
  });

  applyLang(currentLang());
  const sel = document.querySelector('#scanLang'); if (sel) sel.value = scanLang();
  markScreen('lens');
  window.TCGShell = { applyLang, currentLang, scanLang, applyScanLang };

  // Open straight on the live scanner. Browsers that need a gesture get a "Réessayer" in the HUD.
  const boot = () => { if (!window.TCGLiveLens) return setTimeout(boot, 50); window.TCGLiveLens.preload?.(); window.startCamera?.(); };
  if (document.readyState === 'complete') boot(); else window.addEventListener('load', boot, { once: true });
})();
