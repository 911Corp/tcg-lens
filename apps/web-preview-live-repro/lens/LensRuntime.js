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
import { BarcodeAdapter } from './BarcodeAdapter.js';
import { EvidenceFusion } from './EvidenceFusion.js';
import { TemporalConsensus } from './TemporalConsensus.js';
import { CanonicalResolver } from './CanonicalResolver.js';
import { LensStateMachine } from './LensStateMachine.js';
import { MarketOverlay } from './MarketOverlay.js';
import { Telemetry } from './Telemetry.js';
import { createTrackToken, isTrackTokenCurrent, createIdentityToken, isIdentityTokenCurrent } from './IdentityGuard.js';

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
    if (!rectified) return { ok: false, reason: 'rectification_failed' };
    const quality = this.quality.score(rectified);
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
    if (!this.context || priorGeneration !== track.generation || this.context.generation !== track.generation) this._newContext(track);
    this._renderTrack(track);
    if (!track.stable) {
      this._safeTransition(LENS_STATES.TRACKING, { hits: track.hits });
      this.marketOverlay.pending('TRACKING', 'Stabilisation');
      this._maybeBarcode(at); return;
    }

    if (this.stateMachine.state === LENS_STATES.TRACKING || this.stateMachine.state === LENS_STATES.UNKNOWN || this.stateMachine.state === LENS_STATES.AMBIGUOUS) this._safeTransition(LENS_STATES.ANALYZING, { generation: track.generation });
    const rectified = this.rectifier.rectify(this.video, track.quad);
    if (!rectified) { this.telemetry.emit('RECTIFY_FAIL'); return; }
    const quality = this.quality.score(rectified);
    this.context.lastQuality = quality;
    const accepted = this.bestFrame.consider({ canvas: rectified, quality, generation: track.generation, at });
    const locked = Boolean(this.context.locked);
    const visualDue = at - this.context.lastVisualAt >= (locked ? this.policy.lockedVisualIntervalMs : this.policy.visualIntervalMs);
    if ((accepted || locked) && visualDue && quality.score >= this.policy.minQualityForVisual) this._launchVisual(track, accepted || { canvas: rectified, quality, generation: track.generation, at });
    if (!locked && this.context.visualCandidates.length && at - this.context.lastOcrAt >= this.policy.ocrIntervalMs && quality.score >= this.policy.minQualityForOcr) this._launchOcr(track, accepted?.canvas || this.bestFrame.best?.canvas || rectified);
    this._maybeBarcode(at);
  }

  _newContext(track) {
    this.context = {
      generation: track.generation,
      consensus: new TemporalConsensus({
        strongSwitchScore: this.policy.temporalSwitchScore,
        strongSwitchMargin: this.policy.temporalSwitchMargin,
        switchVotes: this.policy.temporalSwitchVotes,
      }),
      visualCandidates: [], visualEvidence: null, ocrEvidence: null,
      lastVisualAt: 0, lastOcrAt: 0, visualInFlight: false, ocrInFlight: false,
      locked: null, changeCandidate: null, changeVotes: 0, lastQuality: null,
    };
    this.bestFrame.reset();
    this.telemetry.emit('TRACK_GENERATION', { generation: track.generation, trackId: track.id });
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
      c.visualEvidence = { candidateId: top.id, score: top.score, margin, embeddingVerified: top.embeddingVerified === true, quality: frame.quality.score };
      const temporal = c.consensus.observe({ candidateId: top.id, score: top.score, margin, quality: frame.quality.score });
      if (previousVisualCandidateId && previousVisualCandidateId !== top.id) {
        c.ocrEvidence = null;
        c.lastOcrAt = 0;
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
      this._safeTransition(LENS_STATES.VERIFYING, { candidateId: top.id });
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
      c.ocrEvidence = evidence;
      this.telemetry.emit('OCR_RESULT', { candidateId: evidence.candidateId, collectorExact: evidence.collectorExact, contradiction: evidence.contradiction, available: evidence.available });
      this._evaluateEvidence();
    } catch (error) {
      this.telemetry.emit('OCR_ERROR', { message: error.message });
    } finally {
      if (this.context === c) c.ocrInFlight = false;
    }
  }

  _evaluateEvidence() {
    const c = this.context; if (!c || !c.visualEvidence || c.locked) return;
    const temporal = c.consensus.summary();
    const canonical = this.resolver.resolve({ visualCandidates: c.visualCandidates, ocr: c.ocrEvidence });
    const decision = this.fusion.evaluate({ temporal, visual: c.visualEvidence, ocr: c.ocrEvidence, canonical });
    this.telemetry.emit('FUSION', decision);
    if (decision.decision === 'LOCK') this._lock(decision, canonical.candidate || c.visualCandidates[0]);
    else if (decision.decision === 'AMBIGUOUS') { this._safeTransition(LENS_STATES.AMBIGUOUS, { reason: decision.reason }); this.marketOverlay.pending('AMBIGUOUS', 'Preuves insuffisantes'); }
    else if (decision.decision === 'VERIFY') { this._safeTransition(LENS_STATES.VERIFYING, { candidateId: decision.candidateId }); this.marketOverlay.pending('VERIFYING', 'Confirmation multi-frame'); }
    else { this._safeTransition(LENS_STATES.ANALYZING, { reason: decision.reason }); this.marketOverlay.pending('ANALYZING', 'Comparaison visuelle'); }
  }

  _lock(decision, candidate) {
    const c = this.context; if (!c || !candidate?.id) return;
    c.locked = { id: candidate.id, confidence: decision.confidence };
    this._safeTransition(LENS_STATES.LOCKED, { id: candidate.id, confidence: decision.confidence, reason: decision.reason });
    const identity = { ...candidate, lang: candidate.lang || this.lang };
    this.marketOverlay.showLocked(identity, decision.confidence);
    this._renderTrack(this.tracker.track);
  }

  _observePossibleChange(candidate, margin) {
    const c = this.context; if (!c?.locked || !candidate?.embeddingVerified) return;
    if (candidate.id === c.locked.id) {
      c.changeCandidate = null; c.changeVotes = 0;
      if (this.stateMachine.state === LENS_STATES.CHANGE_PENDING) this._safeTransition(LENS_STATES.LOCKED, { id: c.locked.id, reason: 'same_card_reconfirmed' });
      return;
    }
    if (candidate.score < this.policy.lockVisualScore || margin < this.policy.lockVisualMargin) return;
    if (c.changeCandidate === candidate.id) c.changeVotes++; else { c.changeCandidate = candidate.id; c.changeVotes = 1; }
    this._safeTransition(LENS_STATES.CHANGE_PENDING, { candidateId: candidate.id, votes: c.changeVotes });
    this.marketOverlay.pending('CHANGE', 'Nouvelle carte détectée');
    if (c.changeVotes >= this.policy.changeVotes) {
      const track = this.tracker.bumpGeneration(); this._newContext(track);
      this._safeTransition(LENS_STATES.TRACKING, { reason: 'confirmed_card_change' });
      this.marketOverlay.pending('TRACKING', 'Nouvelle carte');
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
        const c = this.context; c.locked = { id: result.candidateId, confidence: 0.995 };
        this._safeTransition(LENS_STATES.LOCKED, { id: result.candidateId, reason: 'verified_barcode' });
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
    if (this.stateMachine.state === next) return this.stateMachine.transition(next, detail);
    try { return this.stateMachine.transition(next, detail); }
    catch {
      if (next === LENS_STATES.ACQUIRING) return this.stateMachine.reset(detail);
      this.stateMachine.reset({ reason: 'transition_recovery' });
      if (next === LENS_STATES.TRACKING || next === LENS_STATES.ERROR) return this.stateMachine.transition(next, detail);
      if (next === LENS_STATES.ANALYZING || next === LENS_STATES.VERIFYING || next === LENS_STATES.UNKNOWN || next === LENS_STATES.AMBIGUOUS || next === LENS_STATES.LOCKED) {
        this.stateMachine.transition(LENS_STATES.TRACKING, detail);
        if (next !== LENS_STATES.TRACKING) this.stateMachine.transition(LENS_STATES.ANALYZING, detail);
        if (next === LENS_STATES.VERIFYING || next === LENS_STATES.LOCKED) this.stateMachine.transition(LENS_STATES.VERIFYING, detail);
        if (next === LENS_STATES.LOCKED) this.stateMachine.transition(LENS_STATES.LOCKED, detail);
        else if (next === LENS_STATES.UNKNOWN || next === LENS_STATES.AMBIGUOUS) this.stateMachine.transition(next, detail);
      }
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
