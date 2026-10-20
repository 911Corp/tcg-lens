// Shell glue: shared navigation state and scan-language sync across screens and the Lens runtime.
(() => {
  const LANGS = ['fr', 'en', 'ja'];
  const navFor = { lens: 'lens', search: 'search', collection: 'collection', settings: 'settings', detail: null, legend: null, home: null };

  function markScreen(id) {
    document.body.dataset.screen = id;
    document.querySelectorAll('[data-nav]').forEach(b => {
      if (b.dataset.nav === navFor[id]) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  const originalGo = window.go;
  window.go = id => { originalGo(id); markScreen(id); };
  document.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => window.go(b.dataset.go); });

  function currentLang() {
    try { const v = JSON.parse(localStorage.getItem('lang')); if (LANGS.includes(v)) return v; } catch {}
    return 'fr';
  }

  function applyLang(lang, { fromRuntime = false } = {}) {
    if (!LANGS.includes(lang)) return;
    try { localStorage.setItem('lang', JSON.stringify(lang)); } catch {}
    document.querySelectorAll('[data-lang-switch] [data-lang]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.lang === lang)));
    const search = document.querySelector('#langSelect'); if (search && search.value !== lang) search.value = lang;
    const settings = document.querySelector('#settingsLang'); if (settings && settings.value !== lang) settings.value = lang;
    if (!fromRuntime) window.TCGLiveLens?.setLanguage?.(lang);
  }

  document.querySelectorAll('[data-lang-switch] [data-lang]').forEach(b => { b.addEventListener('click', () => applyLang(b.dataset.lang)); });
  document.querySelector('#settingsLang')?.addEventListener('change', e => applyLang(e.target.value));
  document.querySelector('#langSelect')?.addEventListener('change', e => applyLang(e.target.value));
  document.addEventListener('tcglens:action', e => { if (e.detail?.id === 'retry-camera') window.startCamera?.(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.closeModal?.(); });

  applyLang(currentLang());
  markScreen(document.querySelector('.screen.on')?.id || 'home');
  window.TCGShell = { applyLang, currentLang };
})();
