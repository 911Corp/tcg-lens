# v0.4.3 — card language and script from printed text: calibration

Field report: a French 30th Celebration Pikachu (038/128, holo, in a sleeve) was never identified; two proposals kept
coming back — the FR/EN printing (038/128) and its Japanese twin (M6a 032/103, same artwork).

## Corpus (tools/deep/lang/)

- `ocrcorp.py`: 518 random FR/EN reference cards (TCGdex `high.webp`), two degradations each (480 px + blur 0.7 +
  JPEG 60; 360 px + blur 1.2 + JPEG 40), the app's OCR zones (top 32 %, bottom 31 %, 900 × 250, grey, contrast 1.55),
  Tesseract `eng` LSTM (same engine as tesseract.js 5) → 1 036 Latin reads, + 400 reads of 200 Japanese cards.
- `jacorp.py`: 339 recent FR/EN cards + 160 Japanese cards, clean and **holo** (900 foil sparkles + blur) variants,
  Latin reader and Japanese reader (`jpn` 4.0.0_best_int, as in the app) → 998 reads with script features.
- Old-era "French" TCGdex images are often English scans: every remaining "wrong" read was checked by hand and is
  English text on an image labelled French.

## Findings

| | before | v0.4.3 |
|---|---|---|
| Latin reads with a language (clean, recent sets) | 198 / 333 | 236 / 333 |
| …of which strong (one read = two) | 58 | 180 |
| True FR↔EN errors | 0 | 0 |
| Japanese rule firing on **Latin** cards (clean / holo) | 35 / 339 · 71 / 339 | 0 · 0 |
| Latin language read on Japanese cards | 0 / 720 | 0 / 720 |
| Japanese cards confirmed by the Japanese reader | 110 / 160 · 99 / 160 | unchanged |

The permissive Japanese rule (kana ≥ 4, CJK ≥ 5, ≥ 2 confident Japanese characters) fired on 10 % of clean and 21 %
of holo Latin reads: the Japanese model hallucinates kana on foil. Two such reads contradicted the FR/EN family and
restricted proposals to Japanese printings — the field report.

## Rules

1. Latin cues: rules-text vocabulary widened (FR: attaque, inflige, chaque, énergie, défausse, actif, banc, vous,
   les, des, aux…; EN: attack, does, each, energy, discard, flip, coin, the, you, may…), accented words (except
   Pokémon/Poké…), French elisions (l', d', n', qu'). A read names a language when its markers dominate (≥ 2 and none
   of the other, or ≥ 3 and ≥ 3×); strong (counts twice) at ≥ 4 and none, or ≥ 6 and ≤ 1.
2. Japanese against a Latin-only family (and in card-only reads): logistic P(Japanese) (`fitja.py`, 5-fold grouped CV)
   must be ≥ 0.98 — 0 / 678 Latin reads. Confirming a family printed in Japanese keeps the permissive rule.
3. Script proof: a Latin language read, or the Latin (FR/EN) name of a shortlisted printing read exactly (≥ 6 letters
   on an unreadable pass; 0 / 720 Japanese reads contain any of the 7 987 such names) → `latin`. Two reads, 3×
   dominance → Japanese twins are removed from the twin group and from proposals.
4. Consensus: the leading language needs 2 reads (a strong read counts 2) and ≥ 3× the others (one stray misread no
   longer blocks forever).
5. Unidentified after 1.2 s with an unstable visual top: the card is OCR-read anyway (card-only: language, script and
   printed number feed the proposals).

E2E (fake camera, HD clips built with `clip.py` / `clipholo.py`): FR Pikachu 038 → “French” after the first OCR pass;
EN Pikachu 038 → “English”; FR Noeunoeuf → “French”; holo FR Pikachu (text unreadable) → one result 038/128 (Japanese
twin ruled out by the Latin name), language FR/EN “?”; JA clips still “Japanese”.
