# TCG Lens v0.2.5 - Temporal OCR Consensus

Status: hardened candidate, not production-ready.

## Goal

Prevent a single noisy OCR frame from becoming the only independent printing-level corroboration.

## OCR consensus rules

- One exact collector read is insufficient to corroborate a printing.
- Two coherent exact collector reads are required for `collectorExact=true` at the fusion layer.
- Name support also requires repeated observations and remains concept-level evidence only.
- One exact collector read resolving to another candidate creates an immediate hard contradiction.
- OCR consensus is reset whenever the temporal identity epoch changes or the current visual candidate changes.
- Delayed OCR results remain bound to track, generation, candidate and temporal epoch through the existing identity token guard.

## Runtime behavior

Raw OCR evidence is never passed directly to the lock engine anymore. The runtime passes the temporally aggregated OCR evidence instead.

Telemetry now records:

- raw OCR candidate / collector exactness;
- consensus candidate;
- exact vote count;
- name vote count;
- total OCR observations;
- contradiction state.

## Validation at checkpoint

- Lens policy + sequence replay tests: 36/36 passing.
- Historical resolution: 4/4.
- TCGdex ingestion: 4/4.
- Market connectors: 6/6.
- Sealed/barcode: 5/5.
- SQL migrations: pass.
- iOS syntax parse: pass.
- web syntax: pass.
- `git diff --check`: clean.

The next major milestone is a reproducible benchmark/Gold Set framework so accuracy and false-confident-identification can be measured rather than judged visually.
