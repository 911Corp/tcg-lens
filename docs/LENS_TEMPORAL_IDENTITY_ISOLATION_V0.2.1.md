# TCG Lens v0.2.1 - Temporal Identity Isolation

Status: hardened candidate, not production-ready.

## Safety goal

Prevent evidence collected for one card identity from contributing to VERIFY or LOCK for another identity.

## Invariants

1. Temporal observations from different candidate IDs are never averaged into the same active window.
2. A new candidate requires consecutive strong visual observations before replacing the active temporal identity.
3. While the current visual candidate and temporal candidate disagree, EvidenceFusion can only CONTINUE with `temporal_visual_mismatch`.
4. A candidate switch starts a new temporal epoch and discards the prior active observation window.
5. OCR evidence is bound to track ID, generation ID, visual candidate ID, temporal candidate ID and temporal epoch.
6. Delayed OCR evidence is discarded if any bound identity field changes before the OCR result returns.
7. Delayed barcode evidence is bound to track ID + generation ID and is discarded after track replacement.
8. Changing the visual candidate clears previous OCR evidence immediately.
9. No threshold is lowered to make a replay pass.

## Regression gate

The A -> empty -> B -> A replay must satisfy:

- no lock during the empty segment;
- no cross-identity VERIFY or LOCK;
- the first A observation after B is blocked while temporal identity still belongs to B;
- a clean A temporal epoch is opened only after consecutive strong A observations;
- stale OCR/barcode evidence cannot survive an identity or track change;
- B may remain VERIFYING if evidence is insufficient. UNKNOWN/VERIFYING is preferable to a false confident identification.

## Current validation

- Historical resolution/ingestion/market/sealed tests remain green.
- SQL migrations validate.
- iOS syntax parse passes.
- web syntax passes.
- Lens policy suite: 17/17 passing at this checkpoint.
- Reproducible A -> empty -> B -> A replay: zero cross-identity VERIFY/LOCK decisions.

This checkpoint is not evidence of physical-device reliability. Real camera validation remains mandatory before production.
