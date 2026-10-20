# v0.3.1 — Data Freshness + Candidate Intelligence

Status: **implemented and locally validated; production remains BLOCKED** (physical Gold Validation Set,
real-device benchmarks, specialized embedding, IP review — unchanged from v0.3).

Branch: `v0.3.1-data-freshness` on top of canonical `main` @ `f092939` (history preserved).
Audit date: 2026-10-20 (Europe/Paris). Source snapshots: TCGdex fetched 2026-10-19T22:5x UTC; Cardmarket
catalog `createdAt 2026-10-19T12:36:50+0200`, price guide `2026-10-19T02:42:46+0200`; TCGCSV live on 2026-10-19/20.

## 1. What was run against a real database

PostgreSQL 16.15 + pgvector 0.6.0 + pgcrypto (local, this environment). Migrations **0001–0008 applied**
for real (the v0.3 "SQL migrations PASS" gate only grepped for `BEGIN;`/`COMMIT;`).

| Step | Result |
|---|---|
| TCGdex snapshot FR/EN/JA | 606 sets, 58,687 cards, 0 fetch failures |
| TCGdex canonical bootstrap | 58,678 printings, 86,813 variants, **0 identity conflicts**, 9 quarantined FR records (`pl4-AR*`, no set name) |
| Image probes (`low.webp`) | 44,202 probed, 44,129 OK, 73 unusable |
| Cardmarket singles via existing enrichment | **0 mapped** (73,629 "insufficient identity") — see §3.1 |
| Cardmarket crosswalk (new) | 24,890 assertions confirmed (verified links), 656 name conflicts refused |
| TCGCSV categories 3 + 85 | 681 groups, 63,601 products, 73,952 price rows |
| TCGplayer crosswalk (new) | 17,273 verified (incl. 5,620 JA), 13,417 FR→EN-product assertions refused |
| Coverage build | 5.3 s; report + visual-index build + candidate-pool export |

## 2. Coverage as of 2026-10-20 (physical sets)

| Lang | Printings / expected | Images OK | Visual-indexed | Variants | Cardmarket | TCGplayer | Priced | Live pool | Visual-only lockable |
|---|---|---|---|---|---|---|---|---|---|
| EN | 21,256 / 21,484 | 92.4% | 92.4% | 100% | 53.8% | 76.7% | 81.2% | 19,633 | 9,064 |
| FR | 20,045 / 20,340 | 85.4% | 85.4% | 100% | 52.4% | 0% (by design) | 52.4% | 17,113 | 9,162 |
| JA | 12,781 / 18,031 | 30.3% | 30.3% | 100% | 0% | 38.7% | 37.7% | 3,870 | 1,352 |

Readiness (sets): EN 58 LENS_READY / 53 VISUAL_COMPLETE / 88 IDENTITY_COMPLETE; FR 45 / 51 / 80;
JA 16 / 5 / 94 with **68 JA sets DISCOVERED but empty** (TCGdex JA set details list cards its card
endpoint does not return). 15 EN + 15 FR sets are **EXCLUDED** as Pokémon TCG Pocket (digital-only).

Latest sets:

