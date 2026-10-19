# TCG Lens - Codex handoff

## Why this handoff exists
The Vercel smartphone preview reached a point where the camera can open but the Lens runtime does not reliably react on the user's real phone. Further direct patching of minified/browser-only scripts is no longer an acceptable development loop.

The project is therefore moving to a repository-first Codex workflow with reproducible tests before deployment.

## Known-good core
The root repository is the canonical `tcg-lens-v0.1` codebase and contains:
- canonical PostgreSQL schema and migrations `0001` to `0007`
- TCGdex FR/EN/JP bootstrap and persistence
- Cardmarket and TCGCSV enrichment
- sealed product ingestion
- EAN/UPC/JAN registry normalized to GTIN-14
- deterministic resolution engine
- Fastify API skeleton
- iOS SwiftUI/AVFoundation shell
- Android Compose/CameraX shell
- web preview

Validation at handoff:

```text
npm run validate:local -> VALIDATION OK
resolution tests: 4/4
TCGdex ingestion tests: 4/4
market connector tests: 6/6
sealed/barcode tests: 5/5
total: 19/19
```

## Broken/runtime reproduction
`apps/web-preview-live-repro/` contains the latest local reproduction of the web Lens experiment with:
- continuous camera analysis loop
- OpenCV-style contour detection experiment
- temporal tracking
- Tesseract OCR fallback
- barcode path
- TensorFlow/MobileNet-style visual embedding experiment
- IndexedDB local visual reference index
- `/api/visual-cards` reference feed
- `/api/visual-image` reference image proxy

Treat this directory as a reproduction target, not as canonical architecture.

## Symptom on the real device
The user opens Lens on a smartphone, camera appears, but scanning does not visibly progress or identify cards. Previous Vercel-side checks only proved static files/endpoints were served, not that the client runtime worked on the physical device.

## First Codex task
Create a minimal, observable `LensRuntime` and make one-card scanning respond reliably before restoring the full multi-card/embedding stack.

Suggested decomposition:

```text
CameraAdapter
FrameSampler
DetectionAdapter
BarcodeAdapter
EmbeddingAdapter
OCRAdapter
CandidateResolver
LensStateMachine
LensDiagnostics
```

The UI must expose the state machine rather than silently waiting on libraries.

## Acceptance criteria for the first PR
1. `npm run validate:local` remains green.
2. New runtime unit tests exist and pass.
3. A browser E2E test proves camera-start -> frame-ready -> analysis-triggered.
4. After camera permission, scan progression is automatic and does not require an Analyze button.
5. No heavy ML dependency is required for basic scan feedback.
6. The preview shows a diagnostic state within 1 second after camera permission is granted.
7. Deployment is done only after local/E2E tests pass.

## Later work
Once the runtime is stable:
1. calibrate single-card similarity and margin thresholds on a real card dataset
2. prove automatic card-change unlock/relock on physical devices
3. move the validated single-card pipeline into the native iOS and Android shells
4. only then restore multi-card detection/tracking
5. expand the local ANN/index and dedicated TCG embedding model
6. add sealed packaging visual recognition + barcode fusion
