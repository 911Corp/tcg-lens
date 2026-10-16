# TCGdex Canonical Bootstrap v0.1

## Scope

Bootstraps localized TCGdex cards for `fr`, `en`, and `ja` into the canonical PostgreSQL graph.

TCGdex V2 uses language-scoped REST routes such as `/v2/fr/cards`; Japanese uses the `ja` language code.

## Data flow

```text
TCGdex card
  -> source_records (raw + normalized + payload hash)
  -> localized source scope (fr/en/ja)
  -> canonical SET
  -> canonical CARD_PRINTING
  -> verified external_identifiers
  -> entity_fingerprints
  -> entity_aliases
  -> source_assertions
  -> image_origins + entity_images (rights UNKNOWN, display/index disabled)
  -> resolution_decisions
  -> source_records.promotion_status
```

## Canonical promotion rules

1. Existing verified TCGdex localized external ID: `AUTO_MATCH`, unless set/language/collector/name drift conflicts with the existing identity.
2. Exact localized set + collector number + `base` printing: `AUTO_MATCH` when the normalized name agrees.
3. No existing deterministic identity: create a canonical printing using `BOOTSTRAP_TCGDEX` and record `NEW_ENTITY`.
4. Identity disagreement: record `CONFLICT`, create a `data_conflicts` row, and mark the source record `QUARANTINED`.

## Idempotence

- source records are unique by `(source, namespace, language scope, external key)`;
- external IDs are unique by `(source, namespace, language scope, external value)`;
- card printings are unique by `(set, collector number, printing discriminator)`;
- aliases, fingerprints and assertions are upserted/deduplicated;
- repeated identical imports reuse the same canonical entity.

## Migrations

```bash
export DATABASE_URL='postgres://...'
./scripts/migrate.sh
```

The new bootstrap migration is:

```text
db/migrations/0005_tcgdex_canonical_bootstrap.sql
```

It adds localized source scopes, promotion state, canonicalization provenance and indexes required by the worker.

## Full bootstrap

```bash
npm install
npm run import:tcgdex -- fr,en,ja
npm run import:tcgdex:summary
```

For a controlled first pass:

```bash
npm run import:tcgdex -- fr,en,ja --limit=100
```

## Offline/CI fixture mode

```bash
npm run import:tcgdex -- fr,en,ja --fixture=fixtures/tcgdex-bootstrap.sample.json
```

This still requires PostgreSQL and exercises the same persistence path; it only replaces the network fetch.

## Tests

Pure deterministic tests:

```bash
npm run test:ingestion
```

PostgreSQL integration test (after applying migrations):

```bash
TEST_DATABASE_URL='postgres://...' npm run test:integration -w @tcglens/ingestion-worker
```

The integration test verifies that promoting the same record twice reuses one `CARD_PRINTING` and the second promotion resolves as `AUTO_MATCH`.
