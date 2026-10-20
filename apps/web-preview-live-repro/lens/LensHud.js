/**
 * Lens HUD — single source of truth for what the scanner tells the user.
 *
 * `describeHud()` is pure: it turns runtime facts (state machine, last fusion decision, frame
 * quality, geometry, index progress) into one message with a tone, an actionable hint and a
 * progress value. `HudView` renders it with a minimum hold time so transient state hops
 * (e.g. ANALYZING <-> AMBIGUOUS on consecutive frames) never flicker on screen.
 *
 * Presentation only: nothing here influences identity decisions.
 */

import { t, locale } from './i18nRef.js';

const LANG_FR = Object.freeze({ fr: 'français', en: 'anglais', ja: 'japonais', auto: 'toutes langues' });
/** Language names in the app language. */
export const LANG_NAMES = new Proxy(LANG_FR, { get: (o, k) => (k in o ? t(o[k]) : undefined) });
export const TONES = Object.freeze(['idle', 'work', 'attention', 'fail', 'locked']);

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** Frame/geometry problems the user can fix, most actionable first. */
export function qualityProblem({ quality = null, geometryReason = null } = {}) {
  switch (geometryReason) {
    case 'quad_too_small':
    case 'edge_too_short': return { title: 'Rapprochez la carte', hint: 'Elle doit occuper au moins un tiers de l’écran.' };
    case 'quad_too_large': return { title: 'Reculez un peu', hint: 'Les quatre coins de la carte doivent rester visibles.' };
    case 'quad_out_of_bounds': return { title: 'Centrez la carte', hint: 'Un coin sort du champ de la caméra.' };
    case 'extreme_perspective':
    case 'implausible_card_aspect': return { title: 'Mettez la carte à plat', hint: 'Tenez le téléphone parallèle à la carte.' };
    default: break;
  }
  if (!quality) return null;
  if (quality.glare > 0.02) return { title: 'Reflet sur la carte', hint: 'Inclinez-la légèrement pour éviter la lumière directe.' };
  if (quality.dark > 0.3) return { title: 'Trop sombre', hint: 'Rapprochez-vous d’une source de lumière.' };
  if (quality.exposure > 0.6) return { title: 'Lumière trop forte', hint: 'Évitez le soleil ou une lampe en plein sur la carte.' };
  if (quality.sharpness != null && quality.sharpness < 0.38) return { title: 'Image floue', hint: 'Tenez le téléphone immobile une seconde.' };
  return null;
}

function indexHint({ indexCount = 0, indexTarget = 0, lang = 'fr', indexDownload = null }) {
  if (indexDownload && indexDownload.done < indexDownload.total) {
    const p = clamp01((indexDownload.done + 0.35) / indexDownload.total);
    return { text: t('Téléchargement du catalogue visuel ({p} %)', { p: Math.round(p * 100) }), progress: p };
  }
  if (!indexTarget || indexCount >= indexTarget) return null;
  const fmt = n => new Intl.NumberFormat(locale()).format(n);
  return { text: t('Préparation des cartes de référence ({lang}) : {n} sur {total}', { lang: LANG_NAMES[lang] || lang, n: fmt(indexCount), total: fmt(indexTarget) }), progress: clamp01(indexCount / indexTarget) };
}

function ambiguousHint(reason = '', lang = 'fr', idx = null) {
  if (reason.startsWith('candidate_lock_blocked')) {
    return 'Une réédition quasi identique existe et ne peut pas encore être distinguée. TCG Lens préfère ne pas trancher.';
  }
  if (reason.startsWith('retracted_language_contradiction')) {
    return 'Le texte imprimé contredit l’identification (autre langue). TCG Lens a retiré le résultat plutôt que de se tromper.';
  }
  if (reason === 'artwork_twins_same_number') return 'Cette illustration a été rééditée avec le même numéro (ex. Set de Base et Collection Classique). TCG Lens ne peut pas encore distinguer ces éditions et préfère ne pas trancher.';
  if (reason === 'artwork_twins') return 'Cette illustration existe dans plusieurs éditions : lecture du texte imprimé.';
  if (reason.startsWith('language_contradiction')) {
    const l = reason.split(':')[1];
    return t('La carte semble être en {lang}, mais cette édition n’existe pas dans cette langue au catalogue. TCG Lens préfère ne pas trancher.', { lang: LANG_NAMES[l] || l });
  }
  if (reason.includes('contradiction') || reason.includes('collector_identifier_conflict')) {
    if (lang === 'auto') return 'Le numéro lu ne correspond pas à l’image. Rendez le bas de la carte bien lisible.';
    return t('Le numéro lu ne correspond pas à l’image. Vérifiez que la carte est bien en {lang}.', { lang: LANG_NAMES[lang] || lang });
  }
  // While references are still loading, the true card may simply not be comparable yet.
  if (idx) return t('Cette carte n’est peut-être pas encore chargée. {text}.', { text: idx.text });
  if (reason.includes('margin')) return 'Plusieurs cartes se ressemblent. Approchez-vous pour rendre le numéro lisible.';
  return 'Approchez-vous pour rendre le numéro en bas de la carte lisible.';
}

