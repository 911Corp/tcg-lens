# TCG Lens v0.1

Initial executable foundation for the TCG Lens MVP.

## What is included
- PostgreSQL canonical schema v0.1 + ingestion/resolution tables.
- TypeScript contracts shared by backend services.
- Deterministic resolution engine with the four canonical outcomes: `AUTO_MATCH`, `CANDIDATE_MATCH`, `CONFLICT`, `NEW_ENTITY`.
- TCGdex FR/EN/JP connector + deterministic normalizers/fingerprints + canonical bootstrap persistence.
- Cardmarket Pokémon catalogue/price connector + deterministic `CARD_PRINTING` enrichment.
- TCGCSV Pokémon / Pokémon Japan connector with explicit TCGCSV → TCGplayer source lineage and market enrichment.
- Sealed-product ingestion for Cardmarket non-singles and TCGCSV/TCGplayer, with staged cross-source reconciliation.
- Provenance-aware EAN/UPC/JAN registry normalized to GTIN-14, including verified collision protection.
- Fastify API skeleton (`/health`, `/v1/resolve`, `/v1/market/:entityId`, `/v1/entities/:entityId/heat`).
- iOS SwiftUI/AVFoundation camera shell.
- Android Jetpack Compose/CameraX camera shell.
- Source-registry seed migration for the initial providers.

## Repository layout

```text
apps/api                  HTTP API
packages/contracts        shared schemas/types
packages/resolution       deterministic resolution engine
db/migrations             PostgreSQL migrations
ios/TCGLens               native iOS shell
android                    native Android shell
docs                       implementation notes
```

## Backend quick start

```bash
cp .env.example .env
npm install
psql "$DATABASE_URL" -f db/migrations/0001_extensions.sql
psql "$DATABASE_URL" -f db/migrations/0002_canonical_schema.sql
psql "$DATABASE_URL" -f db/migrations/0003_ingestion_resolution.sql
psql "$DATABASE_URL" -f db/migrations/0004_source_registry_seed.sql
psql "$DATABASE_URL" -f db/migrations/0005_tcgdex_canonical_bootstrap.sql
psql "$DATABASE_URL" -f db/migrations/0006_cardmarket_tcgcsv_enrichment.sql
psql "$DATABASE_URL" -f db/migrations/0007_sealed_and_barcode_registry.sql
npm test
npm run dev:api
```

Bootstrap TCGdex into staging + canon after migrations:

```bash
npm run import:tcgdex -- fr,en,ja --limit=100
npm run import:tcgdex:summary
```

For offline/CI validation, use `--fixture=fixtures/tcgdex-bootstrap.sample.json`. See `docs/BOOTSTRAP-TCGDEX-0.1.md`.

Enrich canonical cards with Cardmarket and TCGCSV/TCGplayer:

```bash
npm run import:cardmarket -- singles,nonsingles,prices
npm run import:tcgcsv -- 3,85
```

For development runs, `IMPORT_LIMIT`, `GROUP_LIMIT`, and `TCGCSV_DELAY_MS` can bound the ingestion. See `docs/MARKET-CONNECTORS-0.1.md`.

Import verified/candidate barcode claims with:

```bash
BARCODE_SOURCE=internal_verified DATABASE_URL=... npm run import:barcodes -- ./barcodes.json
```

See `docs/SEALED-BARCODES-0.1.md` for sealed promotion and barcode-conflict rules.

## Current milestone
The repository intentionally starts with identity/data correctness before real image models. The mobile shells already separate camera preview from analysis so the later detector/OCR/embedding pipeline can be added without redesigning the runtime.

## Browser smartphone preview

A dependency-free MVP preview is available in `apps/web-preview`.

```bash
npm run preview:web
# open http://localhost:4173
```

On desktop it renders an iPhone/Android device simulator. On a mobile browser it switches to full-screen. The camera button uses the browser's real `getUserMedia()` camera API when served from `localhost` or HTTPS. Recognition/market results are intentionally simulated in this preview; the native on-device ML pipeline is not yet connected.

Run the complete local static validation with:

```bash
npm run validate:local
```

This validates TypeScript compilation, 19 unit tests, SQL migrations, iOS Swift syntax, and the web preview. A real Android APK build still requires Android SDK/Gradle, and a real iOS binary build requires Xcode/macOS.
