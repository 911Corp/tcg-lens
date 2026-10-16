# TCG Lens: Codex start here

This repository is the canonical handoff for TCG Lens.

## First objective

Do not add product features until the smartphone Lens runtime is observable and reliable.

1. Reproduce the current mobile camera issue from `apps/web-preview-live-repro/`.
2. Add visible runtime diagnostics for:
   - camera permission and stream state
   - video `readyState`, dimensions and frame arrival
   - Lens state transitions
   - detector availability/loading
   - OCR availability/loading/results/errors
   - visual embedding model/index availability/results/errors
   - barcode capability/results/errors
3. Split the runtime into testable adapters/state machine instead of one monolithic browser script.
4. Make a single-card center-scan path reliable before enabling continuous multi-card recognition.
5. Keep the canonical data/ingestion layer unchanged unless a failing test proves it needs modification.

## Required baseline

Run:

```bash
npm run validate:local
```

The handoff baseline was green with 19 unit tests before temporary compiler outputs were removed.

## Important product invariant

Detection or a high visual similarity score alone must never create a confident identity. Exact identity requires deterministic/corroborating evidence or a sufficiently strong, temporally stable visual match under the Lens confidence policy. Ambiguous results must remain ambiguous.

Read `AGENTS.md`, `CODEX_HANDOFF.md`, and `PROJECT_STATUS.md` before editing.
