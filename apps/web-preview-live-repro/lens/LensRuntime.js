import { DEFAULT_POLICY, LENS_STATES, CALIBRATED_POLICY } from './config.js';

// Language belongs to the physical card in the track, whatever candidate is on top.
const CARD = 'card';
import { CameraAdapter } from './CameraAdapter.js';
import { FrameSampler } from './FrameSampler.js';
import { CardDetector } from './CardDetector.js';
import { TrackManager } from './TrackManager.js';
import { PerspectiveRectifier } from './PerspectiveRectifier.js';
import { FrameQuality } from './FrameQuality.js';
import { BestFrameSelector } from './BestFrameSelector.js';
import { VisualEmbeddingAdapter } from './VisualEmbeddingAdapter.js';
import { ANNIndex } from './ANNIndex.js';
import { OCRAdapter } from './OCRAdapter.js';
import { OCRConsensus } from './OCRConsensus.js';
import { BarcodeAdapter } from './BarcodeAdapter.js';
import { EvidenceFusion } from './EvidenceFusion.js';
import { TemporalConsensus } from './TemporalConsensus.js';
import { CanonicalResolver } from './CanonicalResolver.js';
import { LensStateMachine } from './LensStateMachine.js';
import { MarketOverlay } from './MarketOverlay.js';
import { Telemetry } from './Telemetry.js';
import { createTrackToken, isTrackTokenCurrent, createIdentityToken, isIdentityTokenCurrent } from './IdentityGuard.js';
import { ChangeDetector } from './ChangeDetector.js';
import { HudView, describeHud } from './LensHud.js';
import { detectCardLanguage, LanguageConsensus } from './LanguageEvidence.js';
import { scopeLangs } from './ANNIndex.js';

