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

## v0.3.4 — Barcodes & sealed products back, live-first screen, scans that conclude

**Barcodes.** Read continuously from the live camera, independently of card recognition (native
`BarcodeDetector` on Android, `barcode-detector@2.2.11` zxing-wasm polyfill elsewhere incl. iOS). A code is
announced after two identical checksum-valid reads (GTIN-14). `/api/barcode`: verified registry
(`data/barcodes.json`, exported from `entity_barcodes` VERIFIED) → VERIFIED; otherwise the product title from
the public UPCitemdb database is matched against the canonical sealed catalogue → CANDIDATE, shown as a
pop-up with "C’est bien ce produit" / "Autre produit"; the confirmation is remembered on the device.
Unknown codes open the sealed search to associate them. Card analysis pauses while a product is shown and
resumes 6 s after the box leaves the camera.

**Sealed catalogue.** `tools/export-sealed-catalog.mjs` exports the 7 904 canonical sealed products (ETB,
displays, boosters, bundles, tins, blisters, decks, collection boxes…) with Cardmarket/TCGplayer ids and
latest prices (Cardmarket trend EUR, TCGplayer market USD) to `data/sealed-catalog.json`; Cardmarket and
TCGplayer listings of the same product are grouped for display. `/api/sealed` searches it (no more
download of the full Cardmarket catalogue per request).

**Screen.** Native video controls hidden (iOS play/pause button); if the browser refuses autoplay (low power
mode) a tap anywhere starts the camera. Translucent controls, icon-only dock, no brand button.

**Scans conclude.**
- Printed name read twice + visual bars (score ≥ 0.90, margin ≥ 0.06, 4 votes, quality) locks — only for
  candidates of visually complete sets (`visualOnlyLockAllowed`), so the margin separates printings. The
  original rule "OCR name alone cannot lock an exact printing" still holds elsewhere.
- Language grace: identity proven but language unreadable for 2.5 s → lock with the language shown as
  "Langue à confirmer (FR / EN)"; any read of a language the printing does not exist in still blocks.
Tests 78/78, benchmark 15/15, FCIR 0.

## v0.3.5 — Calibrated instant recognition

**Why scans were slow and inconclusive.** The generic MobileNet embedding (ImageNet) recognises cards
poorly under camera conditions: on held-out simulated camera crops it is right 94 % of the time on mild crops
but only **30 %** on hard ones (glare, blur, exposure, misalignment). Each new card also downloaded ~8
reference images at scan time, and locks waited for OCR (printed number twice, language).

**What changed.**
- *Learned whitening* (`tools/deep/`): reference descriptor = MobileNet embedding + fast layout/colour
  descriptor, projected to 128-d by Cw^-1/2 (within-class covariance of 8 000 simulated camera crops) + PCA.
  Held-out hard crops: top-1 **96 %** (vs 30 %), top-5 100 %.
- *Precomputed* for all 40 616 references (`data/deep-index-{lang}.bin.gz`, int8, 3.7 MB + 0.7 MB model):
  a scan = one model pass + one projection + 40 616 dot products (search 22 ms); no reference download.
- *Artwork twins* (Japanese version, reprints, promos — 34 % of references at τ = 0.80) are found on the fly;
  the instant margin is measured against the best non-twin family. Open-set test (true card removed from the
  index): every high-confidence match was an artwork twin, never an unrelated card.
- *Instant lock* (`CALIBRATED_POLICY`): twin-free, score ≥ 0.80, non-twin margin ≥ 0.06, 2 consecutive
  frames, quality ≥ 0.35. Held-out: 54 % of single crops qualify, 0 wrong, 0 open-set non-twin false locks.
  Twins → printed evidence (language picks JA vs FR/EN, number picks reprints).
- *Language never blocks*: shown "à confirmer" at the instant lock and read in the background; a foreign
  language read twice withdraws the lock and the printing then needs a proven language for the session.
