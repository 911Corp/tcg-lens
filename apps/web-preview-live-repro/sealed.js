// Sealed products (ETB, displays, boosters, bundles, tins, blisters, decks, collection boxes…):
// catalogue search, product sheet, and live barcode recognition shown as a pop-up over the camera.
// Data: canonical sealed catalogue (/api/sealed, Cardmarket + TCGplayer) and /api/barcode.
(() => {
  const $ = s => document.querySelector(s);
  const esc = t => String(t ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  const fmt = (v, c = 'EUR') => (v == null ? null : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: c, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v));
  const LANG = { en: 'Anglais', fr: 'Français', ja: 'Japonais', de: 'Allemand', es: 'Espagnol', it: 'Italien' };
  const registry = () => store.get('barcodeRegistry', {});

  function thumb(p, cls = 'sealed-thumb') {
 return p.image ? `<img class="${cls}" src="${esc(p.image)}" alt="" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls} is-empty',textContent:'▣'}))">` : `<span class="${cls} is-empty" aria-hidden="true">▣</span>`;
  }
  function priceLine(p) {
    const main = p.price ? `${fmt(p.price.center, p.price.currency)} <small>${esc(p.price.source)}</small>` : 'Prix non disponible';
    const alt = p.altPrice ? ` · ${fmt(p.altPrice.center, p.altPrice.currency)} <small>${esc(p.altPrice.source)}</small>` : '';
    return main + alt;
  }

  // ---------------------------------------------------------------- catalogue search
  window.searchSealed = async function searchSealed(q) {
    const r = await fetch(`/api/sealed?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Catalogue des produits scellés indisponible');
    const items = j.items || [];
    const meta = $('#searchMeta');
    if (!items.length) { $('#results').innerHTML = '<div class="collection-empty">Aucun produit scellé trouvé. Essayez « coffret dresseur », « display », « booster » ou le nom de l’extension.</div>'; if (meta) meta.textContent = ''; return; }
    if (meta) meta.textContent = `${j.count} produit${j.count > 1 ? 's' : ''} · prix Cardmarket et TCGplayer.`;
    $('#results').innerHTML = items.map((p, i) => `<button class="result" data-i="${i}">${thumb(p)}<span><b>${esc(p.name)}</b><small>${esc(p.typeLabel)}${p.lang ? ` · ${esc(LANG[p.lang] || p.lang)}` : ''}${p.price ? ` · ${fmt(p.price.center, p.price.currency)}` : ''}</small></span><span>›</span></button>`).join('');
    document.querySelectorAll('#results [data-i]').forEach(b => { b.onclick = () => window.openSealed(items[Number(b.dataset.i)]); });
  };

  // ---------------------------------------------------------------- product sheet
  window.openSealed = async function openSealed(p) {
    if (!p) return;
    if (!p.typeLabel && p.id) { // legacy entries (collection / registry) carry only an id
      try { const r = await fetch(`/api/sealed?id=${encodeURIComponent(p.id)}`); if (r.ok) p = { ...p, ...(await r.json()) }; } catch {}
    }
    state.lastScreen = state.screen === 'detail' ? state.lastScreen : state.screen;
    state.current = { kind: 'sealed', ...p };
    window.go('detail');
    $('#detailHero').innerHTML = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" class="sealed-hero">` : '<div class="placeholder" style="width:200px;height:200px">Produit scellé</div>';
    window.renderSealedDetail(state.current);
    if (p.cardmarketId) {
      try {
        const r = await fetch(`/api/sealed-price?id=${encodeURIComponent(p.cardmarketId)}`);
        if (r.ok && state.current?.id === p.id) { state.current.market = await r.json(); window.renderSealedDetail(state.current); }
      } catch {}
    }
  };

  window.renderSealedDetail = function renderSealedDetail(p) {
    const m = p.market || {};
    const codes = Object.entries(registry()).filter(([, v]) => v.id === p.id).map(([k]) => k);
    const pending = state.pendingBarcode;
    $('#detailContent').innerHTML = `
      <p class="eyebrow">${esc(p.typeLabel || 'Produit scellé')}${p.lang ? ` · ${esc(LANG[p.lang] || p.lang)}` : ''}${p.releaseDate ? ` · ${new Date(p.releaseDate).getFullYear()}` : ''}</p>
      <h2>${esc(p.name)}</h2>
      <div class="price-line"><strong>${p.price ? fmt(p.price.center, p.price.currency) : '—'}</strong><span class="muted tiny">${p.price ? `tendance ${esc(p.price.source)}` : 'Prix non disponible'}</span></div>
      <div class="section-title">Marché</div>
      ${p.price ? `<div class="source"><b>${esc(p.price.source)}</b><span>${fmt(p.price.center, p.price.currency)}${p.price.low != null ? ` · dès ${fmt(p.price.low, p.price.currency)}` : ''}</span></div>` : ''}
      ${p.altPrice ? `<div class="source"><b>${esc(p.altPrice.source)}</b><span>${fmt(p.altPrice.center, p.altPrice.currency)}</span></div>` : ''}
      ${m.avg7 ? `<div class="source"><b>Moyenne 7 jours</b><span>${fmt(m.avg7, 'EUR')}</span></div>` : ''}
      ${m.avg30 ? `<div class="source"><b>Moyenne 30 jours</b><span>${fmt(m.avg30, 'EUR')}</span></div>` : ''}
      ${m.heat?.score != null ? `<div class="source"><b>Heat <i>bêta</i></b><span>${m.heat.score} ${m.heat.trend === 'HEATING' ? '↗' : m.heat.trend === 'COOLING' ? '↘' : '→'}</span></div>` : ''}
      <div class="section-title">Code-barres</div>
      <div class="source"><b>${codes.length ? codes.map(esc).join(', ') : 'Aucun code associé'}</b><span>${codes.length ? 'reconnu sur cet appareil' : 'scannez la boîte pour l’associer'}</span></div>
      <button class="primary full" id="addCollection" style="margin-top:14px">Ajouter à la collection</button>
      ${pending && !codes.includes(pending) ? `<button class="secondary full" id="bindBarcode" style="margin-top:8px">Associer le code ${esc(pending)} à ce produit</button>` : ''}`;
    $('#addCollection').onclick = window.addCurrent;
    if ($('#bindBarcode')) $('#bindBarcode').onclick = () => bind(pending, p);
  };

  function bind(code, p) {
    const r = registry();
    r[code] = { id: p.id, name: p.name, typeLabel: p.typeLabel, image: p.image || null, price: p.price || null, altPrice: p.altPrice || null, lang: p.lang || null, at: Date.now(), confirmedBy: 'user' };
    store.set('barcodeRegistry', r);
    state.pendingBarcode = null;
    if (state.current?.id === p.id) window.renderSealedDetail(state.current);
    window.toast('Code-barres associé : il sera reconnu immédiatement');
  }
  window.bindBarcode = bind;

  // ---------------------------------------------------------------- live barcode pop-up
  const overlay = $('#sealedOverlay');
  let shownCode = null, hideTimer = null;

  const runtime = () => window.TCGLiveLens?.runtime;
  function show(html, code) {
    shownCode = code;
    if (runtime()) runtime().sealedMode = true;
    overlay.innerHTML = html; overlay.hidden = false;
    clearTimeout(hideTimer);
    overlay.querySelector('[data-close]')?.addEventListener('click', hide);
    // Swipe down / sideways to dismiss, like the card result.
    const sheet = overlay.querySelector('.sheet');
    if (sheet) {
      let x0 = null, y0 = null;
      sheet.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      sheet.addEventListener('touchmove', e => { if (y0 == null) return; const dy = Math.max(0, e.touches[0].clientY - y0), dx = e.touches[0].clientX - x0; sheet.style.transform = Math.abs(dx) > dy ? `translateX(${dx}px)` : `translateY(${dy}px)`; }, { passive: true });
      sheet.addEventListener('touchend', e => { if (y0 == null) return; const t = e.changedTouches[0]; const dy = t.clientY - y0, dx = t.clientX - x0; x0 = y0 = null; if (dy > 60 || Math.abs(dx) > 90) hide(); else sheet.style.transform = ''; });
    }
  }
  function hide() { overlay.hidden = true; overlay.innerHTML = ''; shownCode = null; if (runtime()) runtime().sealedMode = false; }
  window.hideSealedOverlay = hide;

  function productCard(p, code, { status, others = [] }) {
    const verified = status === 'VERIFIED' || status === 'USER';
    return `<div class="sheet sealed-sheet">
      <span class="sheet-foil" aria-hidden="true"></span>
      <button class="sealed-x" type="button" data-close aria-label="Fermer">×</button>
      <button class="sealed-main" type="button" data-open>
        ${thumb(p, 'sealed-sheet-img')}
        <span class="sealed-body">
          <span class="sheet-set">${esc(p.typeLabel)}${p.lang ? ` · ${esc(LANG[p.lang] || p.lang)}` : ''}</span>
          <span class="sheet-name">${esc(p.name)}</span>
          <span class="sealed-price">${priceLine(p)}</span>
          <span class="sealed-code">${verified ? 'Code-barres reconnu' : 'Code-barres lu'} · ${esc(code)}</span>
        </span>
      </button>
      ${verified ? '' : `<div class="sealed-actions"><button class="primary" type="button" data-confirm>C’est bien ce produit</button>${others.length ? '<button class="secondary" type="button" data-others>Autre produit</button>' : ''}</div>`}
    </div>`;
  }

  async function onBarcode(e) {
    const { code } = e.detail || {};
    if (!code || code === shownCode) return;
    if (state.screen !== 'lens') return;
    const local = registry()[code];
    if (local) {
      const p = { ...local, id: local.id };
      show(productCard(p, code, { status: 'USER' }), code);
      overlay.querySelector('[data-open]').onclick = () => window.openSealed(p);
      navigator.vibrate?.(12);
      return;
    }
    show(`<div class="sheet sealed-sheet is-loading"><span class="sheet-foil" aria-hidden="true"></span><span class="sealed-code">Code-barres ${esc(code)} · recherche du produit…</span></div>`, code);
    let j = null;
    try { const r = await fetch(`/api/barcode?code=${encodeURIComponent(code)}`); j = await r.json(); } catch {}
    if (shownCode !== code) return;
    const cands = j?.candidates || [];
    if (j?.status === 'VERIFIED' && j.product) {
      show(productCard(j.product, code, { status: 'VERIFIED' }), code);
      overlay.querySelector('[data-open]').onclick = () => window.openSealed(j.product);
      navigator.vibrate?.(12);
      return;
    }
    if (cands.length) {
      const best = cands[0];
      show(productCard(best, code, { status: 'CANDIDATE', others: cands.slice(1) }), code);
      overlay.querySelector('[data-open]').onclick = () => { state.pendingBarcode = code; window.openSealed(best); };
      overlay.querySelector('[data-confirm]').onclick = () => { bind(code, best); show(productCard(best, code, { status: 'USER' }), code); overlay.querySelector('[data-open]').onclick = () => window.openSealed(best); };
      const othersBtn = overlay.querySelector('[data-others]');
      if (othersBtn) othersBtn.onclick = () => chooseAmong(code, cands, j.title);
      return;
    }
    const known = j?.title ? `« ${esc(j.title)} »` : 'Ce code n’est pas encore dans les bases publiques.';
    show(`<div class="sheet sealed-sheet"><span class="sheet-foil" aria-hidden="true"></span><button class="sealed-x" type="button" data-close aria-label="Fermer">×</button>
      <span class="sheet-set">Code-barres ${esc(code)}</span><span class="sheet-name">Produit non reconnu</span>
      <span class="sealed-code">${known}</span>
      <div class="sealed-actions"><button class="primary" type="button" data-search>Chercher le produit</button></div></div>`, code);
    overlay.querySelector('[data-search]').onclick = () => {
      state.pendingBarcode = code; hide();
      state.kind = 'sealed'; document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x.dataset.kind === 'sealed'));
      window.go('search'); $('#searchInput').value = ''; $('#searchInput').placeholder = 'Nom du produit à associer au code-barres';
    };
  }

  function chooseAmong(code, cands, title) {
    window.modal('Quel produit ?', `${title ? `<p class="muted tiny">Base publique : « ${esc(title)} »</p>` : ''}<div class="results">${cands.map((p, i) => `<button class="result" data-c="${i}">${thumb(p)}<span><b>${esc(p.name)}</b><small>${esc(p.typeLabel)}${p.price ? ` · ${fmt(p.price.center, p.price.currency)}` : ''}</small></span><span>›</span></button>`).join('')}</div>`, 'Code-barres');
    document.querySelectorAll('#modalBody [data-c]').forEach(b => { b.onclick = () => { const p = cands[Number(b.dataset.c)]; bind(code, p); window.closeModal(); show(productCard(p, code, { status: 'USER' }), code); overlay.querySelector('[data-open]').onclick = () => window.openSealed(p); }; });
  }

  document.addEventListener('tcglens:barcode', onBarcode);
  // Card recognition and sealed products share the bottom of the screen: a locked card hides the box.
  document.addEventListener('tcglens:card-locked', hide);
  // The box left the camera: go back to card scanning automatically.
  document.addEventListener('tcglens:barcode-gone', () => { if (!overlay.querySelector('.sealed-actions') || !document.querySelector('#modal.on')) hide(); });
})();
