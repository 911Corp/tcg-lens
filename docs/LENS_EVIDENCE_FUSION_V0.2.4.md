# TCG Lens v0.2.4 - Evidence Fusion and Contradiction Hardening

Status: hardened candidate, not production-ready.

## Identity doctrine

Evidence is now separated by what it can actually prove:

- OCR name match: concept-level support only.
- Exact collector number: printing-level support.
- Visual embedding: candidate generation/ranking plus temporal evidence.
- Canonical conflict or exact collector disagreement: hard contradiction.

A Pokémon/card name alone can no longer authorize an exact printing lock.

## Contradiction engine

Hard contradictions take precedence over high visual similarity. Current hard blockers include:

- temporal candidate != current visual candidate;
- explicit OCR contradiction;
- exact collector OCR resolving to another candidate;
- canonical resolver conflict;
- verified barcode contradiction when applicable.

Name-only disagreement is retained as soft evidence rather than falsely promoted to an exact-print conflict.

## Canonical resolver

The resolver now distinguishes:

- `exact_collector_corroborated`;
- `concept_only_corroborated`;
- `collector_identifier_conflict`;
- `visual_ranked`.

## Validation at checkpoint

- Lens policy + sequence replay tests: 32/32 passing.
- Historical resolution: 4/4.
- TCGdex ingestion: 4/4.
- Market connectors: 6/6.
- Sealed/barcode: 5/5.
- SQL migrations: pass.
- iOS syntax parse: pass.
- web syntax: pass.
- `git diff --check`: clean.

The next OCR milestone must make exact collector evidence itself temporal, so that one noisy OCR frame cannot become the only independent printing-level corroboration.
