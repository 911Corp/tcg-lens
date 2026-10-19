# TCG Lens v0.2.3 - Frame Quality and Perspective Hardening

Status: hardened candidate, not production-ready.

## Goal

Prevent low-quality or geometrically invalid frames from accumulating enough evidence to produce a confident identification.

## Geometry gate

Before rectification, the detected card quadrilateral is validated for:

- finite coordinates;
- frame bounds with a small tolerance;
- convexity and non-self-intersection;
- minimum and maximum card area;
- minimum edge length;
- plausible portrait card aspect;
- acceptable corner angles / perspective severity.

Invalid geometry is rejected before embedding or OCR.

## Rectification

- homography must be finite and stable;
- projected coordinates must remain finite;
- sampling now uses bilinear interpolation instead of nearest-neighbor sampling;
- rectification failures expose a precise telemetry reason.

## Lock quality gates

`EvidenceFusion` now requires a minimum average frame quality for any lock.

- OCR-supported lock requires `lockMinAverageQuality`.
- Visual-only lock requires a stricter `visualOnlyMinAverageQuality`.
- High embedding similarity alone cannot compensate for poor image quality.

## Validation at checkpoint

- Lens policy + sequence replay tests: 27/27 passing.
- Historical resolution: 4/4.
- TCGdex ingestion: 4/4.
- Market connectors: 6/6.
- Sealed/barcode: 5/5.
- SQL migrations: pass.
- iOS syntax parse: pass.
- web syntax: pass.
- `git diff --check`: clean.

Thresholds remain calibration candidates until the physical-device benchmark set exists. They must not be relaxed only to improve apparent recognition rate.
