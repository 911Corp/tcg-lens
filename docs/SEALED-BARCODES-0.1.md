# Sealed Products + Barcode Registry v0.1

## Scope

This slice adds sealed Pokémon products from Cardmarket and TCGCSV/TCGplayer and a provenance-aware EAN/UPC/JAN registry.

```text
Cardmarket non-singles ─┐
                        ├─> SEALED_PRODUCT (STAGED first)
TCGCSV/TCGplayer ───────┘       ↓
                         independent corroboration
                               ↓
                           CANONICAL

EAN / UPC / JAN
    ↓ checksum validation
GTIN-14
    ↓
barcode_claims
    ↓ verified claim
entity_barcodes
```

## Sealed policy

Marketplace sources do not independently prove a physical SKU/region. A new marketplace sealed product is therefore created as `STAGED`.

An existing product is `AUTO_MATCH`ed only when:

- a verified provider external ID already maps to it, or
- the cross-source sealed matching fingerprint is exact and scope fields are compatible.

A staged product is promoted to `CANONICAL` after at least two independent origin sources corroborate it, or when a verified barcode is attached.

Supported v0.1 product classes:

- `ETB`
- `BOOSTER_BOX`
- `BOOSTER_PACK`
- `BOOSTER_BUNDLE`
- `BLISTER`
- `TIN`
- `COLLECTION_BOX`
- `DECK`
- `CASE`
- `DISPLAY`
- `OTHER`

Code cards are explicitly excluded from sealed classification.

## Cardmarket

`products_nonsingles_6.json` is consumed by the existing Cardmarket worker.

```bash
DATABASE_URL=... npm run import:cardmarket -- nonsingles,prices
```

The default Cardmarket import now includes `singles,nonsingles,prices`.

## TCGCSV / TCGplayer

The existing TCGCSV worker now classifies products without collector numbers. Products whose names match sealed product types are routed to sealed enrichment rather than `CARD_PRINTING` enrichment.

```bash
DATABASE_URL=... npm run import:tcgcsv -- 3,85
```

TCGCSV remains the reporter and TCGplayer remains the origin source.

## Barcode registry

All UPC-A, EAN-13 and JAN-13 inputs are normalized to GTIN-14. Raw representations are retained.

A barcode claim can be:

- `CANDIDATE`
- `VERIFIED`
- `REJECTED`
- `CONFLICT`

Only a verified claim can create an `entity_barcodes.status='VERIFIED'` mapping. The existing partial unique index guarantees one verified entity per GTIN. A second verified product claim for the same GTIN opens a `BARCODE_COLLISION` conflict.

### Generic import

Input JSON array:

```json
[
  {
    "barcode": "036000291452",
    "entity_id": "<sealed-product-uuid>",
    "verified": true,
    "confidence": 1,
    "evidence": { "method": "manual-packaging-check" }
  }
]
```

Run:

```bash
BARCODE_SOURCE=internal_verified \
DATABASE_URL=... \
npm run import:barcodes -- ./barcodes.json
```

The Cardmarket and TCGCSV workers also inspect provider payloads for explicit `UPC`, `EAN`, `JAN`, `GTIN`, `barcode`, or `productCode` fields. These are ingested only as `CANDIDATE` claims unless explicitly verified elsewhere.

## Migration 0007

`0007_sealed_and_barcode_registry.sql` adds:

- `sealed_products.normalized_name`
- strict `structural_fingerprint`
- cross-source `matching_fingerprint`
- sealed lookup indexes
- `barcode_claims`
- barcode claim lookup/uniqueness indexes
- TCGCSV → TCGplayer sealed lineage
- sealed/barcode source trust policies

## Tests

Pure tests:

```bash
npm run test:sealed
```

PostgreSQL integration:

```bash
TEST_DATABASE_URL=... npm run test:sealed:integration
```

The integration test verifies staged creation, independent Cardmarket/TCGplayer corroboration, canonical promotion, verified UPC→GTIN-14 mapping, idempotence, and a critical collision when the same verified GTIN is assigned to a second physical product.
