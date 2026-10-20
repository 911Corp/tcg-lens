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

Expected baseline (v0.3.8): resolution 4/4, ingestion 18/18, market 9/9, sealed 5/5, TCGplayer Japan gaps 5/5, Lens runtime/policy 95/95,
benchmark 19/19 with FCIR 0, TypeScript compiles, web/API syntax passes, iOS Swift syntax parses (macOS; skipped
explicitly elsewhere unless `REQUIRE_SWIFT=1`). With `TEST_DATABASE_URL` set to a database migrated with
0001-0008, the four PostgreSQL integration suites must pass too.

## v0.3.1 candidate-pool rules (do not weaken)
- The Lens candidate pool comes only from the canonical export (`npm run build:coverage`); never from raw TCGdex.
- Digital-only products (Pokémon TCG Pocket) and unreleased sets never enter the live pool.
- Visual-only locks require `visualOnlyLockAllowed === true`; `lockBlockedReason` forbids any lock.
- Set / collector number / language are corroborating evidence only; a bare local number is not printing support.
- Market coverage never affects pool membership, readiness of identity, or lock permission.
- A printed-metadata contradiction is hard only after two identical mismatching reads; one noisy OCR read must not poison a track.

## Calibrated instant recognition (v0.3.5)
- Recognition uses the calibrated index (`lens/DeepIndex.js`, `data/deep-*`, built by `tools/deep/`). Any change
  to the backbone, descriptor or preprocessing requires rebuilding it; `train-and-export.py` refuses to export if
  the held-out gate shows a wrong or open-set non-twin false lock. Bump `ASSET_CACHE` in `sw.js` after a rebuild.
- Instant visual locks are allowed only for twin-free candidates on the calibrated scale (`CALIBRATED_POLICY`);
  artwork twins always need printed evidence. Language is never guessed: shown unverified, proven in background,
  and a contradicting read withdraws the lock.
- Instant thresholds and the Latin/Japanese script gap come from `deep-index.json` (written by the training
  script's calibration); never hard-code new ones in the app. Twins printing the same number/total stay AMBIGUOUS.
- TCGplayer fills TCGdex gaps only through `tcgplayer-gap-import.ts` (provenance `BOOTSTRAP_TCGPLAYER_GAP`,
  printed numbers as assertions); the candidate pool still comes only from the canonical export.
- Per-frame image work runs in `lens/frame.worker.js` (v0.3.9); keep the in-page fallback identical (same pure
  functions). Multi-card mode (`lens/MultiScan.js`) may only name a card under the instant-lock rules
  (`multiDecision`, `twinFreeByScript`); never relax them for this mode.
- Japanese TCGplayer mapping (v0.3.8) is accepted only card by card (`checkJaPair`: unique number + species + HP);
  never map by number alone. Index files are versioned by content hash (`data/index-version.json`), so run
  `tools/stamp-index-version.mjs` (done by `deploy-preview.sh`) after any index rebuild.

## Lens interface rules (v0.3.2)
- All user-facing scanner text comes from `lens/LensHud.js` (`describeHud`): plain French, actionable, never machine state names.
- The scanner status is a traffic light (red/orange/green); text only when the user must act or taps it. Messages hold ≥ 700 ms; the outline follows the tracked quad; holo outline only when LOCKED.
- Card detection is the straight-edge rectangle search (`lens/EdgeRectDetector.js`); keep its synthetic benchmark ≥ 80 % correct and 0 detections on empty tables.
- No Identify button, no candidate picker. The app opens directly on the live scanner; catalogue, collection,
  settings, help and card details are panels over the camera, never separate pages.
- No language choice before scanning (v0.3.2): the precomputed visual index (`data/visual-index-*`, built by
  `tools/build-visual-index.mjs`) covers FR+EN+JA, candidates are grouped by printing family, and the physical
  language is proven from printed text (`lens/LanguageEvidence.js`, incl. Japanese script evidence). A
  multi-language family needs 2 agreeing reads; in auto mode a single-language printing needs 1 agreeing read;
  2 reads of a language the printing does not exist in block the lock. A fixed scan language stays available in
  Réglages. If the language stays unreadable for `languageGraceMs`, the printing locks with the language shown as
  unverified (never guessed); any foreign-language read blocks that shortcut.
- Barcodes are read continuously and independently (native or zxing-wasm); barcode → product goes through the
  verified registry, else a public-title CANDIDATE confirmed by the user. Sealed data comes from the canonical
  export `data/sealed-catalog.json` (`tools/export-sealed-catalog.mjs`).
- Run locally with `npm run dev:lens` (serves `/api/*`; needs the candidate-pool export).

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
6. Ensure expensive dependencies (OCR and embedding models) cannot block camera/detection/tracking feedback.
7. Keep the milestone single-card until detection, rectification, visual matching, temporal locking and card-change detection are proven on-device.

## Required scan behavior
- Opening Lens must show an explicit camera/runtime state within 1 second after permission is granted.
- With one card centered, the UI must visibly progress through detection/analysis states even if identity fails.
- Failure must produce a visible actionable error, never silent inactivity.
- Once camera permission is granted, recognition must run automatically; the normal Lens UI must not expose an Identify/Analyze button.
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
- automatic camera -> frame -> detection -> analysis path
- a deterministic candidate result path

## Do not fake functionality
Do not return hard-coded card identities, prices or successful scan states just to make the UI appear active. Diagnostics may use fixtures only in an explicitly labeled test/demo mode.