- *Every frame is compared* (110 ms cadence; previously only sharper frames), 2 tracking hits, OCR only when
  needed, WebGL on real GPUs / WebAssembly on software WebGL (19 ms vs 276 ms per embedding), recognition
  assets cache-first in the service worker.

**Measured (headless Chromium, CPU, synthetic camera — not a phone):** identification ≈ 0.3 s after the
first comparison; 3.6–5 s after opening the page, of which ~3 s is the first-launch model download
(cached afterwards). FR card on busy table, FR on wood, EN card: instant lock; French proven in the
background ~5 s later. JA Arceus V (Latin twins exist): locked on the right Japanese printing once
Japanese was read. Tests 81/81, benchmark 18/18, FCIR 0.

## v0.3.6 — Database gaps (30th Anniversary), retrained recognition, twin safety

**Database.**
- TCGCSV matching fix: TCGplayer names carrying the printed number ("Greninja ex - 021/128") now match
  by group + number + name. 30th Celebration EN TCGplayer mapping 61 → 157/158; 4 275 false
  EXTERNAL_ID_COLLISION conflicts from the same cause were resolved with the same comparison function.
- `apps/ingestion/src/tcgplayer-gap-import.ts` (`npm run tcgplayer:gaps`):
  - CREATE Japanese expansions TCGdex lacks (canonical, method `BOOTSTRAP_TCGPLAYER_GAP`, provenance kept):
    M6a MEGA Expansion 30th Celebration (176), MF 30th Celebration Premium Deck Set, MEE/MEM/MEZ, MP1,
    MBG/MBD — 8 sets, 350 printings, 1 351 prices.
  - MAP sets without TCGplayer links to their group (Jaccard ≥ 0.6, release ±10 days, unique names,
    numbers must agree unless the set is systematically renumbered): 30th Classic Collection, Celebrations
    Classic Collection, Hidden Fates Shiny Vault, Black & White… The number printed on the card is kept
    (`tcgplayer_printed_number`, e.g. "4/102") and used by OCR corroboration and number lookup.
  - IMAGES: TCGplayer 1000 px product image as REFERENCE when TCGdex has none (≈ 3 400 printings).
- Coverage build: TCGplayer images as fallback references; an artwork twin counts as indexed when the
  same TCGdex card (shared id) is indexed in another language. Lock-blocked printings: FR 1 041 → 203,
  EN 853 → 191. Pool: 43 595 references (FR 17 265, EN 20 711, JA 5 619).

**Recognition retrained.** 23 160 training crops incl. a new hard2 level (slight perspective, holo /
reverse sheen, sleeve streak, white balance, hand shadow, motion blur, low resolution, JPEG). Held-out
3 180 crops: mild 97.6 %, hard 95.0 %, hard2 90.9 % (previous model hard2 83.2 %); 30th Classic
Collection hard2 46 % → 88 %, 30th 84 % → 92 %, M6a 84 % → 90 %. Instant thresholds now chosen by the
training script (most permissive pair with zero wrong / zero open-set false locks, also at a safety margin)
and read by the app from `deep-index.json` (0.86 / 0.04). Queries average the last 3 frames of a track.

**Twins.**
- Latin vs Japanese printings of the same artwork (every 30th card has an M6a twin): calibrated visual
  script proof — gap ≥ 0.06 decides with 0 errors on 895 held-out cases; otherwise OCR decides.
- Same-script twins are not visually separable reliably (errors up to a 0.15 gap), and twins printing the
  same number/total (Base Set / Base Set 2 / Legendary Collection / Classic Collection Charizard "4/102")
  cannot be separated by OCR either: AMBIGUOUS `artwork_twins_same_number`. Before v0.3.6 the printed-
  number path could lock the visual top among such twins — fixed, with a benchmark scenario.

