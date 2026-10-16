# TCG Lens - Codex working instructions

## Mission
Build TCG Lens into a reliable iOS/Android collectible-card scanner. The current priority is to make Lens scanning actually react on real smartphones before adding more features.

## Canonical architecture that must be preserved
- PostgreSQL canonical schema and migrations `0001` through `0007` are authoritative.
- Resolution outcomes remain: `AUTO_MATCH`, `CANDIDATE_MATCH`, `CONFLICT`, `NEW_ENTITY`.
- A visual similarity score alone must never create a canonical AUTO_MATCH.
- Card identity hierarchy: `CARD_CONCEPT -> CARD_PRINTING -> CARD_VARIANT`.
- Sealed identity hierarchy: `SEALED_FAMILY -> SEALED_PRODUCT`.
- Prices attach to printings/variants/sealed products, never concepts/families.
- FR, EN and JA are first-class languages.
- Barcode normalization is GTIN-14 with EAN/UPC/JAN provenance.
- Keep ingestion provenance and source lineage intact.

## Current validated baseline
Run:

```bash
npm run validate:local
```

Expected baseline: 19 unit tests pass, all 7 SQL migrations validate, TypeScript compiles, iOS Swift syntax parses, web preview syntax passes.

Do not merge a change that makes this command fail.

## Current blocking bug
The production-style web Lens preview opens the camera on a smartphone but appears inert: the user sees no useful scan reaction or identification progression.

The relevant experimental reproduction is in:

`apps/web-preview-live-repro/`

This reproduction includes the latest local continuous Lens/embedding experiment available in the workspace. The current live Vercel deployment is `https://tcg-lens-mobile-preview.vercel.app/`, but do not treat a deployed response as proof that scanning works on-device.

## Debug priority
1. Prove `getUserMedia()` starts and `<video>` reaches `readyState >= 2` with non-zero `videoWidth/videoHeight`.
2. Prove the analysis scheduler ticks after the user gesture.
3. Prove a frame can be copied from `<video>` to canvas on iOS Safari and Android Chrome.
4. Make the UI visibly expose runtime state: CAMERA, FRAME, DETECT, TRACK, EMBED, OCR, BARCODE, RESOLVE, ERROR.
5. Add a reproducible test harness using prerecorded card footage or a deterministic synthetic MediaStream where practical.
6. Ensure expensive dependencies (OpenCV, Tesseract, TensorFlow/MobileNet) cannot block basic scan feedback.
7. Only after the minimal pipeline reacts reliably, re-enable multi-card tracking and visual embeddings.

## Required scan behavior
- Opening Lens must show an explicit camera/runtime state within 1 second after permission is granted.
- With one card centered, the UI must visibly progress through detection/analysis states even if identity fails.
- Failure must produce a visible actionable error, never silent inactivity.
- The manual Analyze button must always force a frame capture and return either candidates or a diagnostic reason.
- Barcode detection must remain independent from OCR/embedding failures.
- Visual recognition may propose candidates, but exact identity should be confirmed by temporal consistency and/or OCR/barcode when needed.

## Mobile constraints
- iOS Safari/PWA is a first-class target, not a desktop approximation.
- Do not assume `navigator.deviceMemory` exists on iOS.
- Do not assume `BarcodeDetector` exists.
- Avoid blocking `<script>` tags for large ML libraries.
- Handle page visibility/backgrounding and camera track interruption.
- `playsinline`, HTTPS, user gesture and rear-camera fallback must be maintained.
- Prefer a small dependable pipeline over a large theoretical one.

## Testing expectations
Add tests for the runtime state machine and scan scheduler. Where browser APIs are unavailable in Node, isolate them behind adapters and test the orchestration deterministically.

For browser E2E, include at least:
- camera permission granted path
- camera permission denied path
- video metadata delayed path
- zero-dimension video path
- ML dependency unavailable path
- OCR unavailable path
- barcode unsupported path
- manual analyze path
- a deterministic candidate result path

## Do not fake functionality
Do not return hard-coded card identities, prices or successful scan states just to make the UI appear active. Diagnostics may use fixtures only in an explicitly labeled test/demo mode.
