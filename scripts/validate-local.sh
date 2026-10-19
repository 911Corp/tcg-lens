#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo '[1/10] TypeScript core + tests compile'
tsc -p tsconfig.core.json --pretty false

echo '[2/10] Ingestion suites compile'
tsc -p tsconfig.ingestion-test.json --pretty false
tsc -p tsconfig.market-test.json --pretty false
tsc -p tsconfig.sealed-test.json --pretty false
tsc -p tsconfig.market-integration.json --pretty false
tsc -p tsconfig.sealed-integration.json --pretty false
tsc -p apps/ingestion/tsconfig.json --pretty false

echo '[3/10] API typecheck (runtime shims when node_modules are unavailable)'
tsc -p apps/api/tsconfig.json --noEmit --pretty false

echo '[4/10] Unit tests'
node --test .tmp-core/packages/resolution/test/resolution.test.js
node --test .tmp-ingestion-test/packages/ingestion/test/tcgdex-bootstrap.test.js .tmp-ingestion-test/packages/ingestion/test/catalog-policy.test.js
node --test .tmp-market-test/packages/ingestion/test/market-connectors.test.js
node --test .tmp-sealed-test/packages/ingestion/test/sealed-barcode.test.js

echo '[5/10] SQL migrations'
bash scripts/check-sql.sh

echo '[6/10] iOS syntax parse'
if ! command -v swiftc >/dev/null 2>&1; then
  if [ "${REQUIRE_SWIFT:-0}" = "1" ]; then echo 'swiftc required (REQUIRE_SWIFT=1) but not found' >&2; exit 1; fi
  echo 'SKIPPED: swiftc not available on this host (set REQUIRE_SWIFT=1 to enforce; run on macOS/Xcode CI)'
else
swiftc -parse \
  ios/TCGLens/Sources/App/TCGLensApp.swift \
  ios/TCGLens/Sources/Camera/CameraPreview.swift \
  ios/TCGLens/Sources/Camera/CameraService.swift \
  ios/TCGLens/Sources/Camera/LensCameraScreen.swift \
  ios/TCGLens/Sources/DesignSystem/LensTheme.swift \
  ios/TCGLens/Sources/Models/LensResult.swift
fi

echo '[7/10] Web preview syntax'
node --check apps/web-preview/app.js
find apps/web-preview-live-repro/lens -name '*.js' -print0 | xargs -0 -n1 node --check
node --check apps/web-preview-live-repro/app-1.js
node --check apps/web-preview-live-repro/app-2.js
node --check apps/web-preview-live-repro/app-3.js
node --check apps/web-preview-live-repro/app-4.js
find apps/web-preview-live-repro/api -name '*.js' -print0 | xargs -0 -n1 node --check

echo '[8/10] Lens runtime policy tests'
node --test apps/web-preview-live-repro/test/*.test.js

echo '[9/10] Lens benchmark regression gate'
node apps/web-preview-live-repro/benchmark/run-gold-replay.mjs >/tmp/tcg-lens-benchmark.json
node -e 'const r=require("/tmp/tcg-lens-benchmark.json");console.log(JSON.stringify({pass:r.pass,scenarios:`${r.passingScenarios}/${r.scenarioCount}`,locks:r.totalLocks,falseConfidentLocks:r.falseConfidentLocks,FCIR:r.falseConfidentIdentificationRate,lockPrecision:r.lockPrecision,datasetTier:r.datasetTier}))'

echo '[10/10] PostgreSQL integration (requires TEST_DATABASE_URL with migrations 0001-0008)'
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  npm run --silent test:integration -w @tcglens/ingestion-worker
  npm run --silent test:market-integration -w @tcglens/ingestion-worker
  npm run --silent test:sealed-integration -w @tcglens/ingestion-worker
  npm run --silent test:v031-integration -w @tcglens/ingestion-worker
else
  echo 'SKIPPED: TEST_DATABASE_URL not set'
fi

echo 'VALIDATION OK'
echo 'Note: Android APK build requires Android SDK/Gradle; iOS binary build requires Xcode on macOS.'