**E2E (headless, CPU):** 30th FR card instant (4.2 s from page open incl. model load; was 20 s), 30th JA
(M6a) instant (4.2 s), 30th Classic Collection Charizard → honest AMBIGUOUS. Tests 83/83, benchmark 19/19,
FCIR 0.

## v0.3.7 — résultat éphémère et affichage allégé

- **Disparition automatique** : une fois la carte identifiée, la re-vérification visuelle continue toutes les 350 ms. Si la carte verrouillée (ou un jumeau du même groupe) sort des 3 meilleures correspondances deux fois de suite (`presenceMissVotes`), le verrou est libéré (`LOCK_RELEASED card_left_image`), la fiche disparaît et le scan reprend (feu rouge/orange). Mesuré en E2E : ≈ 1,7 s après le retrait de la carte.
- **Fermeture manuelle** : bouton ✕, glissement vers le bas (> 60 px) ou sur le côté (> 90 px). L'identification est conservée (feu vert) mais la fiche ne revient pas tant que la carte reste en place ; une nouvelle carte (ou la même reposée) relance l'affichage.
- **Fiche compacte translucide** (`.sheet.lite`) : verre dépoli ~34 %, 3 lignes — nom + prix, set · numéro · langue (`FR/EN ?` si non prouvée), tendance · Heat · source. Même geste de fermeture sur la pop-up des produits scellés ; dock, voyant et bulle d'aide plus transparents.

## v0.3.8 — base japonaise, prix canoniques, index versionné

**Données** (`tcgplayer-gap-import.ts`, mêmes garde-fous de provenance `BOOTSTRAP_TCGPLAYER_GAP`) :
- *MAP JA* : les sets japonais TCGdex sans produit TCGplayer sont reliés au groupe TCGplayer Japon du même code (ou alias
  `JA_GROUP_ALIASES`). Chaque paire est prouvée carte par carte (`checkJaPair`) : numéro unique des deux côtés, espèce
  Pokémon (nom anglais appris des cartes TCGdex EN par numéro de Pokédex) et PV identiques ; dresseur/énergie seulement si
  le groupe passe le contrôle Pokémon (≥ 90 %, ≥ 5 paires). 5 594 paires, 23 rejets, 29 non prouvées (écartées).
- *FILL* : 32 sets japonais listés par TCGdex sans aucune carte (Shiny Star V, Eevee Heroes, VMAX Rising, Pokémon GO,
  25th Anniversary, XY…) remplis depuis le groupe du même code (groupe unique, sortie à ±30 jours, total imprimé
  concordant) : 3 096 cartes.
- *SHARE* : une impression physique sans image emprunte l'image de référence de la même carte TCGdex dans une autre
  langue (même illustration ; la langue reste prouvée par le texte) : 2 248 cartes FR.
- *VARIANTS* : les impressions créées depuis TCGplayer reçoivent leurs variantes des sous-types réellement cotés
  (Normal, Holofoil, Reverse Holofoil, 1st Edition…) : 3 381 variantes.
- Pool reconnaissable : 43 595 → **54 265** cartes (japonais 5 619 → 14 055) ; verrou visuel seul autorisé
  20 681 → 24 968. Les sets dont il manque encore des images restent sans verrou visuel seul (jumelle non indexée possible).

**Modèle** : réentraîné (REG 0.2) avec 2 000 références japonaises supplémentaires en recadrages caméra ; seuils
recalibrés (0.82 / 0.12), 0 erreur fermée, 0 faux verrou en ensemble ouvert. Cache d'embeddings par image
(`$DEEP_WORK/cache`) : agrandir l'index ne recalcule que les nouvelles images. Évaluation en blocs (mémoire).

**Prix** : `tools/export-card-prices.mjs` → `data/card-prices.json` (Cardmarket EUR au niveau impression, TCGplayer USD
par finition). `/api/card` lit ces prix canoniques d'abord, TCGdex ensuite. Plusieurs finitions cotées et finition non
prouvée → « dès … » ; prix d'une autre langue tant que la langue n'est pas prouvée → source suffixée « (EN) ». Le nom
affiché ne change plus quand les données de marché arrivent.