| Set | EN | FR | JA |
|---|---|---|---|
| 30th Celebration (2026-09-16) | VISUAL_COMPLETE — 158/158 images, **Cardmarket 0%** (TCGdex marketplace IDs pending, cf. PR #2370), TCGplayer 38.6% | VISUAL_COMPLETE, no market | not in TCGdex JA |
| 30th-c Classic Collection | IDENTITY_COMPLETE — **0/30 images**, not in pool | same | — |
| me05 / Nuit Noire (2026-07-17) | LENS_READY | IDENTITY_COMPLETE (1 missing image) | — |
| M6 / M5 / M4 / M3 / MC / M2a (JA) | — | — | IDENTITY_COMPLETE, **0% images** |
| ME06 Delta Reign (2026-11-06) | absent from TCGdex; TCGCSV group 24831 lists 21 sealed pre-order products; **0 card printings promoted** | — | — |

Full per-set tables: `docs/reports/coverage-2026-10-20/` (Markdown, CSV, summary JSON).

## 3. Defects found and fixed

1. **`npm install` failed** — two workspaces named `tcg-lens-mobile-preview`.
2. **Cardmarket re-enrichment not idempotent** — duplicate verified IDs per re-run (found by running the integration test on real Postgres for the first time).
3. **TCGdex iterator silently dropped cards** — fetches removed themselves from the in-flight set on settle; cards resolving while the consumer was busy were never yielded (45/50 in a live trial). Replaced with a buffered bounded map + retries + per-card failure reporting.
4. **One invalid upstream record aborted a whole language** — now quarantined with an open `SOURCE_RECORD_INVALID` conflict.
5. **Live pool contamination** — `/api/visual-cards` warmed raw TCGdex sets newest-first, including **Pokémon TCG Pocket (digital-only)** and any unreleased set, with no image validation. The on-device IndexedDB is bumped to `tcg-lens-ann-v3` to discard those refs.
6. **Cardmarket enrichment could never work on the real feed** — the public catalog has no collector number or expansion name. Replaced by a crosswalk: TCGdex-asserted `idProduct` verified against the catalog (single, base name — via the EN sibling for FR/JA — expansion consistency, uniqueness).
7. **Cross-source zero padding** — TCGdex `33` vs TCGplayer `033/192`. New comparison-only key `collectorNumberMatchKeyV1` / SQL `collector_number_match_key()` (TS/SQL parity 2,329/2,329). Canonical keys unchanged. TCGCSV auto-matches 11,664 → 16,382.
8. **Unanchored TCGplayer mappings** — rule `TCGCSV_NUMBER_NAME_LANGUAGE_UNIQUE` auto-mapped without set/group agreement; **23% disagreed** with TCGdex assertions. Rule demoted to `CANDIDATE_MATCH`; 1,194 existing mappings demoted by `db/maintenance/v0.3.1_demote_unanchored_tcgplayer_mappings.sql`. Remaining TCGplayer/TCGdex disagreements: 7 (surfaced as blockers).
9. **OCR "collector exact" from a bare local number** — `199` matches hundreds of sets and `/api/cards` truncated to 60 results. See §4.
10. Coverage query took >10 min (missing reverse indexes) — indexes added in 0008; set-based rewrite runs in 5 s.

### 3.1 FCIR hazard found in the data: artwork twins

30th-c Classic Collection reprints share name + illustrator with printings that **are** in the pool
(e.g. Charizard / Mitsuhiro Arita → base1 #4/102 and 5 others). Classic Collection cards are known to reprint
the original printed number while TCGdex numbers them `001…030` / `CC0xx`, so neither visual similarity
nor OCR can separate them while the twin has no reference image. Policy (data-driven, same language +
normalized name + illustrator):

- twin without a usable reference image → candidate stays in the pool but **can never lock** (`UNINDEXED_ARTWORK_TWIN`, 2,693 printings);
- any twin → **no visual-only lock** (printed-number consensus required).

Printings without an illustrator are not covered by this inference (known limitation).

## 4. Candidate intelligence in the Lens runtime

Architecture unchanged: `CAMERA → DETECT → TRACK → RECTIFY → FRAME QUALITY → VISUAL TOP-K → TARGETED OCR →
EVIDENCE FUSION → TEMPORAL CONSENSUS → CANONICAL RESOLUTION → LOCK → MARKET OVERLAY`. Every change tightens or
narrows; no threshold was lowered.

- **Canonical pool only.** `/api/visual-cards` and `/api/candidate-lookup` read `data/candidate-pool-{lang}.json`
  (released, physical, active canonical, no identity conflict, probed-OK image). Missing pool → HTTP 503, never a raw-source fallback.
- **Upcoming sets staged.** Release status derived from `release_date` vs an explicit as-of date; `--prerelease` builds
  may include staged sets but never allow visual-only locks on them.
- **`MetadataCorroboration`.** Parses `199/165`, `TG05/TG30`, `SVP 123`, set-code tokens. Printing-level support needs
  number **and** printed total or set code; a bare number is weak. A clear number/total mismatch with the visual
  top is a physical contradiction (hard block). Metadata never creates a candidate or raises a score.
- **Visual-only gate.** `EvidenceFusion` requires `visualOnlyLockAllowed === true` (set VISUAL_COMPLETE + RELEASED + no
  artwork twin). Absent flag = refusal.
- **Lock block.** `lockBlockedReason` → `AMBIGUOUS` regardless of visual or OCR evidence.
- **Targeted warming.** A number + printed-total OCR read warms up to 12 matching canonical printings into the
  on-device index (it holds 1,200 refs, newest first, out of 19,633 EN). Adds candidates only.
- Market data stays outside identity: readiness ladder test proves market coverage cannot change pool membership or lock permission.

Cost to measure on devices: candidates without visual-only permission need 2 OCR reads at 2.6 s → ≥ ~5.3 s to lock.

## 5. Validation

`TEST_DATABASE_URL=… npm run validate:local` → **VALIDATION OK** (10 gates).

- unit: resolution 4/4, ingestion 18/18, market 8/8, sealed 5/5
- Lens runtime/policy: **52/52** (39 baseline + 13 new)
- benchmark (`REPLAY_PROXY`, `productionEvidence=false`): **6/6 scenarios, 7 locks, 0 false, FCIR 0, precision 100%**
- Postgres integration: tcgdex, market, sealed, v0.3.1 pipeline — PASS
- iOS Swift parse: **SKIPPED** here (no `swiftc` on Linux); enforce with `REQUIRE_SWIFT=1` on macOS CI.

## 6. Runbook

```bash
export DATABASE_URL=postgres://…            # PostgreSQL 16 + pgvector
./scripts/migrate.sh                         # 0001-0008 (0008 is idempotent)
npm run snapshot:tcgdex -- fr,en,ja --out=data/snapshots/tcgdex-$(date +%F)
npm run import:tcgdex -- fr --snapshot=$PWD/data/snapshots/tcgdex-…   # repeat for en, ja (parallel-safe)
npm run probe:images
npm run import:cardmarket -- singles,nonsingles,prices
npm run import:cardmarket:crosswalk -- --catalog=…/products_singles_6.json
npm run import:cardmarket -- prices          # attach price guide to crosswalk links
npm run import:tcgcsv -- 3,85
npm run import:tcgplayer:crosswalk           # also attaches staged TCGCSV prices
npm run build:coverage -- --as-of=$(date +%F) --out=../../data/reports/coverage-$(date +%F) --pool-out=../web-preview-live-repro/data
```

Candidate-pool files are generated artifacts (gitignored, ~14 MB). A deploy must build them first; Vercel bundles
`data/**` with the API functions (`vercel.json` `includeFiles`). **Do not deploy yet.**

## 7. Not done / next

- Git remote not attached: no GitHub account linked to this session (history delivered as a git bundle).
- Image rights: all `image_origins` remain `rights_status=UNKNOWN`, `indexing_allowed=false`; the pool is dev/beta only until the IP review.
- JA: 68 empty sets and 70% missing images upstream; JA cannot be LENS_READY broadly without another image source.
- 30th Celebration Cardmarket mapping and 30th-c images depend on TCGdex fixes (#2341, #2370) or another source.
- Sealed release staging (Delta Reign pre-orders) not modelled; sealed scanning stays out of scope.
- `CARD_CONCEPT` cross-language linking still not populated by the bootstrap.
- Classic-collection printed numbers need physical confirmation → add to the Gold Validation Set (original vs Classic Collection pairs, same artwork).
- Targeted warming, OCR parsing and the new gates are untested on real cameras; v0.4 embedding and device benchmarks next.
