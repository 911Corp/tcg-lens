# Milestone 0.1 — Foundation

## Done in this scaffold
- Canonical PostgreSQL schema and source registry seeds.
- Resolution engine enforcing the core invariant: probabilistic similarity cannot trigger `AUTO_MATCH` by itself.
- API routes for resolution, market summary and Heat summary.
- Native camera preview on iOS and Android.
- Permission copy aligned with local-first privacy.
- Initial visual design tokens matching the approved dark/yellow TCG Lens direction.

## Next implementation slice
1. Persist the implemented TCGdex connector into staging/source_records.
2. Bootstrap canonical sets/cards from normalized TCGdex records.
3. Canonical bootstrap promotion rules.
4. Local image/reference downloader with rights metadata.
5. Vision/OCR proof-of-concept on 100–500 cards.
6. ANN embedding index experiment and Top-5 benchmark.
7. Cardmarket + TCGCSV price ingestion.
8. First real camera overlay backed by canonical entity IDs.
