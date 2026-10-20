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