export class LensRuntime {
  constructor({ video, trackLayer, resultOverlay, hudRoot = null, statusPill = null, debugNode = null, policy = {} }) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.video = video;
    this.trackLayer = trackLayer;
    this.statusPill = statusPill;
    this.hud = new HudView(hudRoot, { onLongPress: () => this.toggleDiagnostics() });
    // Printings withdrawn this session because the printed language contradicted them: they need a
    // proven language before any new instant lock.
    this.languageSuspects = new Set();
    this.stats = { ticks: 0, detections: 0, detectSource: '-', detectMs: 0, queries: 0, queryMs: 0, ocr: 0, ocrMs: 0, top: null, lang: null, model: 'chargement' };
    this.lastHudAt = 0;
    this.cameraError = null;
    this.debugNode = debugNode;
    this.camera = new CameraAdapter(video);
    this.sampler = new FrameSampler(this.policy.detectorIntervalMs);
    this.detector = new CardDetector();
    this.tracker = new TrackManager(this.policy);
    this.rectifier = new PerspectiveRectifier({ width: this.policy.rectifiedWidth, aspect: this.policy.cardAspect });
    // OCR reads small print (001/084, PV/HP): it gets its own high-resolution rectification.
    this.ocrRectifier = new PerspectiveRectifier({ width: this.policy.ocrRectifiedWidth, aspect: this.policy.cardAspect });
    this.quality = new FrameQuality();
    this.bestFrame = new BestFrameSelector();
    this.embedding = new VisualEmbeddingAdapter();
    this.index = new ANNIndex({ maxRefs: this.policy.maxIndexRefs });
    this.ocr = new OCRAdapter();
    this.barcode = new BarcodeAdapter();
    this.fusion = new EvidenceFusion(this.policy);
    this.resolver = new CanonicalResolver();
    this.telemetry = new Telemetry({ onEvent: e => this._renderDebug(e) });
    this.stateMachine = new LensStateMachine(({ state, detail }) => this._renderState(state, detail));
    this.marketOverlay = new MarketOverlay(resultOverlay, { onOpen: card => window.openCard?.(card.id, card.lang || this.lang) });
    this.running = false;
    this.paused = false;
    this.frameHandle = null;
    this.lang = 'auto';
    this.indexDownload = null; // { done, total } while the precomputed index downloads
    this.context = null;
    this.lastBarcodeAt = 0;
    this.barcodeInFlight = false;
    this.warmTimer = null;
  }

  async start(stream) {
    this.stop({ keepCamera: true });
    // v0.3.2: scanning needs no language choice. 'auto' searches FR+EN+JA and proves the language.
    this.lang = window.TCGShell?.scanLang?.() || this.lang || 'auto';
    this.running = true; this.paused = false; this.cameraError = null; this.cameraPending = false;
    this.stateMachine.reset({ reason: 'camera_start' });
    this._hud(true);
    try {
      const dimensions = await this.camera.attach(stream, () => { this.cameraNeedsTap = true; this._hud(true); });
      this.cameraNeedsTap = false;
      this.telemetry.emit('CAMERA_READY', dimensions);
      this.embedding.ensureModel().then(ready => this.telemetry.emit('EMBEDDING_MODEL', { ready }));
      this._loadIndex();
      this._schedule();
      return true;
    } catch (error) {
      this.telemetry.emit('CAMERA_ERROR', { message: error.message });
      this.showCameraError(error);
      this._safeTransition(LENS_STATES.ERROR, { reason: error.message });
      return false;
    }
  }

  /** Calibrated thresholds belong to the calibrated index score scale (v0.3.5). */
  _applyCalibratedPolicy() {
    if (this.policy.calibratedInstant) return;
    // Thresholds calibrated with the index itself (tools/deep/train-and-export.py) take precedence.
    const cal = this.index.deep?.meta?.calibration || {};
    const fromIndex = Number.isFinite(cal.instantScore) && Number.isFinite(cal.instantMargin) ? {
      instantScore: cal.instantScore, instantMargin: cal.instantMargin,
      temporalSwitchScore: cal.instantScore, temporalSwitchMargin: cal.instantMargin,
      changeVisualScore: cal.instantScore, changeVisualMargin: cal.instantMargin,
      ...(Number.isFinite(cal.scriptGap) ? { scriptGap: cal.scriptGap } : {}),
    } : {};
    this.policy = { ...this.policy, ...CALIBRATED_POLICY, ...fromIndex };
    this.fusion.policy = { ...this.fusion.policy, ...CALIBRATED_POLICY, ...fromIndex };
    this.tracker.minStableHits = this.policy.minStableHits;
    const c = this.context;
    if (c) {
      Object.assign(c.consensus, { strongSwitchScore: this.policy.temporalSwitchScore, strongSwitchMargin: this.policy.temporalSwitchMargin });
      Object.assign(c.changeDetector, { minScore: this.policy.changeVisualScore, minMargin: this.policy.changeVisualMargin });
    }
    this.stats.mode = 'instantané (index calibré)';
  }

  /** Download the visual index and the model before the camera is even granted. */
  preload() {
    this.lang = window.TCGShell?.scanLang?.() || this.lang || 'auto';
    this.embedding.ensureModel().then(ready => { this.stats.model = ready ? `prêt (${this.embedding.backend || '?'})` : 'indisponible'; this.telemetry.emit('EMBEDDING_MODEL', { ready }); });
    return this._loadIndex();
  }

  /** The camera permission prompt is open. */
  markCameraPending() { this.cameraPending = true; this.cameraError = null; this._hud(true); }

  toggleDiagnostics() { if (!this.debugNode) return; this.debugNode.hidden = !this.debugNode.hidden; this._renderDebug({ type: 'DIAG' }, true); }

  pause() { this.paused = true; this.camera.cancel(this.frameHandle); this.frameHandle = null; }

  /** Camera could not start (permission denied, no device, insecure context). */
  showCameraError(error) {
    const name = error?.name || '';
    this.cameraError = name === 'NotAllowedError' ? 'Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, puis réessayez.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'Aucune caméra arrière détectée sur cet appareil.'
      : name === 'NotReadableError' ? 'La caméra est utilisée par une autre application. Fermez-la, puis réessayez.'
      : !window.isSecureContext ? 'La caméra nécessite une connexion sécurisée (HTTPS).'
      : 'La caméra n’a pas pu démarrer. Réessayez.';
    this.cameraPending = false;
    this._hud(true);
  }

  /** Switch scan scope ('auto' or one language): the track restarts. */
  async setLanguage(lang) {
    if (!['auto', 'fr', 'en', 'ja'].includes(lang) || lang === this.lang) return;
    this.lang = lang;
    this.telemetry.emit('LANGUAGE_CHANGED', { lang });
    this.tracker.reset(); this.context = null; this.bestFrame.reset(); this._renderTrack(null);
    this.marketOverlay.clear();
    this.stateMachine.reset({ reason: 'language_changed' });
    this._hud(true);
    if (this.running) await this._loadIndex();
  }

  /**
   * Precomputed visual index first (whole catalogue in one download, instant search). The legacy
   * progressive warm is only a fallback when the precomputed files are unavailable.
   */
  _loadIndex() {
    const lang = this.lang;
    if (this.index.usesPrecomputed(lang)) { this.indexDownload = null; return Promise.resolve(); }
    if (this.indexLoading?.lang !== lang) this.indexLoading = { lang, promise: this._doLoadIndex(lang).finally(() => { if (this.indexLoading?.lang === lang) this.indexLoading = null; }) };
    return this.indexLoading.promise;
  }

  async _doLoadIndex(lang) {
    const langs = scopeLangs(lang);
    this.indexDownload = { done: langs.filter(l => this.index.pre.isLoaded(l)).length, total: langs.length };
    this._hud(true);
    const ok = await this.index.loadPrecomputed(lang, () => {
      if (this.lang !== lang) return;
      this.indexDownload = { done: langs.filter(l => this.index.pre.isLoaded(l)).length, total: langs.length };
      this._hud(true);
    });
    if (this.lang !== lang) return;
    this.indexDownload = null;
    if (ok && this.index.usesDeep(lang)) this._applyCalibratedPolicy();
    this.telemetry.emit('INDEX_READY', { precomputed: ok, deep: this.index.usesDeep(lang), refs: this.index.count(lang), error: ok ? null : (this.index.preError || this.index.deepError) });
    if (!ok) { await this.index.load(lang === 'auto' ? 'fr' : lang); if (this.running && !this.index.warming) this._warmIndex(); }
    this._hud(true);
  }
  resume() { if (!this.running) return; this.paused = false; this._schedule(); }

  stop({ keepCamera = false } = {}) {
    this.running = false; this.paused = false;
    this.camera.cancel(this.frameHandle); this.frameHandle = null;
    if (this.warmTimer) clearTimeout(this.warmTimer); this.warmTimer = null;
    this.tracker.reset(); this.context = null; this.bestFrame.reset();
    this.trackLayer && (this.trackLayer.innerHTML = '');
    this.marketOverlay.clear();
    if (!keepCamera) this.stateMachine.reset({ reason: 'stopped' });
    this._hud(true);
  }

  async analyzeCurrentFrame() {
    const tr = this.tracker.track;
    if (!tr?.stable) return { ok: false, reason: 'no_stable_track' };
    const rectified = this.rectifier.rectify(this.video, tr.quad);
    if (!rectified) return { ok: false, reason: this.rectifier.lastValidation?.reason || 'rectification_failed' };
    const quality = { ...this.quality.score(rectified), geometry: this.rectifier.lastValidation?.score ?? 0 };
    await this._launchVisual(tr, { canvas: rectified, quality, generation: tr.generation, at: performance.now() }, true);
    return { ok: true };
  }

  _schedule() {
    if (!this.running || this.paused || this.frameHandle) return;
    this.frameHandle = this.camera.frameCallback(at => { this.frameHandle = null; this._tick(at).finally(() => this._schedule()); });
  }

  async _tick(at) {
    if (!this.running || this.paused || !this.sampler.shouldSample(at)) return;
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    // A sealed product is shown (barcode): keep reading barcodes, pause card analysis. When no
    // barcode has been seen for 6 s the shell closes the product and card scanning resumes.
    if (this.sealedMode) {
      this._renderTrack(null); this._maybeBarcode(at); this._hud();
      if (this.barcodeSeenAt && at - this.barcodeSeenAt > 6000) { this.barcodeSeenAt = null; document.dispatchEvent(new CustomEvent('tcglens:barcode-gone')); }
      return;
    }
    const d0 = performance.now();
    const detections = this.detector.detect(this.video, { angleHint: this.tracker.track?.angle ?? undefined });
    this.stats.ticks++; this.stats.detectMs = Math.round(performance.now() - d0);
    if (detections.length) { this.stats.detections++; this.stats.detectSource = detections[0].source || '-'; }
    const priorGeneration = this.tracker.track?.generation;
    const track = this.tracker.update(detections, at);
    if (!track) {
      if (this.context) this.telemetry.emit('TRACK_LOST');
      this.context = null; this.bestFrame.reset(); this._renderTrack(null);
      this.stateMachine.reset({ reason: 'no_card' });
      this.marketOverlay.clear();
      this._hud();
      this._maybeBarcode(at);
      return;
    }
    if (!this.context || priorGeneration !== track.generation || this.context.generation !== track.generation) {
      const resetState = Boolean(this.context && this.context.generation !== track.generation);
      this._newContext(track, { resetState, reason: resetState ? 'tracker_generation_changed' : 'track_context_created' });
    }
    this._renderTrack(track);
    if (!track.stable) {
      this._safeTransition(LENS_STATES.TRACKING, { hits: track.hits });
      this._hud();
      this._maybeBarcode(at); return;
    }

    if (this.stateMachine.state === LENS_STATES.TRACKING || this.stateMachine.state === LENS_STATES.UNKNOWN || this.stateMachine.state === LENS_STATES.AMBIGUOUS) this._safeTransition(LENS_STATES.ANALYZING, { generation: track.generation });
    const rectified = this.rectifier.rectify(this.video, track.quad);
    if (!rectified) { this.telemetry.emit('RECTIFY_FAIL', this.rectifier.lastValidation || {}); this._hud(); return; }
    const quality = { ...this.quality.score(rectified), geometry: this.rectifier.lastValidation?.score ?? 0 };
    this.context.lastQuality = quality;
    const accepted = this.bestFrame.consider({ canvas: rectified, quality, generation: track.generation, at });
    const locked = Boolean(this.context.locked);
    const visualDue = at - this.context.lastVisualAt >= (locked ? this.policy.lockedVisualIntervalMs : this.policy.visualIntervalMs);
    // Calibrated index: every due frame is compared (a query costs one model pass); the legacy path
    // only re-analysed sharper frames because each query downloaded reference images.
    const analyse = accepted || locked || this.policy.calibratedInstant;
    if (analyse && visualDue && quality.score >= this.policy.minQualityForVisual) this._launchVisual(track, accepted || { canvas: rectified, quality, generation: track.generation, at });
    const languagePending = Boolean(locked && this.context.locked.identity?.languageUnverified);
    // Calibrated mode: OCR is not on the critical path. It starts once the visual decision needs it
    // (artwork twins, ambiguity) or after the lock to read the language, keeping the CPU for vision.
    const ocrNeeded = !this.policy.calibratedInstant || languagePending
      || ['artwork_twins', 'language_unresolved', 'visual_candidate_needs_corroboration', 'visual_only_lock_not_permitted_for_candidate_set', 'top1_top2_margin_too_small'].includes(this.context.lastDecision?.reason);
    if (ocrNeeded && (!locked || languagePending) && this.context.visualCandidates.length && at - this.context.lastOcrAt >= this.policy.ocrIntervalMs && quality.score >= this.policy.minQualityForOcr) this._launchOcr(track, this.ocrRectifier.rectify(this.video, track.quad) || accepted?.canvas || this.bestFrame.best?.canvas || rectified);
    this._maybeBarcode(at);
    this._hud();
  }

  _newContext(track, { resetState = false, reason = 'track_generation' } = {}) {
    this.context = {
      generation: track.generation,
      consensus: new TemporalConsensus({
        strongSwitchScore: this.policy.temporalSwitchScore,
        strongSwitchMargin: this.policy.temporalSwitchMargin,
        switchVotes: this.policy.temporalSwitchVotes,
      }),
      visualCandidates: [], visualEvidence: null, ocrEvidence: null,
      ocrConsensus: new OCRConsensus({
        requiredExactVotes: this.policy.ocrExactVotes,
        requiredNameVotes: this.policy.ocrNameVotes,
        maxObservations: this.policy.ocrMaxObservations,
      }),
      ocrEpoch: 0,
      lastVisualAt: 0, lastOcrAt: 0, visualInFlight: false, ocrInFlight: false,
      locked: null,
      changeDetector: new ChangeDetector({
        minScore: this.policy.changeVisualScore,
        minMargin: this.policy.changeVisualMargin,
        votesRequired: this.policy.changeVotes,
      }),
      lastQuality: null,
      // Automatic scan: even a single-language printing needs one agreeing printed-language read.
      langConsensus: new LanguageConsensus({ singleLanguageReads: this.lang === 'auto' ? 1 : 0 }),
    };
    this.bestFrame.reset();
    if (resetState) this.stateMachine.reset({ reason, generation: track.generation, trackId: track.id });
    this.telemetry.emit('TRACK_GENERATION', { generation: track.generation, trackId: track.id, resetState, reason });
  }

  async _launchVisual(track, frame, forced = false) {
    const c = this.context; if (!c || c.visualInFlight || c.generation !== track.generation) return;
    c.visualInFlight = true; c.lastVisualAt = performance.now();
    const token = c.generation;
    try {
      const q0 = performance.now();
      const candidates = await this.index.query(frame.canvas, this.lang, this.embedding, this.policy.topK, { track: `${track.id}:${c.generation}` });
      this.stats.queries++; this.stats.queryMs = Math.round(performance.now() - q0);
      this.stats.top = candidates[0] ? `${candidates[0].id} ${candidates[0].score.toFixed(3)} Δ${(candidates[0].score - (candidates[1]?.score ?? 0)).toFixed(3)}${candidates[0].embeddingVerified ? '' : ' (rapide)'}` : 'aucun';
      if (!this._isCurrent(token)) return;
      if (candidates[0]?.calibrated) candidates.splice(0, candidates.length, ...this._resolveTwins(c, candidates));
      c.visualCandidates = candidates;
      if (!candidates.length) {
        if (!c.locked) { this._safeTransition(LENS_STATES.UNKNOWN, { reason: this.index.count(this.lang) ? 'no_visual_match' : 'visual_index_empty' }); this._hud(true); }
        return;
      }
      const top = candidates[0], second = candidates[1];
      // Calibrated index: margin against the best family that is NOT an artwork twin.
      const margin = top.calibrated && Number.isFinite(top.marginNonTwin) ? top.marginNonTwin : top.score - (second?.score ?? 0);
      const previousVisualCandidateId = c.visualEvidence?.candidateId || null;
      c.visualEvidence = this._visualEvidence(c, top, margin, frame.quality.score);
      const temporal = c.consensus.observe({ candidateId: top.id, score: top.score, margin, quality: frame.quality.score });
      if (c.ocrEpoch !== temporal.epoch) {
        this._resetOcrEvidence(c, { reason: 'temporal_epoch_changed', temporalEpoch: temporal.epoch });
      } else if (previousVisualCandidateId && previousVisualCandidateId !== top.id) {
        this._resetOcrEvidence(c, { reason: 'visual_candidate_changed', temporalEpoch: temporal.epoch });
        this.telemetry.emit('IDENTITY_VISUAL_CHANGED', {
          from: previousVisualCandidateId,
          to: top.id,
          temporalAction: temporal.lastAction,
          temporalEpoch: temporal.epoch,
        });
      }
      this.telemetry.emit('VISUAL_TOPK', {
        id: top.id, score: top.score, margin, verified: top.embeddingVerified, candidates: candidates.length,
        temporalActive: temporal.activeCandidateId, temporalAction: temporal.lastAction,
        temporalPending: temporal.pendingSwitch, temporalEpoch: temporal.epoch,
      });
      if (c.locked) { this._observePossibleChange(top, margin); return; }
      this._evaluateEvidence();
      if (forced && !c.locked && frame.quality.score >= this.policy.minQualityForOcr) this._launchOcr(track, frame.canvas);
    } catch (error) {
      this.telemetry.emit('VISUAL_ERROR', { message: error.message });
    } finally { if (this._isCurrent(token)) c.visualInFlight = false; }
  }

  /**
   * Visual evidence for the top printing family. Once the physical language is proven, lock
   * policy (visual-only permission, artwork-twin block) comes from that language's printing.
   */
  /**
   * Artwork twins (same illustration in another printing): keep the previous choice while it stays
   * in the twin group (no flip-flop between twins), switch to the twin in the card's proven language,
   * and keep as "active twins" only those compatible with that language.
   */
  _resolveTwins(c, cands) {
    const top = cands[0], twins = top.twins || [];
    if (!twins.length) { top.activeTwins = []; return cands; }
    const langsOf = id => (id === top.id ? top.languages : twins.find(t => t.id === id)?.languages) || [];
    const group = [top.id, ...twins.map(t => t.id)];
    const lang = c.langConsensus.resolved(CARD);
    // Calibrated visual script proof (Latin vs Japanese): when the image clearly favours the top
    // family's script, twins of the other script are ruled out without waiting for OCR.
    const scriptOf = ls => ((ls || []).includes('ja') ? 'ja' : 'latin');
    const visualScript = !lang && Number.isFinite(top.scriptGap) && Number.isFinite(this.policy.scriptGap) && top.scriptGap >= this.policy.scriptGap ? top.script : null;
    let chosenId = top.id;
    const prev = c.visualEvidence?.candidateId;
    if (prev && group.includes(prev) && cands.some(x => x.id === prev)) chosenId = prev;
    if (lang && !langsOf(chosenId).includes(lang)) {
      const alt = group.filter(id => langsOf(id).includes(lang) && cands.some(x => x.id === id))
        .sort((a, b) => (top.twinScores?.[b] ?? (b === top.id ? top.score : 0)) - (top.twinScores?.[a] ?? (a === top.id ? top.score : 0)))[0];
      if (alt) chosenId = alt;
    }
    if (visualScript && scriptOf(langsOf(chosenId)) !== visualScript) chosenId = top.id;
    const chosen = cands.find(x => x.id === chosenId) || top;
    chosen.calibrated = true;
    chosen.marginNonTwin = top.marginNonTwin;
    chosen.twinGroup = group;
    chosen.activeTwins = group.filter(id => id !== chosen.id && (!lang || langsOf(id).includes(lang)) && (!visualScript || scriptOf(langsOf(id)) === visualScript));
    chosen.visualScript = visualScript;
    // Printed evidence can only separate twins whose printed number/total differ (Base Set Charizard,
    // Base Set 2, Legendary Collection and the Classic Collections all print "4/102").
    const printedKey = x => (x?.printedNumber ? String(x.printedNumber) : `${String(x?.localId ?? '').replace(/^0+(?=\d)/, '')}/${x?.printedTotal ?? ''}`).toLowerCase();
    chosen.twinNumberDistinct = chosen.activeTwins.every(id => { const t = cands.find(x => x.id === id); return Boolean(t) && printedKey(t) !== printedKey(chosen); });
    if (chosen !== top) chosen.score = Math.max(chosen.score, top.score - 0.0001);
    return [chosen, ...cands.filter(x => x !== chosen)];
  }

  _visualEvidence(c, top, margin, quality) {
    const languages = top.languages?.length ? top.languages : [top.lang || this.lang];
    const resolvedLang = c.langConsensus.resolved(CARD, languages);
    const row = (resolvedLang && top.byLang?.[resolvedLang]) || top;
    return {
      candidateId: top.id, score: top.score, margin, embeddingVerified: top.embeddingVerified === true,
      visualOnlyLockAllowed: row.visualOnlyLockAllowed === true, lockBlockedReason: row.lockBlockedReason || null,
      languages, resolvedLang, languageContradiction: c.langConsensus.contradicted(CARD, languages), quality,
      languageOutside: c.langConsensus.outside(CARD, languages),
      calibrated: top.calibrated === true,
      languageProofRequired: this.languageSuspects.has(top.id),
      twinFree: top.calibrated === true ? (top.activeTwins?.length ?? 0) === 0 : undefined,
      twinNumberDistinct: top.calibrated === true ? top.twinNumberDistinct === true : undefined,
      languageWaitMs: c.langWait?.id === top.id ? performance.now() - c.langWait.since : 0,
    };
  }

  _observeLanguage(c, evidence, candidateId) {
    const top = c.visualCandidates.find(x => x.id === candidateId);
    if (!top || !evidence?.available) return;
    const languages = top.languages?.length ? top.languages : [top.lang || this.lang];
    const read = detectCardLanguage(evidence.text, top, evidence.script);
    const resolved = c.langConsensus.observe(CARD, read.lang, languages, read.strong);
    this.stats.lang = `${read.lang || '?'} → ${resolved || 'non prouvée'}`;
    this.telemetry.emit('LANGUAGE_READ', { candidateId, read: read.lang, scores: read.scores, resolved });
    if (c.visualEvidence?.candidateId === top.id) c.visualEvidence = this._visualEvidence(c, top, c.visualEvidence.margin, c.visualEvidence.quality);
  }

  async _launchOcr(track, canvas) {
    const c = this.context; if (!c || c.ocrInFlight || c.generation !== track.generation) return;
    if (c.locked && !c.locked.identity?.languageUnverified) return;
    const token = this._identityToken();
    if (!token.candidateId || token.temporalCandidateId !== token.candidateId) {
      this.telemetry.emit('OCR_SKIPPED_IDENTITY_UNSTABLE', {
        visualCandidateId: token.candidateId,
        temporalCandidateId: token.temporalCandidateId,
        temporalEpoch: token.temporalEpoch,
      });
      return;
    }
    c.ocrInFlight = true; c.lastOcrAt = performance.now();
    try {
      this.telemetry.emit('OCR_START', token);
      const o0 = performance.now();
      const evidence = await this.ocr.analyze(canvas, this.lang, c.visualCandidates);
      this.stats.ocr++; this.stats.ocrMs = Math.round(performance.now() - o0);
      evidence.text = evidence.text || '';
      // Targeted warming is global (index-level) and identity-neutral, so it runs even if this
      // OCR result turns out to be stale for the current track.
      if (evidence?.lookupItems?.length) this._warmTargeted(evidence.lookupItems);
      if (!this._isIdentityTokenCurrent(token)) {
        this.telemetry.emit('OCR_STALE_DISCARDED', {
          launchedFor: token,
          current: this._identityToken(),
          returnedCandidateId: evidence?.candidateId || null,
        });
        return;
      }
      this._observeLanguage(c, evidence, token.candidateId);
      if (c.locked) { this._afterLockLanguage(c); return; }
      const consensusEvidence = c.ocrConsensus.observe(evidence, token.candidateId);
      c.ocrEvidence = consensusEvidence;
      this.telemetry.emit('OCR_RESULT', {
        rawCandidateId: evidence.candidateId,
        rawCollectorExact: evidence.collectorExact,
        rawContradiction: evidence.contradiction,
        candidateId: consensusEvidence.candidateId,
        collectorExact: consensusEvidence.collectorExact,
        exactVotes: consensusEvidence.exactVotes,
        nameVotes: consensusEvidence.nameVotes,
        observations: consensusEvidence.observations,
        contradiction: consensusEvidence.contradiction,
        available: consensusEvidence.available,
      });
      this._evaluateEvidence();
    } catch (error) {
      this.telemetry.emit('OCR_ERROR', { message: error.message });
    } finally {
      if (this.context === c) c.ocrInFlight = false;
    }
  }

  /**
   * After an instant lock the language is read in the background: proven → shown; a language the
   * printing does not exist in (read twice) → the identification is withdrawn, never kept.
   */
  _afterLockLanguage(c) {
    const id = c.locked.identity, languages = id.languageCandidates?.length ? id.languageCandidates : [id.lang].filter(Boolean);
    const contradicted = c.langConsensus.contradicted(CARD, languages);
    if (contradicted) {
      this.telemetry.emit('LOCK_RETRACTED', { id: c.locked.id, reason: `language_contradiction:${contradicted}` });
      const blocked = c.locked.id;
      this.languageSuspects.add(blocked);
      const track = this.tracker.bumpGeneration();
      this.marketOverlay.clear();
      this._newContext(track, { resetState: true, reason: 'lock_retracted' });
      this.context.blockedId = blocked;
      this.context.lastDecision = { decision: 'AMBIGUOUS', reason: `retracted_language_contradiction:${contradicted}` };
      // The card is still in view: legal path ACQUIRING → TRACKING → ANALYZING → AMBIGUOUS.
      for (const s of [LENS_STATES.TRACKING, LENS_STATES.ANALYZING, LENS_STATES.AMBIGUOUS]) this._safeTransition(s, { reason: 'lock_retracted' });
      this._hud(true);
      return;
    }
    const lang = c.langConsensus.resolved(CARD, languages);
    if (lang) {
      const row = c.visualCandidates.find(x => x.id === c.locked.id)?.byLang?.[lang];
      const { byLang, languages: _l, ...printing } = row || id;
      c.locked.identity = { ...id, ...printing, lang, languageUnverified: false, languageCandidates: undefined };
      this.telemetry.emit('LOCK_LANGUAGE_PROVEN', { id: c.locked.id, lang });
      this.marketOverlay.showLocked(c.locked.identity, c.locked.confidence);
    }
  }

  _resetOcrEvidence(c, { reason, temporalEpoch = 0 } = {}) {
    if (!c) return;
    c.ocrEvidence = null;
    c.ocrConsensus?.reset();
    c.ocrEpoch = temporalEpoch;
    c.lastOcrAt = 0;
    this.telemetry.emit('OCR_CONSENSUS_RESET', { reason, temporalEpoch });
  }

  _evaluateEvidence() {
    const c = this.context; if (!c || !c.visualEvidence || c.locked) return;
    const temporal = c.consensus.summary();
    const canonical = this.resolver.resolve({ visualCandidates: c.visualCandidates, ocr: c.ocrEvidence });
    if (c.langWait && c.langWait.id !== c.visualEvidence.candidateId) c.langWait = null;
    if (c.langWait) c.visualEvidence.languageWaitMs = performance.now() - c.langWait.since;
    let decision = this.fusion.evaluate({ temporal, visual: c.visualEvidence, ocr: c.ocrEvidence, canonical });
    if (c.blockedId && decision.candidateId === c.blockedId && decision.decision === 'LOCK') decision = { decision: 'AMBIGUOUS', candidateId: null, confidence: 0, reason: 'retracted_language_contradiction' };
    if (decision.reason === 'language_unresolved' && !c.langWait) {
      c.langWait = { id: decision.candidateId, since: performance.now() };
      // Re-check when the grace delay expires even if no new frame evidence arrives.
      setTimeout(() => { if (this.context === c && !c.locked) this._evaluateEvidence(); }, (this.policy.languageGraceMs ?? 2500) + 50);
    }
    this.telemetry.emit('FUSION', decision);
    c.lastDecision = decision;
    if (decision.decision === 'LOCK') this._lock(decision, canonical.candidate || c.visualCandidates[0]);
    else if (decision.decision === 'AMBIGUOUS') this._safeTransition(LENS_STATES.AMBIGUOUS, { reason: decision.reason });
    else if (decision.decision === 'VERIFY') this._safeTransition(LENS_STATES.VERIFYING, { candidateId: decision.candidateId, reason: decision.reason });
    else this._safeTransition(LENS_STATES.ANALYZING, { reason: decision.reason });
    this._hud();
  }

  _lock(decision, candidate) {
    const c = this.context; if (!c || !candidate?.id) return false;
    const detail = { id: candidate.id, confidence: decision.confidence, reason: decision.reason };
    // An instant lock can come straight from ANALYZING: pass through VERIFYING (legal path).
    if (this.stateMachine.state === LENS_STATES.ANALYZING) this._safeTransition(LENS_STATES.VERIFYING, { candidateId: candidate.id, reason: decision.reason });
    if (!this._safeTransition(LENS_STATES.LOCKED, detail)) {
      this.telemetry.emit('LOCK_REJECTED_STATE', { ...detail, state: this.stateMachine.state });
      return false;
    }
    // The locked printing is the row of the proven language (never a guessed one).
    const resolved = c.visualEvidence?.candidateId === candidate.id ? c.visualEvidence.resolvedLang : null;
    // Unproven language: display the printing in the phone's language when it exists (name only;
    // the language itself stays "à confirmer").
    const uiLang = (typeof navigator !== 'undefined' ? navigator.language || 'fr' : 'fr').slice(0, 2);
    const row = (resolved && candidate.byLang?.[resolved]) || (candidate.languages?.length === 1 && candidate.byLang?.[candidate.languages[0]])
      || (decision.languageUnverified && candidate.byLang?.[uiLang]) || candidate;
    const { byLang, languages, ...printing } = row;
    const identity = decision.languageUnverified
      ? { ...printing, lang: null, languageUnverified: true, languageCandidates: candidate.languages || [printing.lang].filter(Boolean) }
      : { ...printing, lang: printing.lang || (this.lang === 'auto' ? null : this.lang) };
    c.locked = { id: candidate.id, confidence: decision.confidence, identity, group: candidate.twinGroup || [candidate.id] };
    document.dispatchEvent(new CustomEvent('tcglens:card-locked', { detail: identity }));
    this.marketOverlay.showLocked(identity, decision.confidence);
    this._renderTrack(this.tracker.track);
    this._hud(true);
    navigator.vibrate?.(12);
    return true;
  }

  _observePossibleChange(candidate, margin) {
    const c = this.context;
    if (!c?.locked || !c.changeDetector) return;
    if (![LENS_STATES.LOCKED, LENS_STATES.CHANGE_PENDING].includes(this.stateMachine.state)) {
      this.telemetry.emit('CHANGE_REJECTED_STATE', { state: this.stateMachine.state, candidateId: candidate?.id || null });
      return;
    }
    // A twin of the locked card (same artwork) is the same physical card, not a change.
    const same = c.locked.group?.includes(candidate.id);
    const result = c.changeDetector.observe({
      lockedCandidateId: c.locked.id,
      candidate: { ...candidate, id: same ? c.locked.id : candidate.id, margin },
    });
    this.telemetry.emit('CHANGE_EVIDENCE', result);

    if (result.action === 'SAME' || result.action === 'INSUFFICIENT' || result.action === 'RESET') {
      if (this.stateMachine.state === LENS_STATES.CHANGE_PENDING) {
        if (this._safeTransition(LENS_STATES.LOCKED, { id: c.locked.id, reason: result.reason })) {
          this.marketOverlay.showLocked(c.locked.identity, c.locked.confidence);
          this._hud(true);
        }
      }
      return;
    }

    if (!this._safeTransition(LENS_STATES.CHANGE_PENDING, { candidateId: result.candidateId, votes: result.votes, reason: result.reason })) return;
    this.marketOverlay.dim(true);
    this._hud(true);
    if (result.action === 'CONFIRMED') {
      const track = this.tracker.bumpGeneration();
      this._newContext(track, { resetState: false, reason: 'confirmed_card_change' });
      if (this._safeTransition(LENS_STATES.TRACKING, { reason: 'confirmed_card_change', candidateId: result.candidateId })) {
        this.marketOverlay.clear();
        this._hud(true);
      }
    }
  }

  /**
   * Barcodes (sealed products: ETB, displays, boosters…) are read continuously and independently of
   * card recognition. A code is announced once two consecutive reads agree (checksum-valid GTIN);
   * the shell resolves it to a product. The same code is not re-announced for 12 s.
   */
  _maybeBarcode(at) {
    if (this.barcodeInFlight || at - this.lastBarcodeAt < this.policy.barcodeIntervalMs) return;
    this.lastBarcodeAt = at; this.barcodeInFlight = true;
    this.barcode.detect(this.video).then(result => {
      this.stats.barcode = this.barcode.kind || '-';
      if (!result) { this.barcodeLast = null; return; }
      this.barcodeSeenAt = at;
      const prev = this.barcodeLast;
      this.barcodeLast = { gtin14: result.gtin14, at };
      if (!prev || prev.gtin14 !== result.gtin14 || at - prev.at > 2500) return;
      const announced = this.barcodeAnnounced;
      if (announced && announced.gtin14 === result.gtin14 && at - announced.at < 12000) return;
      this.barcodeAnnounced = { gtin14: result.gtin14, at };
      this.stats.lastBarcode = result.code;
      this.telemetry.emit('BARCODE', { code: result.code, gtin14: result.gtin14, format: result.format });
      document.dispatchEvent(new CustomEvent('tcglens:barcode', { detail: result }));
    }).finally(() => { this.barcodeInFlight = false; });
  }

  _renderTrack(track) {
    if (!this.trackLayer) return;
    if (!track || !this.video.videoWidth) { this.trackLayer.dataset.visible = 'false'; return; }
    if (!this.trackSvg) {
      this.trackLayer.innerHTML = `<svg class="track-svg" aria-hidden="true"><defs><linearGradient id="holo" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8ef0dd"/><stop offset=".35" stop-color="#9db4ff"/><stop offset=".68" stop-color="#f7a6dd"/><stop offset="1" stop-color="#ffe28a"/></linearGradient></defs><polygon class="track-edge"/><path class="track-corners"/></svg>`;
      this.trackSvg = this.trackLayer.firstElementChild;
    }
    const points = (track.quad?.length === 4 ? track.quad : boxQuad(track.box)).map(p => this._screenPoint(p));
    const tone = this.context?.locked ? 'locked' : this.hud.current?.tone || 'work';
    const progress = this.context?.locked ? 1 : Math.max(0.12, this.hud.current?.progress ?? 0.12);
    const edge = Math.min(dist(points[0], points[1]), dist(points[1], points[2]));
    const arm = Math.max(14, edge * (0.1 + progress * 0.28));
    let d = '';
    for (let i = 0; i < 4; i++) {
      const p = points[i], prev = points[(i + 3) % 4], next = points[(i + 1) % 4];
      const a = toward(p, prev, arm), b = toward(p, next, arm);
      d += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${p.x.toFixed(1)} ${p.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    }
    const poly = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const [edgeEl, cornersEl] = [this.trackSvg.querySelector('.track-edge'), this.trackSvg.querySelector('.track-corners')];
    edgeEl.setAttribute('points', poly);
    cornersEl.setAttribute('d', d);
    const grad = this.trackSvg.querySelector('#holo');
    grad.setAttribute('x1', points[0].x); grad.setAttribute('y1', points[0].y); grad.setAttribute('x2', points[2].x); grad.setAttribute('y2', points[2].y);
    if (this.trackLayer.dataset.tone !== tone) this.trackLayer.dataset.tone = tone;
    this.trackLayer.dataset.visible = 'true';
  }

  _screenPoint(p) {
    const b = this._screenBox({ x: p.x, y: p.y, w: 0, h: 0 });
    return { x: b.x, y: b.y };
  }

  /** Throttled HUD refresh from current runtime facts (presentation only). */
  _hud(force = false) {
    const at = performance.now();
    if (!force && at - this.lastHudAt < 180) return;
    this.lastHudAt = at;
    const c = this.context;
    const temporal = c?.consensus?.summary?.();
    const verifying = c && !c.locked && (this.stateMachine.state === LENS_STATES.VERIFYING || c.lastDecision?.decision === 'VERIFY');
    if (c) c.verifySince = verifying ? (c.verifySince ?? at) : null;
    if (this.sealedMode) { this.hud.render({ tone: 'locked', key: 'sealed', title: 'Produit reconnu par code-barres', hint: null, progress: 1 }); return; }
    const model = describeHud({
      verifyingMs: c?.verifySince != null ? at - c.verifySince : 0,
      state: this.cameraError ? 'ERROR' : this.stateMachine.state,
      cameraPending: Boolean(this.cameraPending),
      cameraNeedsTap: Boolean(this.cameraNeedsTap),
      error: this.cameraError,
      decision: c?.lastDecision || null,
      quality: c?.lastQuality || null,
      geometryReason: this.rectifier.lastValidation && this.rectifier.lastValidation.valid === false ? this.rectifier.lastValidation.reason : null,
      trackHits: this.tracker.track?.hits || 0,
      minStableHits: this.policy.minStableHits,
      temporalVotes: temporal?.top?.votes || 0,
      minTemporalVotes: this.policy.minTemporalVotes,
      ocrExactVotes: c?.ocrEvidence?.exactVotes || 0,
      requiredOcrVotes: this.policy.ocrExactVotes,
      indexCount: this.indexDownload ? 0 : this.index.count(this.lang),
      indexTarget: this.indexDownload ? 0 : this.index.target(this.lang),
      indexDownload: this.indexDownload,
      lang: this.lang,
    });
    this.hud.render(model);
    if (this.tracker.track) this._renderTrack(this.tracker.track);
  }

  _screenBox(box) {
    const r = this.video.getBoundingClientRect();
    const scale = Math.max(r.width / this.video.videoWidth, r.height / this.video.videoHeight);
    const ow = this.video.videoWidth * scale, oh = this.video.videoHeight * scale;
    const ox = (r.width - ow) / 2, oy = (r.height - oh) / 2;
    return { x: ox + box.x * scale, y: oy + box.y * scale, w: box.w * scale, h: box.h * scale };
  }

  _renderState(state, detail) {
    this._setPill(state);
    this.telemetry.emit('STATE', { state, detail });
    if (this.hud) this._hud(true);
  }

  _setPill(text) { if (this.statusPill) this.statusPill.textContent = text; }

  _safeTransition(next, detail) {
    if (next === LENS_STATES.ACQUIRING) return this.stateMachine.reset(detail);
    try {
      return this.stateMachine.transition(next, detail);
    } catch (error) {
      this.telemetry.emit('STATE_TRANSITION_REJECTED', {
        from: this.stateMachine.state,
        to: next,
        detail,
        message: error.message,
      });
      return false;
    }
  }

  _isCurrent(generation) { return this.running && this.context?.generation === generation && this.tracker.track?.generation === generation; }

  _trackToken() { return createTrackToken(this.context, this.tracker.track); }

  _isTrackTokenCurrent(token) {
    return isTrackTokenCurrent({ running: this.running, context: this.context, track: this.tracker.track }, token);
  }

  _identityToken() { return createIdentityToken(this.context, this.tracker.track); }

  _isIdentityTokenCurrent(token) {
    return isIdentityTokenCurrent({ running: this.running, context: this.context, track: this.tracker.track }, token);
  }

  _warmTargeted(items) {
    if (this.targetedWarmInFlight || this.index.usesPrecomputed(this.lang)) return; // whole catalogue already indexed
    this.targetedWarmInFlight = true;
    this.index.warmTargeted(items, this.lang, this.embedding)
      .then(added => { if (added.length) this.telemetry.emit('INDEX_TARGETED_WARM', { added: added.length, ids: added.slice(0, 6) }); })
      .catch(error => this.telemetry.emit('INDEX_TARGETED_WARM_ERROR', { message: error?.message || String(error) }))
      .finally(() => { this.targetedWarmInFlight = false; });
  }

  _warmIndex() {
    if (!this.running) return;
    this.index.warm(this.lang, this.embedding, { batch: this.policy.warmBatch }).finally(() => {
      // Warm faster while no card is in frame; back off while analysing to keep the camera loop fluid.
      if (this.running) this.warmTimer = setTimeout(() => this._warmIndex(), this.tracker.track ? 2500 : 600);
    });
  }

  _renderDebug(event, force = false) {
    if (!this.debugNode || this.debugNode.hidden) return;
    const at = performance.now();
    if (!force && at - (this.lastDebugAt || 0) < 250) return;
    this.lastDebugAt = at;
    const c = this.context, st = this.stats, tr = this.tracker.track;
    const lines = [
      `caméra ${this.video.videoWidth}×${this.video.videoHeight} · état ${this.stateMachine.state}`,
      `catalogue ${this.index.count(this.lang)} réf. (${this.lang}) · modèle ${st.model} · ${st.mode || 'standard'}`,
      `détection ${st.detections}/${st.ticks} images · ${st.detectMs} ms · ${st.detectSource}`,
      `suivi ${tr ? `${tr.hits} hits${tr.stable ? ' stable' : ''}` : 'aucune carte'} · qualité ${Math.round((c?.lastQuality?.score || 0) * 100)}`,
      `visuel ${st.queries} req · ${st.queryMs} ms · ${st.top || '-'}`,
      `OCR ${st.ocr} · ${st.ocrMs} ms · langue ${st.lang || '-'}`,
      `codes-barres ${st.barcode || '-'}${st.lastBarcode ? ` · dernier ${st.lastBarcode}` : ''}`,
      `décision ${c?.lastDecision ? `${c.lastDecision.decision} ${c.lastDecision.reason}` : '-'}`,
      `dernier évènement ${event.type}`,
    ];
    this.debugNode.textContent = lines.join('\n');
  }
}

function boxQuad(b) { return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function toward(from, to, len) { const d = dist(from, to) || 1; const k = Math.min(1, len / d); return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }; }
