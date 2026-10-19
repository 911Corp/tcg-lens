# TCG Lens single-card runtime v0.2 candidate

Date: 2026-10-19
Status: repository candidate, not mobile-hardware proven

## Goal

The current milestone is intentionally narrow: make one raw Pokemon TCG card react reliably in the live camera before restoring multi-card or adding product surface.

Normal Lens behavior is now automatic after camera permission:

`CAMERA -> DETECT -> TRACK -> RECTIFY -> QUALITY/BEST FRAME -> VISUAL TOP-K -> OCR CORROBORATION -> EVIDENCE FUSION -> TEMPORAL CONSENSUS -> CANONICAL RESOLUTION -> LOCK -> MARKET OVERLAY`

There is no Identify button in the normal Lens UI and no candidate picker. Insufficient evidence remains `AMBIGUOUS` or `UNKNOWN`.

## Runtime modules

Browser implementation lives under `apps/web-preview-live-repro/lens/`:

- `CameraAdapter`
- `FrameSampler`
- `CardDetector`
- `TrackManager`
- `FrameQuality`
- `BestFrameSelector`
- `PerspectiveRectifier`
- `VisualEmbeddingAdapter`
- `ANNIndex`
- `OCRAdapter`
- `BarcodeAdapter`
- `EvidenceFusion`
- `TemporalConsensus`
- `LensStateMachine`
- `CanonicalResolver`
- `MarketOverlay`
- `Telemetry`
- `LensRuntime`

## Concurrency model

The camera/detection loop never waits for OCR or network enrichment.

Fast path:

- frame callback
- single-card detection
- tracking
- perspective rectification
- quality / best-frame selection
- visual matching task launch

Slow path:

- persistent OCR worker
- barcode observation
- visual index warming / reference enrichment
- full card + market retrieval after lock

Async work is bound to a track `generation`. Results from an obsolete generation are discarded, preventing OCR/model/network work for card A from mutating card B.

## Initial conservative lock policy

These values are starting calibration parameters, not product truth:

- minimum stable detection hits: 4
- visual candidate threshold: 0.84
- normal lock visual score: >= 0.94
- normal lock top1/top2 margin: >= 0.06
- temporal votes: >= 4
- visual-only fallback requires verified deep embedding, score >= 0.965, margin >= 0.09 and >= 5 observations
- a fast handcrafted prefilter is never lock-eligible by itself
- a strong OCR/canonical contradiction prevents lock
- a small top1/top2 margin resolves to `AMBIGUOUS`

The normal preferred lock path is deep visual evidence + temporal convergence + targeted OCR corroboration. The extreme visual-only path exists for cases where OCR cannot read the printing, but it is intentionally stricter.

## OCR

OCR is complementary evidence, not the recognition engine.

- one persistent Tesseract worker per active language
- top card zone targets the name
- bottom card zone targets collector number
- exact collector-number evidence can corroborate the visual top candidate
- strong conflicting collector/name evidence blocks a visual lock

## Card change

A locked card continues to receive lower-frequency visual checks. If a different candidate reaches strict visual score/margin thresholds for 3 observations, the runtime enters `CHANGE_PENDING`, increments the track generation and starts a fresh identification cycle. Lost tracks also invalidate the generation.

## UI

The current HTML/CSS removes:

- fake smartphone frame
- fake time/network/battery
- static center card reticle
- manual Identify / Barcode buttons
- opaque scan panels
- fake card artwork in the ambient background

The camera is the main canvas. Non-camera views use a low-contrast perspective grid. Lens status/result surfaces and bottom navigation are translucent.

The locked overlay shows identity, set/number/language, market price, trend, Heat Beta, supply/demand availability and identification confidence. Full detail opens on tap.

## Heat / supply-demand truthfulness

The target Heat model remains:

- Sales Velocity 35%
- Sell-through 25%
- Demand Momentum 20%
- Market Depth 10%
- Price Momentum 10%

The current web API does not have confirmed sales velocity, sell-through, demand momentum or market-depth inputs. It therefore exposes only a clearly marked partial `Heat Beta` based on the available Price Momentum component and reports coverage `0.10`. Missing components remain `null`.

Supply/demand tension currently returns `Beta N/A`; no stock or sold-volume values are fabricated.

## Validation

`npm run validate:local` now includes the existing 19 core tests plus 9 Lens runtime/policy tests.

The Lens tests cover:

- legal state transitions
- no lock from score alone before temporal policy
- no lock from unverified visual prefilter
- OCR corroborated lock
- ambiguous small margin
- OCR contradiction
- strict visual-only consensus
- track generation change
- camera-first DOM contract

## Remaining proof gate

This candidate is not declared reliable until it is run on real mobile hardware with a controlled one-card corpus. Required next evidence:

1. camera starts on iOS Safari/PWA and Android Chrome
2. detector follows a real card without synthetic fallback boxes
3. rectified crop is visually correct under tilt
4. one known card converges repeatedly without false locks
5. visually similar printings remain ambiguous until corroborated
6. card A -> empty -> card B and card A -> card B in-place both unlock/relock correctly
7. glare, sleeve, blur and partial occlusion fail safely

Do not start multi-card work before this gate passes.
