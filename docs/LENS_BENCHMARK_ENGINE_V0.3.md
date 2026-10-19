# TCG Lens v0.3 - Recognition Benchmark Engine

Status: benchmark framework active, physical Gold Validation Set not yet populated.

## Goal

Stop evaluating recognition quality by visual impression. Every scanner change must be measured against explicit safety and coverage metrics.

## Primary metric

`FCIR = False Confident Identifications / Total Confident Locks`

The current local regression gate requires zero false confident locks. The future physical-device beta target remains stricter than ordinary top-1 accuracy because an UNKNOWN/VERIFYING result is preferable to a confidently wrong printing.

## Metrics currently emitted

Per scenario:

- total locks;
- correct locks;
- false confident locks;
- FCIR;
- lock precision;
- false locks during empty segments;
- cross-identity VERIFY/LOCK decisions;
- illegal state transitions;
- lock coverage by expected identity segment;
- first correct lock timestamp and latency by segment.

## Current dataset tier

`REPLAY_PROXY`

`productionEvidence = false`

The current benchmark intentionally does **not** claim physical-camera reliability. It uses the reproducible A -> empty -> B -> A recorded/replay proxy to prevent regression in the lock engine.

Two mandatory scenarios are currently gated:

1. No OCR corroboration: B must remain unconfirmed, with zero false locks.
2. Exact temporal OCR consensus: A -> B -> A must all lock correctly, with confirmed change detection between B and the returning A.

## Validation integration

`scripts/validate-local.sh` now has a ninth gate that runs the benchmark after all syntax, unit, migration and Lens policy tests.

A benchmark failure makes the local validation fail.

## Current replay baseline

- scenarios: 2/2 passing;
- total confident locks: 5;
- false confident locks: 0;
- FCIR: 0;
- lock precision: 1.0;
- empty false locks: 0;
- cross-identity decisions: 0;
- illegal transitions: 0.

These numbers are regression evidence only. They are not a production accuracy claim.

## Required next dataset tier

The next milestone is `PHYSICAL_GOLD_SET`, populated with real smartphone captures covering at minimum:

- same artwork across different printings;
- holo / reverse / normal variants;
- FR / EN / JP;
- sleeves and glare;
- blur and low light;
- partial occlusion;
- extreme perspective;
- rapid A -> B replacement without an empty frame;
- A -> empty -> B -> A;
- backside / hand / non-card negative controls.

Production remains blocked until that dataset exists and the physical-device benchmark passes.
