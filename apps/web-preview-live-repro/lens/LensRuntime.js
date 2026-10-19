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

export class LensRuntime {
  constructor({ video, trackLayer, resultOverlay, statusPill, debugNode = null, policy = {} }) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.video = video;
    this.trackLayer = trackLayer;
    this.statusPill = statusPill;
    this.debugNode = debugNode;
    this.camera = new CameraAdapter(video);
    this.sampler = new FrameSampler(this.policy.detectorIntervalMs);
    this.detector = new CardDetector();
    this.tracker = new TrackManager(this.policy);
    this.rectifier = new PerspectiveRectifier({ width: this.policy.rectifiedWidth, aspect: this.policy.cardAspect });
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
    this.lang = 'fr';
    this.context = null;
    this.lastBarcodeAt = 0;
    this.barcodeInFlight = false;
    this.warmTimer = null;
  }

  async start(stream) {
    this.stop({ keepCamera: true });
    this.lang = document.querySelector('#langSelect')?.value || 'fr';
    this.running = true; this.paused = false;
    this.stateMachine.reset({ reason: 'camera_start' });
    this.marketOverlay.pending('CAMERA', 'Initialisation');
    try {
      const dimensions = await this.camera.attach(stream);
      this.telemetry.emit('CAMERA_READY', dimensions);
      await this.index.load(this.lang);
      this.embedding.ensureModel().then(ready => this.telemetry.emit('EMBEDDING_MODEL', { ready }));
      this._warmIndex();
      this._schedule();
      return true;
    } catch (error) {
      this.telemetry.emit('CAMERA_ERROR', { message: error.message });
      this._safeTransition(LENS_STATES.ERROR, { reason: error.message });
      return false;
    }
  }

  pause() { this.paused = true; this.camera.cancel(this.frameHandle); this.frameHandle = null; this._setPill('PAUSED'); }
  resume() { if (!this.running) return; this.paused = false; this._schedule(); }

  stop({ keepCamera = false } = {}) {
    this.running = false; this.paused = false;
    this.camera.cancel(this.frameHandle); this.frameHandle = null;
    if (this.warmTimer) clearTimeout(this.warmTimer); this.warmTimer = null;
    this.tracker.reset(); this.context = null; this.bestFrame.reset();
    this.trackLayer && (this.trackLayer.innerHTML = '');
    this.marketOverlay.clear();
    if (!keepCamera) this.stateMachine.reset({ reason: 'stopped' });
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
    const detections = this.detector.detect(this.video);
    const priorGeneration = this.tracker.track?.generation;
    const track = this.tracker.update(detections, at);
    if (!track) {
      if (this.context) this.telemetry.emit('TRACK_LOST');
      this.context = null; this.bestFrame.reset(); this._renderTrack(null);
      this.stateMachine.reset({ reason: 'no_card' });
      this.marketOverlay.pending('ACQUIRING', 'Carte recherchée');
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
      this.marketOverlay.pending('TRACKING', 'Stabilisation');
      this._maybeBarcode(at); return;
    }

    if (this.stateMachine.state === LENS_STATES.TRACKING || this.stateMachine.state === LENS_STATES.UNKNOWN || this.stateMachine.state === LENS_STATES.AMBIGUOUS) this._safeTransition(LENS_STATES.ANALYZING, { generation: track.generation });
    const rectified = this.rectifier.rectify(this.video, track.quad);
    if (!rectified) { this.telemetry.emit('RECTIFY_FAIL', this.rectifier.lastValidation || {}); return; }
    const quality = { ...this.quality.score(rectified), geometry: this.rectifier.lastValidation?.score ?? 0 };
    this.context.lastQuality = quality;
    const accepted = this.bestFrame.consider({ canvas: rectified, quality, generation: track.generation, at });
    const locked = Boolean(this.context.locked);
    const visualDue = at - this.context.lastVisualAt >= (locked ? this.policy.lockedVisualIntervalMs : this.policy.visualIntervalMs);
    if ((accepted || locked) && visualDue && quality.score >= this.policy.minQualityForVisual) this._launchVisual(track, accepted || { canvas: rectified, quality, generation: track.generation, at });
    if (!locked && this.context.visualCandidates.length && at - this.context.lastOcrAt >= this.policy.ocrIntervalMs && quality.score >= this.policy.minQualityForOcr) this._launchOcr(track, accepted?.canvas || this.bestFrame.best?.canvas || rectified);
    this._maybeBarcode(at);
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
      const candidates = await this.index.query(frame.canvas, this.lang, this.embedding, this.policy.topK);
      if (!this._isCurrent(token)) return;
      c.visualCandidates = candidates;
      if (!candidates.length) {
        if (!c.locked) { this._safeTransition(LENS_STATES.UNKNOWN, { reason: this.index.count(this.lang) ? 'no_visual_match' : 'visual_index_empty' }); this.marketOverlay.pending('UNKNOWN', this.index.count(this.lang) ? 'Aucun match fiable' : 'Index visuel en préparation'); }
        return;
      }
      const top = candidates[0], second = candidates[1];
      const margin = top.score - (second?.score ?? 0);
      const previousVisualCandidateId = c.visualEvidence?.candidateId || null;
      c.visualEvidence = { candidateId: top.id, score: top.score, margin, embeddingVerified: top.embeddingVerified === true, visualOnlyLockAllowed: top.visualOnlyLockAllowed === true, quality: frame.quality.score };
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
      const evidence = await this.ocr.analyze(canvas, this.lang, c.visualCandidates);
      if (!this._isIdentityTokenCurrent(token)) {
        this.telemetry.emit('OCR_STALE_DISCARDED', {
          launchedFor: token,
          current: this._identityToken(),
          returnedCandidateId: evidence?.candidateId || null,
        });
        return;
      }
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
    if (decision.decision === 'LOCK') this._lock(decision, canonical.candidate || c.visualCandidates[0]);
    else if (decision.decision === 'AMBIGUOUS') {
      if (this._safeTransition(LENS_STATES.AMBIGUOUS, { reason: decision.reason })) this.marketOverlay.pending('AMBIGUOUS', 'Preuves insuffisantes');
    } else if (decision.decision === 'VERIFY') {
      if (this._safeTransition(LENS_STATES.VERIFYING, { candidateId: decision.candidateId, reason: decision.reason })) this.marketOverlay.pending('VERIFYING', 'Confirmation multi-frame');
    } else {
      if (this._safeTransition(LENS_STATES.ANALYZING, { reason: decision.reason })) this.marketOverlay.pending('ANALYZING', 'Comparaison visuelle');
    }
  }

  _lock(decision, candidate) {
    const c = this.context; if (!c || !candidate?.id) return false;
    const detail = { id: candidate.id, confidence: decision.confidence, reason: decision.reason };
    if (!this._safeTransition(LENS_STATES.LOCKED, detail)) {
      this.telemetry.emit('LOCK_REJECTED_STATE', { ...detail, state: this.stateMachine.state });
      return false;
    }
    const identity = { ...candidate, lang: candidate.lang || this.lang };
    c.locked = { id: candidate.id, confidence: decision.confidence, identity };
    this.marketOverlay.showLocked(identity, decision.confidence);
    this._renderTrack(this.tracker.track);
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
        }
      }
      return;
    }

    if (!this._safeTransition(LENS_STATES.CHANGE_PENDING, { candidateId: result.candidateId, votes: result.votes, reason: result.reason })) return;
    this.marketOverlay.pending('CHANGE', 'Nouvelle carte détectée');
    if (result.action === 'CONFIRMED') {
      const track = this.tracker.bumpGeneration();
      this._newContext(track, { resetState: false, reason: 'confirmed_card_change' });
      if (this._safeTransition(LENS_STATES.TRACKING, { reason: 'confirmed_card_change', candidateId: result.candidateId })) {
        this.marketOverlay.pending('TRACKING', 'Nouvelle carte');
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
    this.trackLayer.innerHTML = '';
    if (!track || !this.video.videoWidth) return;
    const box = this._screenBox(track.box);
    const el = document.createElement('div');
    el.className = `detected-card ${this.context?.locked ? 'locked' : this.stateMachine.state === LENS_STATES.AMBIGUOUS ? 'ambiguous' : ''}`;
    Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    this.trackLayer.appendChild(el);
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

  _warmIndex() {
    if (!this.running) return;
    this.index.warm(this.lang, this.embedding, { batch: this.policy.warmBatch }).finally(() => {
      if (this.running) this.warmTimer = setTimeout(() => this._warmIndex(), 4500);
    });
  }

  _renderDebug(event) {
    if (!this.debugNode) return;
    const c = this.context;
    this.debugNode.textContent = `${event.type} · idx ${this.index.count(this.lang)} · q ${Math.round((c?.lastQuality?.score || 0) * 100)} · gen ${c?.generation || 0}`;
  }
}