/**
 * @param {object} input
 * @param {string} input.state           Lens state machine state
 * @param {object} [input.decision]      last EvidenceFusion decision for the current track
 * @param {object} [input.quality]       last FrameQuality result
 * @param {string} [input.geometryReason] last quad validation reason
 * @param {number} [input.trackHits] @param {number} [input.minStableHits]
 * @param {number} [input.temporalVotes] @param {number} [input.minTemporalVotes]
 * @param {number} [input.ocrExactVotes] @param {number} [input.requiredOcrVotes]
 * @param {number} [input.indexCount] @param {number} [input.indexTarget]
 * @param {string} [input.lang] @param {string} [input.error]
 */
export function describeHud(input = {}) {
  const { state, decision = null, lang = 'fr' } = input;
  const idx = indexHint(input);

  if (state === 'ERROR' || input.error) {
    return { tone: 'fail', key: 'error', title: 'Caméra indisponible', hint: input.error || 'Autorisez l’accès à la caméra dans les réglages du navigateur, puis réessayez.', progress: null, action: { id: 'retry-camera', label: 'Réessayer' } };
  }
  if (input.cameraNeedsTap) {
    return { tone: 'attention', key: 'camera-tap', title: 'Touchez l’écran', hint: 'Le navigateur attend un geste pour lancer la caméra (mode économie d’énergie).', progress: null };
  }
  if (input.cameraPending) {
    return { tone: 'idle', key: 'camera-pending', title: 'Activation de la caméra', hint: 'Autorisez l’accès à la caméra si le navigateur le demande.', progress: idx ? idx.progress : null };
  }
  if (state === 'LOCKED') return { tone: 'locked', key: 'locked', title: 'Carte identifiée', hint: null, progress: 1 };
  if (state === 'CHANGE_PENDING') return { tone: 'work', key: 'change', title: 'Nouvelle carte ?', hint: 'Gardez-la en place quelques instants pour confirmer.', progress: null };
  if (state === 'ACQUIRING' || !state) {
    return { tone: 'idle', key: 'acquire', title: 'Placez une carte dans le cadre', hint: idx?.text || 'Une seule carte, face visible, sur un fond uni.', progress: idx ? idx.progress : null };
  }
  if (state === 'TRACKING') {
    return { tone: 'work', key: 'track', title: 'Carte repérée', hint: 'Ne bougez plus.', progress: clamp01((input.trackHits || 0) / (input.minStableHits || 4)) * 0.25 };
  }

  const problem = qualityProblem(input);
  const kind = decision?.decision;

  if (state === 'UNKNOWN') {
    if (idx) return { tone: 'attention', key: 'unknown-index', title: 'Cartes de référence en préparation', hint: t('{text}. La reconnaissance s’améliore à mesure.', { text: idx.text }), progress: idx.progress };
    if (problem) return { tone: 'attention', key: `q-${problem.title}`, ...problem, progress: null };
    return { tone: 'fail', key: 'unknown', title: 'Carte non reconnue', hint: lang === 'auto' ? 'Cette carte n’est pas encore au catalogue, ou l’image est trop différente. Essayez sous un autre angle.' : t('Vérifiez que la langue de scan correspond à la carte ({lang}).', { lang: LANG_NAMES[lang] || lang }), progress: null };
  }

  if (state === 'AMBIGUOUS' || kind === 'AMBIGUOUS') {
    if (problem) return { tone: 'attention', key: `q-${problem.title}`, ...problem, progress: null };
    return { tone: 'attention', key: `amb-${decision?.reason || ''}`, title: 'Identification incertaine', hint: ambiguousHint(decision?.reason || '', lang, idx), progress: idx ? idx.progress : null };
  }

  if (problem) return { tone: 'attention', key: `q-${problem.title}`, ...problem, progress: null };

  if ((state === 'VERIFYING' || kind === 'VERIFY') && (input.verifyingMs || 0) > 6000) {
    return { tone: 'attention', key: 'verify-stuck', title: 'Numéro illisible', hint: 'Approchez le téléphone du bas de la carte : le numéro (par exemple 001/084) doit être net et sans reflet.', progress: 0.6 };
  }
  if ((state === 'VERIFYING' || kind === 'VERIFY') && decision?.reason === 'language_unresolved') {
    return { tone: 'work', key: 'verify-lang', title: 'Lecture de la langue', hint: 'Cette carte existe en plusieurs langues : gardez le texte de la carte lisible.', progress: 0.8 };
  }
  if (state === 'VERIFYING' || kind === 'VERIFY') {
    const ocr = clamp01((input.ocrExactVotes || 0) / (input.requiredOcrVotes || 2));
    return { tone: 'work', key: 'verify', title: 'Lecture du numéro', hint: 'Le numéro imprimé en bas de la carte confirme l’édition exacte.', progress: 0.6 + ocr * 0.35 };
  }

  const votes = clamp01((input.temporalVotes || 0) / (input.minTemporalVotes || 4));
  return { tone: 'work', key: 'analyze', title: 'Comparaison avec le catalogue', hint: idx?.text || 'Quelques secondes.', progress: 0.25 + votes * 0.35 };
}