**Index versionné** : `tools/stamp-index-version.mjs` (lancé par `deploy-preview.sh`) écrit l'empreinte des fichiers
d'index dans `data/index-version.json` ; chaque requête d'index porte `?v=<empreinte>` (`lens/indexVersion.js`). Après une
mise à jour, le nouvel index est chargé dès le premier lancement et jamais mélangé avec l'ancien.

Pipeline après ajout de données : `tcgplayer:gaps` → `images:probe` → `build:coverage` → `fetch-ref-images.mjs` →
`build-visual-index.mjs` → `embed-references.mjs` (cache) → `camera-crops.mjs` → `train-and-export.py` →
`export-card-prices.mjs` → déploiement.

## v0.3.9 — fluidité, collection, mode plusieurs cartes

**Fluidité** (profil CPU, 14 s de scan, Chromium logiciel) : fil principal bloqué 5,4 s → 2,1 s, pire blocage
1 239 ms → 172 ms, temps libre du fil principal 3,8 s → 7,7 s.
- `lens/FrameWorker.js` + `lens/frame.worker.js` : l'image caméra est capturée par `createImageBitmap` (asynchrone)
  et transférée à un worker qui fait la recherche de contours **et** le redressement de la carte sur cette même image.
  Repli automatique sur le chemin dans la page (mêmes fonctions pures) si le worker manque ou échoue.
