# TCG Lens v0.2.2 - Deterministic State Machine and Change Detection

Status: hardened candidate, not production-ready.

## Goals

- Illegal state transitions must fail closed.
- Runtime must never synthesize intermediate states to force a requested state.
- A lock is committed only after the state machine legally enters LOCKED.
- Card replacement must require consecutive strong evidence from the same new identity.

## State invariants

1. `ACQUIRING -> LOCKED` remains illegal.
2. `_safeTransition` reports and rejects illegal transitions. It never builds an artificial transition path.
3. `c.locked` is written only after a legal `LOCKED` transition succeeds.
4. A tracker generation replacement resets the state machine before analyzing the new track.
5. Verified barcode evidence follows an explicit legal path and cannot lock an unstable or stale track.
6. Visual evidence is evaluated before entering VERIFYING. A temporal/visual mismatch therefore stays ANALYZING rather than emitting a misleading VERIFYING state.

## Change detector invariants

A locked card changes identity only after three consecutive observations that all:

- refer to the same new candidate;
- come from a verified embedding;
- meet the change score threshold;
- meet the change top1/top2 margin threshold.

Any of the following resets the pending count:

- the locked identity is seen again;
- evidence falls below the change threshold;
- another candidate replaces the pending candidate.

## Permanent regression replay

The repository now includes a deterministic A -> empty -> B -> A replay fixture and two regression tests:

1. No OCR corroboration: A may lock, the empty interval never locks, B remains unconfirmed, and A can lock again only after a clean temporal switch.
2. Exact B corroboration: A locks, B locks, returning A must pass confirmed change detection and a new generation before A can lock again.

Both variants assert zero false confident locks and zero cross-identity VERIFY/LOCK decisions.

## Validation at checkpoint

- Lens policy + sequence replay tests: 23/23 passing.
- Historical resolution: 4/4.
- TCGdex ingestion: 4/4.
- Market connectors: 6/6.
- Sealed/barcode: 5/5.
- SQL migrations: pass.
- iOS syntax parse: pass.
- web syntax: pass.
- `git diff --check`: clean.

Physical-device validation remains mandatory before production.
