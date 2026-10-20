import { DEFAULT_POLICY, LENS_STATES } from './config.js';
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
      const dimensions = await this.camera.attach(stream);
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

  /** Download the visual index and the model before the camera is even granted. */
  preload() {
    this.lang = window.TCGShell?.scanLang?.() || this.lang || 'auto';
    this.embedding.ensureModel().then(ready => { this.stats.model = ready ? 'prêt' : 'indisponible'; this.telemetry.emit('EMBEDDING_MODEL', { ready }); });
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
    this.telemetry.emit('INDEX_READY', { precomputed: ok, refs: this.index.count(lang), error: ok ? null : this.index.preError });
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
    if ((accepted || locked) && visualDue && quality.score >= this.policy.minQualityForVisual) this._launchVisual(track, accepted || { canvas: rectified, quality, generation: track.generation, at });
    if (!locked && this.context.visualCandidates.length && at - this.context.lastOcrAt >= this.policy.ocrIntervalMs && quality.score >= this.policy.minQualityForOcr) this._launchOcr(track, this.ocrRectifier.rectify(this.video, track.quad) || accepted?.canvas || this.bestFrame.best?.canvas || rectified);
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
      const candidates = await this.index.query(frame.canvas, this.lang, this.embedding, this.policy.topK);
      this.stats.queries++; this.stats.queryMs = Math.round(performance.now() - q0);
      this.stats.top = candidates[0] ? `${candidates[0].id} ${candidates[0].score.toFixed(3)} Δ${(candidates[0].score - (candidates[1]?.score ?? 0)).toFixed(3)}${candidates[0].embeddingVerified ? '' : ' (rapide)'}` : 'aucun';
      if (!this._isCurrent(token)) return;
      c.visualCandidates = candidates;
      if (!candidates.length) {
        if (!c.locked) { this._safeTransition(LENS_STATES.UNKNOWN, { reason: this.index.count(this.lang) ? 'no_visual_match' : 'visual_index_empty' }); this._hud(true); }
        return;
      }
      const top = candidates[0], second = candidates[1];
      const margin = top.score - (second?.score ?? 0);
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
  _visualEvidence(c, top, margin, quality) {
    const languages = top.languages?.length ? top.languages : [top.lang || this.lang];
    const resolvedLang = c.langConsensus.resolved(top.id, languages);
    const row = (resolvedLang && top.byLang?.[resolvedLang]) || top;
    return {
      candidateId: top.id, score: top.score, margin, embeddingVerified: top.embeddingVerified === true,
      visualOnlyLockAllowed: row.visualOnlyLockAllowed === true, lockBlockedReason: row.lockBlockedReason || null,
      languages, resolvedLang, languageContradiction: c.langConsensus.contradicted(top.id, languages), quality,
    };
  }

  _observeLanguage(c, evidence, candidateId) {
    const top = c.visualCandidates.find(x => x.id === candidateId);
    if (!top || !evidence?.available) return;
    const languages = top.languages?.length ? top.languages : [top.lang || this.lang];
    const read = detectCardLanguage(evidence.text, top, evidence.script);
    const resolved = c.langConsensus.observe(top.id, read.lang, languages, read.strong);
    this.stats.lang = `${read.lang || '?'} → ${resolved || 'non prouvée'}`;
    this.telemetry.emit('LANGUAGE_READ', { candidateId, read: read.lang, scores: read.scores, resolved });
    if (c.visualEvidence?.candidateId === top.id) c.visualEvidence = this._visualEvidence(c, top, c.visualEvidence.margin, c.visualEvidence.quality);
  }

  async _launchOcr(track, canvas) {
    const c = this.context; if (!c || c.ocrInFlight || c.generation !== track.generation || c.locked) return;
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
    const decision = this.fusion.evaluate({ temporal, visual: c.visualEvidence, ocr: c.ocrEvidence, canonical });
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
    if (!this._safeTransition(LENS_STATES.LOCKED, detail)) {
      this.telemetry.emit('LOCK_REJECTED_STATE', { ...detail, state: this.stateMachine.state });
      return false;
    }
    // The locked printing is the row of the proven language (never a guessed one).
    const resolved = c.visualEvidence?.candidateId === candidate.id ? c.visualEvidence.resolvedLang : null;
    const row = (resolved && candidate.byLang?.[resolved]) || (candidate.languages?.length === 1 && candidate.byLang?.[candidate.languages[0]]) || candidate;
    const { byLang, languages, ...printing } = row;
    const identity = { ...printing, lang: printing.lang || (this.lang === 'auto' ? null : this.lang) };
    c.locked = { id: candidate.id, confidence: decision.confidence, identity };
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
    const result = c.changeDetector.observe({
      lockedCandidateId: c.locked.id,
      candidate: { ...candidate, margin },
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

  _maybeBarcode(at) {
    if (this.barcodeInFlight || at - this.lastBarcodeAt < this.policy.barcodeIntervalMs) return;
    this.lastBarcodeAt = at; this.barcodeInFlight = true;
    const token = this._trackToken();
    this.barcode.detect(this.video).then(result => {
      if (!result) return;
      if (!this._isTrackTokenCurrent(token)) {
        this.telemetry.emit('BARCODE_STALE_DISCARDED', { launchedFor: token, current: this._trackToken(), code: result.code });
        return;
      }
      this.telemetry.emit('BARCODE', { code: result.code, verified: result.verified });
      if (result.verified && result.match && this.context && !this.context.locked) {
        if (!this.tracker.track?.stable) {
          this.telemetry.emit('BARCODE_LOCK_DEFERRED', { reason: 'track_not_stable', candidateId: result.candidateId });
          return;
        }
        if ([LENS_STATES.TRACKING, LENS_STATES.UNKNOWN, LENS_STATES.AMBIGUOUS].includes(this.stateMachine.state)) {
          if (!this._safeTransition(LENS_STATES.ANALYZING, { reason: 'verified_barcode' })) return;
        }
        if (this.stateMachine.state === LENS_STATES.ANALYZING) {
          if (!this._safeTransition(LENS_STATES.VERIFYING, { candidateId: result.candidateId, reason: 'verified_barcode' })) return;
        }
        if (this.stateMachine.state !== LENS_STATES.VERIFYING) {
          this.telemetry.emit('BARCODE_LOCK_REJECTED_STATE', { state: this.stateMachine.state, candidateId: result.candidateId });
          return;
        }
        this._lock({ candidateId: result.candidateId, confidence: 0.995, reason: 'verified_barcode' }, { ...result.match, id: result.candidateId });
      }
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
    const model = describeHud({
      verifyingMs: c?.verifySince != null ? at - c.verifySince : 0,
      state: this.cameraError ? 'ERROR' : this.stateMachine.state,
      cameraPending: Boolean(this.cameraPending),
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
      `catalogue ${this.index.count(this.lang)} réf. (${this.lang}) · modèle ${st.model}`,
      `détection ${st.detections}/${st.ticks} images · ${st.detectMs} ms · ${st.detectSource}`,
      `suivi ${tr ? `${tr.hits} hits${tr.stable ? ' stable' : ''}` : 'aucune carte'} · qualité ${Math.round((c?.lastQuality?.score || 0) * 100)}`,
      `visuel ${st.queries} req · ${st.queryMs} ms · ${st.top || '-'}`,
      `OCR ${st.ocr} · ${st.ocrMs} ms · langue ${st.lang || '-'}`,
      `décision ${c?.lastDecision ? `${c.lastDecision.decision} ${c.lastDecision.reason}` : '-'}`,
      `dernier évènement ${event.type}`,
    ];
    this.debugNode.textContent = lines.join('\n');
  }
}

function boxQuad(b) { return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function toward(from, to, len) { const d = dist(from, to) || 1; const k = Math.min(1, len / d); return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }; }
