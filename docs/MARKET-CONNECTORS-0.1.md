# Cardmarket + TCGCSV Enrichment v0.1

## Scope

This slice enriches existing canonical `CARD_PRINTING` entities. It deliberately does **not** create new canonical cards from Cardmarket or TCGCSV.

Flow:

```text
TCGdex canonical CARD_PRINTING
  + Cardmarket product/price guide
  + TCGCSV cached TCGplayer product/prices
        ↓
source_records
        ↓
deterministic enrichment matching
        ↓
source_entity_links
external_identifiers
source_assertions
market_observations
```

## Cardmarket

Official public Pokémon download files used by the connector:

```text
https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json
https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_6.json
https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json
```

Singles enrich `CARD_PRINTING`. Non-singles are now routed through the sealed-product pipeline described in `SEALED-BARCODES-0.1.md`.

Run:

```bash
DATABASE_URL=... npm run import:cardmarket -- singles,nonsingles,prices
```

Optional local throttling/testing:

```bash
IMPORT_LIMIT=100 DATABASE_URL=... npm run import:cardmarket -- singles,nonsingles,prices
```

Cardmarket market observations are stored with:

```text
reported_by = cardmarket
origin_source = cardmarket
venue = cardmarket
currency = EUR
```

Supported normalized metrics include:

```text
LISTING_AVERAGE
LISTING_LOW
TREND
AVG_1D
AVG_7D
AVG_30D
```

and the corresponding Cardmarket holo metrics, retained with `cardmarket_variant=holo` metadata.

## TCGCSV / TCGplayer

TCGCSV is consumed server-side through its JSON endpoints:

```text
/tcgplayer/{categoryId}/groups
/tcgplayer/{categoryId}/{groupId}/products
/tcgplayer/{categoryId}/{groupId}/prices
```

Categories in v0.1:

```text
3  = Pokemon → en
85 = Pokemon Japan → ja
```

Run both:

```bash
DATABASE_URL=... npm run import:tcgcsv -- 3,85
```

For development:

```bash
GROUP_LIMIT=2 IMPORT_LIMIT=50 TCGCSV_DELAY_MS=250 \
DATABASE_URL=... npm run import:tcgcsv -- 3,85
```

TCGCSV product IDs are persisted as **TCGplayer** external IDs because TCGCSV is a cache/reporter, not an independent marketplace identity:

```text
reported_by = tcgcsv
origin_source = tcgplayer
```

Market observations follow the same lineage rule.

## Matching policy

### Cardmarket single

`AUTO_MATCH` is allowed only for an existing canonical `CARD_PRINTING` when:

```text
collector number exact
+ normalized card name exact
+ expansion/set hint exact when available
+ one canonical candidate
```

If no expansion label is available, number + exact normalized name must still produce exactly one candidate.

### TCGCSV product

`AUTO_MATCH` requires:

```text
language from category (en / ja)
+ collector number exact
+ normalized name exact
+ unique candidate
```

A matching group/set hint raises confidence but is not allowed to override a physical contradiction.

### Collector number normalization

Marketplace values such as:

```text
199/165
```

are reduced to the local collector numerator `199` for matching against TCGdex `localId`, while the raw source value remains preserved in `source_records`.

## Migration 0006

`0006_cardmarket_tcgcsv_enrichment.sql` adds:

- `market_observations.source_record_id`
- `source_entity_links`
- scoped verified-link uniqueness
- enrichment lookup indexes
- TCGCSV → TCGplayer source lineage
- field-scoped trust policies for Cardmarket, TCGCSV, and TCGplayer

## Idempotence

Re-importing the same product/price snapshot must not duplicate:

- verified external identifiers
- verified source/entity links
- market observations

`market_observations.observation_hash` is deterministic over entity, source lineage, venue, time, metric, amount, precision, and metadata.

## Tests

Pure deterministic tests:

```bash
npm run test:market
```

Covers:

- Cardmarket collector-number/name normalization
- ambiguous Cardmarket products
- TCGCSV category 3 → EN
- TCGCSV category 85 → JA
- local-number extraction from `199/165`
- Cardmarket standard/holo EUR metrics
- TCGplayer subtype/USD metrics

PostgreSQL integration test:

```bash
TEST_DATABASE_URL=... npm run test:market-integration -w @tcglens/ingestion-worker
```

The DB test creates a canonical TCGdex printing, enriches it with Cardmarket and TCGCSV/TCGplayer IDs, writes market observations, reruns the same imports, and asserts idempotence + correct source lineage.
