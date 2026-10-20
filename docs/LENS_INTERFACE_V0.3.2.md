# v0.3.2 — Lens interface pass

Branch `v0.3.1-data-freshness`. Presentation layer and runtime robustness; no threshold lowered.

## Direction
A collector's optical instrument. Graphite smoked glass over the camera; one bold element: the card
outline, whose corner brackets lengthen as evidence accumulates and which turns holographic only when the
card is identified. Barlow Semi Condensed (names, numbers, prices, tabular figures) + Barlow (text),
self-hosted (OFL). Minimum text 12 px, visible focus, reduced motion respected.

## What changed
- `lens/LensHud.js`: single, pure view model for every scanner message (plain French, actionable hints
  for glare / blur / darkness / distance / angle, index progress, why the Lens refuses to decide).
  Fixes the pill/overlay contradiction (ANALYZING vs AMBIGUOUS flicker every frame) by using the last
  fusion decision and a 700 ms hold.
- Outline drawn as SVG on the tracked quad (perspective-correct), progress-driven corners, holo on lock.
- Locked sheet: identity shown instantly from the canonical pool, market data loaded after; sequence token
  prevents a late response painting the previous card's price; missing price shown as such, never invented;
  French Heat / trend labels; printed number form (001/084); variant only when proven.
- Scan language switch on the scanner and home; synced with settings, catalogue and runtime.
- Camera errors explained (denied / no camera / busy / insecure) with a retry action.
- Catalogue: name and printed-number search through the canonical pool (extension + printed total shown).
- Home, catalogue, detail, collection, settings and help rewritten in plain French.

## Defects found while testing in Chromium with a real card video
1. **Index warm skipped 1 reference in 4** (requested 24, processed 18, cursor +24). Fixed + test.
2. **Single noisy OCR read poisoned a track** (`EO1/38` → sticky contradiction → correct card never locked).
   Introduced in v0.3.1; now requires two identical mismatching reads. Test + benchmark recall gate.
3. Background warm computed MobileNet embeddings for every reference although `query()` computes them lazily
   for final scoring; now fast descriptors only, 6 parallel loads, faster when no card is in frame (~3× here).
4. Stale market response could overwrite a newer card's sheet. Fixed + test.

Live result (headless Chromium, fake camera with 30th Celebration #001 EN): correct LOCK 3/3 via
`extreme_temporal_visual_consensus`; me05 #001 correctly held at "Lecture du numéro" (visual not extreme,
OCR unreadable on synthetic video) and escalates to "Numéro illisible" after 6 s.

## Still to prove on devices
OCR quality on real phones, lock latency, warm-up speed on iOS/Android, thermal behaviour.

## v0.3.2 — Camera-first, instant search, automatic language

**Launch.** The app opens directly on the live scanner: the camera starts on load (HUD "Activation de la
caméra" while the permission prompt is open, "Réessayer" if refused). There is no home screen. Catalogue,
collection, settings, help and the card sheet are panels sliding over the live camera (swipe down, ✕ or tap
the dimmed camera to close); confirmations are pop-ups, never native dialogs.

**Instant search.** The whole canonical pool (FR 17 113, EN 19 633, JA 3 870 references) ships as a
precomputed visual index (`data/visual-index-{lang}.json` + Int8 descriptors `.bin`, gzip `.bin.gz` inflated
with `DecompressionStream`), built in Chromium with the exact client descriptor code
(`tools/build-visual-index.mjs`). It is downloaded once at launch, before the camera permission is granted,
so the scanner compares against the full catalogue from the first frame (no progressive warm-up). Each query:
fast-descriptor prefilter over every reference grouped by printing family (top 24), then deep MobileNet
re-scoring of the best 8 in one batch; reference images load straight from the TCGdex CDN (CORS), the proxy
is only a fallback. Cadence: visual 300 ms (was 520), OCR 1.6 s (was 2.6), OCR on a dedicated 640 px
rectification.

**No language choice.** FR and EN printings share the same TCGdex id and artwork, so they form one family;
JA printings have their own ids. The physical language is proven from printed text (`LanguageEvidence.js`):
- Latin reader (eng): PV/HP, Faiblesse/Weakness, Retraite/Retreat, rules-text words, language-specific names;
- Japanese reader (jpn, title zone, in parallel): Japanese is read only when the Latin reader recognises
  almost no confident word (< 3; Latin cards give 15+) and the Japanese reader finds confident kana.
Consensus per family: multi-language → 2 agreeing reads, no disagreement; single-language in auto mode → 1
agreeing read; 2 reads of a language the printing does not exist in → AMBIGUOUS
(`language_contradiction:ja`, e.g. a Japanese card whose JA twin is missing from the catalogue). The locked
printing is the row of the proven language. A fixed scan language remains in Réglages.

**Fusion.** With a 2-read exact printed number + total consensus on the visual top, the visual score bar is
0.90 instead of 0.94 (camera vs catalogue scan); margin, votes and quality bars are unchanged.

**Measured (headless Chromium, CPU-only, synthetic camera — not a phone):** index ready 0.6 s after load;
FR Tropius me05-001 locked as *Français* without any language choice; EN Tropius language proven *Anglais*;
JA Arceus V S9-112 language proven *Japonais*, held AMBIGUOUS (near-identical JA sibling, margin < 0.06).
Benchmark 14/14, FCIR 0. Real-device latency still has to be measured.

## v0.3.3 — Status light, reliable detection, readable numbers

**Screen.** The text box is gone. A three-lamp status light sits at the top centre: red = no card / not
recognised (dim red while waiting), orange = analysing (pulsing) or action needed, green = identified. A short
tip appears under it only when the user must act (glare, too far, camera refused with "Réessayer"); a tap shows
the current explanation; a long press opens the diagnostics panel (camera size, catalogue, detection rate and
time, tracking, visual query time and top score, OCR time, language, last decision).

**Detection (`lens/EdgeRectDetector.js`).** Card borders are searched as straight lines (oriented Sobel
votes for ±12°, left/right pairs, height from the 63:88 ratio so an occluded border does not matter, side
coverage + line-contrast verification, outer edge preferred over the inner frame, per-side refinement).
Synthetic benchmark (200 scenes: plain, light, wood, fabric, busy table with other cards, hand, glare, noise,
blur): correct corners 81 % vs 43 % for the former blob detector (busy table 73 % vs 0 %); no detection on
empty tables (fabric grid included). While tracking, only ±3° around the card's angle is searched. The blob
detector remains a fallback. Rectification copies only the card's bounding box.

**Printed number.** A digits-only reader (sparse text, whitelist `0-9/`) reads the two bottom corners in
parallel; implausible reads (total > 400, number > total + 150…) are dropped because near-identical frames
repeat the same misreading.

**Speed.** Shader warm-up for the deep model at load, fixed reference batch (no WebGL recompiles), OCR passes
chained (600 ms), a language read with ≥ 4 distinct markers of one language and none of another counts twice.

**End-to-end (headless Chromium, CPU only — not a phone):** tilted FR card on a busy table, tilted FR card on
wood and EN card all lock on the right printing and language. Tests 75/75, benchmark 14/14, FCIR 0.