/** Traffic-light lamp for a HUD tone. */
export const LAMP = Object.freeze({ idle: 'red', fail: 'red', work: 'orange', attention: 'orange', locked: 'green' });

/**
 * v0.3.3 status light: three lamps (red / orange / green) instead of a text box. Text appears only
 * when the user must act (attention, failure, camera error) or after a tap on the light; a long
 * press toggles the diagnostics panel.
 */
export class HudView {
  constructor(root, { minHoldMs = 700, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), onLongPress = null } = {}) {
    this.root = root;
    this.minHoldMs = minHoldMs;
    this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.current = null; this.shownAt = -Infinity; this.pending = null; this.timer = null;
    this.revealUntil = 0; this.revealTimer = null;
    if (root) {
      root.innerHTML = '<button type="button" class="tl" aria-describedby="tlTip"><span class="tl-lamp" data-lamp="red"></span><span class="tl-lamp" data-lamp="orange"></span><span class="tl-lamp" data-lamp="green"></span></button>'
        + '<div class="tl-tip" id="tlTip" role="status" aria-live="polite" hidden><b class="tl-title"></b><span class="tl-hint"></span><button type="button" class="tl-action" hidden></button></div>';
      const light = root.querySelector('.tl');
      let pressTimer = null, long = false;
      light.addEventListener('pointerdown', () => { long = false; pressTimer = setTimeout(() => { long = true; onLongPress?.(); }, 650); });
      const end = () => { clearTimeout(pressTimer); };
      light.addEventListener('pointerup', end); light.addEventListener('pointerleave', end);
      light.addEventListener('click', () => { if (long) return; this.reveal(3500); });
      root.querySelector('.tl-action').addEventListener('click', e => {
        const id = e.currentTarget.dataset.action;
        if (id) root.dispatchEvent(new CustomEvent('tcglens:action', { bubbles: true, detail: { id } }));
      });
    }
  }

  /** Show the explanation of the current state for a few seconds (tap on the light). */
  reveal(ms = 3500) {
    this.revealUntil = this.now() + ms;
    if (this.revealTimer) this.cancel(this.revealTimer);
    this.revealTimer = this.schedule(() => { this.revealTimer = null; if (this.current) this._paint(this.current, false); }, ms + 20);
    if (this.current) this._paint(this.current, true);
  }

  /** Immediate tones (locked, idle, fail) replace instantly; others respect the hold time. */
  render(model) {
    if (!model) return;
    if (this.current && this.current.key === model.key) {
      // The shown message is valid again: drop any queued replacement (prevents A→B→A flicker).
      this.pending = null;
      if (this.timer) { this.cancel(this.timer); this.timer = null; }
      this._paint(model, false);
      return;
    }
    const immediate = model.tone === 'locked' || model.tone === 'idle' || model.tone === 'fail' || !this.current;
    const elapsed = this.now() - this.shownAt;
    if (immediate || elapsed >= this.minHoldMs) { this._commit(model); return; }
    this.pending = model;
    if (!this.timer) this.timer = this.schedule(() => { this.timer = null; if (this.pending) this._commit(this.pending); }, this.minHoldMs - elapsed);
  }

  _commit(model) {
    if (this.timer) { this.cancel(this.timer); this.timer = null; }
    this.pending = null;
    this.current = model; this.shownAt = this.now();
    this._paint(model, true);
  }

  /** Text is shown only when the user has something to do, or asked (tap). */
  tipVisible(model) {
    if (!model) return false;
    if (model.action) return true;
    if (this.now() < this.revealUntil) return model.tone !== 'locked';
    return (model.tone === 'attention' || model.tone === 'fail') && model.key !== 'unknown-index';
  }

  _paint(model, changed) {
    this.current = { ...model, key: model.key };
    if (!this.root) return;
    this.root.dataset.tone = model.tone;
    this.root.dataset.lamp = LAMP[model.tone] || 'red';
    const light = this.root.querySelector('.tl');
    light.setAttribute('aria-label', `${model.title}${model.hint ? `. ${model.hint}` : ''}`);
    const tip = this.root.querySelector('.tl-tip');
    tip.hidden = !this.tipVisible(model);
    tip.querySelector('.tl-title').textContent = model.title;
    const hint = tip.querySelector('.tl-hint'); hint.textContent = model.hint || ''; hint.hidden = !model.hint;
    const action = tip.querySelector('.tl-action');
    action.hidden = !model.action; action.textContent = model.action?.label || ''; action.dataset.action = model.action?.id || '';
  }
}