- `warpInto` : boucle de redressement sans objets ni fermetures par pixel (~10× plus rapide, résultat identique).
- `lens/dotWasm.js` (généré depuis `tools/wasm/dot.wat`) : produits scalaires int8 × float32 en WebAssembly SIMD
  pour les 54 265 références (mêmes scores à 1e-4 près, test d'équivalence) ; repli JS.
- Codes-barres sans détecteur natif (iPhone) : décodage zxing dans `lens/barcode.worker.js`.

**Fiche détaillée** : `/api/card` complète nom, extension, numéro et image depuis le pool canonique quand TCGdex ne
connaît pas l'impression (cartes importées de TCGplayer).

**Collection** (`collection.js`, logique pure `lens/collectionModel.js`) : ＋ sur la fiche de scan (ajout sans quitter
le scanner, ×2, ×3…), quantités ± et retrait, valeur totale par devise (EUR et USD jamais convertis), tri, export CSV
(point-virgule, décimales françaises, partage natif sur mobile), actualisation des prix. Une carte dont la langue
n'est pas prouvée garde ses langues candidates (« FR/EN ? ») et n'est jamais fusionnée avec une langue prouvée.

**Mode plusieurs cartes** (`lens/MultiScan.js`, bouton en haut à gauche) : jusqu'à 6 cartes par image
(`detectRects`, dans le worker). Une carte n'est nommée qu'avec les règles du verrou instantané (index calibré, set
visuellement complet, aucun blocage, score/marge/qualité ≥ seuils calibrés) sur 2 passages concordants au même
endroit ; les jumelles d'illustration ne sont écartées que par la preuve visuelle d'écriture calibrée
(`twinFreeByScript`, même règle que `_resolveTwins`). Sinon « ? — à scanner seule » (pas d'OCR dans ce mode, langue
jamais affirmée). Barre de total et « Tout ajouter ». Sur la scène de test à 4 cartes : 2 nommées, 2 « ? » (jumelles
japonaises trop proches visuellement, écart 0,036–0,048 < 0,07), aucune erreur.

## v0.4.0 — Français / English, stabilité

**Langue de l'application** (`/i18n.js`, chargé avant tout autre script ; `lens/i18nRef.js` pour les modules).
- Réglages → première ligne « Langue de l’application » : Français | English (chaque option écrite dans sa langue).
  Premier lancement : langue du téléphone (français si le téléphone est en français, anglais sinon). Changement à
  chaud, sans recharger ni couper la caméra (`tcglens:uilang`).
- Adaptation, pas traduction mot à mot : vocabulaire des collectionneurs anglophones (Set, Market, Elite Trainer Box,
  Booster Box…), prix TCGplayer en USD en premier (Cardmarket EUR en repli ; le momentum Cardmarket alimente toujours
  le Heat), formats en-US, nom et extension anglais tant que la langue imprimée n’est pas prouvée, CSV à virgules et
  points décimaux, recherche du catalogue en anglais par défaut. En français : Cardmarket EUR d’abord, formats fr-FR.
- Mécanique : clés = textes français ; les vues compactes (`app-*.js`) et l’HTML statique sont traduits au rendu par
  un MutationObserver (correspondance exacte + motifs pour les textes avec nombres) ; les modules utilisent `t()` avec
  variables. `translate="no"` exclut un élément. Test : toute clé `t('…')` doit exister en anglais.
- API : `/api/card?…&market=us|eu` choisit le marché affiché.

**Stabilité**
- Endurance 3 min (carte FR → table vide → carte JA en boucle) : mémoire stable (156–166 Mo), ~5 analyses/s, 12/12
  identifications correctes, aucune erreur ; idem 2 min en anglais.
- Arrière-plan : analyse en pause quand l’app est masquée ; au retour, la caméra est relancée si le système l’a coupée
  (iOS), sinon l’analyse reprend. Piste vidéo terminée pendant l’usage → relance.
- Worker d’image en panne → le scan continue dans la page, nouveau worker 10 s plus tard (3 fois au plus par session).
- Vibration seulement après un premier geste de l’utilisateur.
- Nom affiché quand la langue n’est pas prouvée : celui de la langue de l’application (plus celle du téléphone).

## v0.4.1 — propositions calibrées et apprentissage sur l’appareil

Quand rien n’est identifié, l’app propose plutôt que de rester muette, sans jamais toucher aux règles
d’identification automatique (FCIR 0 inchangé).
- **Probabilité calibrée** (`tools/deep/calibrate-proposals.py` → `calibration.proposals`) : régression logistique sur
  le classement (score, écart au premier, écart au suivant, rang, marge), apprise sur les recadrages caméra tenus à
  l’écart **et** sur ces mêmes recadrages privés de leur bonne carte (carte absente du catalogue, a priori 20 %).
  Règle : propositions si la meilleure a p ≥ 0,60, puis toute candidate p ≥ 0,10, 3 au plus. Moitié tenue à
  l’écart : affichées pour 88 % des cartes du catalogue, **bonne carte parmi les propositions 98,1 %**, 1,2
  proposition en moyenne. Porte : refus d’écrire sous 97 %.
- **Constance** : candidate proposée sur ≥ 3 des 4 dernières images de la même carte.
- **Concordance imprimée** : une lecture numéro/total identique deux fois qui contredit une candidate la retire ; une
  lecture qui la confirme la place en tête (« Numéro concordant ») ; une langue prouvée exclut les autres langues.
- **Jumelles d’illustration** de la première proposition listées avec elle (« Même illustration ») : l’image seule ne
  peut pas les départager, l’utilisateur oui.
- Affichage après 1,2 s d’analyse (ou dès « incertain ») : miniatures, nom, extension, numéro imprimé, langues
  possibles, force en mots ; un appui confirme (« Confirmée par vous », prix ensuite), « Aucune de ces cartes »
  masque les propositions pour cette carte. Aucune proposition ne montre de prix.
- **Apprentissage sur l’appareil** (`lens/ScanMemory.js`) : une proposition confirmée mémorise le descripteur 128-d du
  scan (pas l’image), 400 au plus, sur l’appareil uniquement ; un scan très proche (cosinus ≥ 0,92) remet cette carte
  en tête des propositions (« Déjà confirmée par vous »). La mémoire n’alimente jamais l’identification automatique.
