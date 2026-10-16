#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo '[1/7] TypeScript core + tests compile'
tsc -p tsconfig.core.json --pretty false

echo '[2/7] Ingestion suites compile'
tsc -p tsconfig.ingestion-test.json --pretty false
tsc -p tsconfig.market-test.json --pretty false
tsc -p tsconfig.sealed-test.json --pretty false
tsc -p tsconfig.market-integration.json --pretty false
tsc -p tsconfig.sealed-integration.json --pretty false
tsc -p apps/ingestion/tsconfig.json --pretty false

echo '[3/7] API typecheck (runtime shims when node_modules are unavailable)'
tsc -p apps/api/tsconfig.json --noEmit --pretty false

echo '[4/7] Unit tests'
node --test .tmp-core/packages/resolution/test/resolution.test.js
node --test .tmp-ingestion-test/packages/ingestion/test/tcgdex-bootstrap.test.js
node --test .tmp-market-test/packages/ingestion/test/market-connectors.test.js
node --test .tmp-sealed-test/packages/ingestion/test/sealed-barcode.test.js

echo '[5/7] SQL migrations'
bash scripts/check-sql.sh

echo '[6/7] iOS syntax parse'
swiftc -parse \
  ios/TCGLens/Sources/App/TCGLensApp.swift \
  ios/TCGLens/Sources/Camera/CameraPreview.swift \
  ios/TCGLens/Sources/Camera/CameraService.swift \
  ios/TCGLens/Sources/Camera/LensCameraScreen.swift \
  ios/TCGLens/Sources/DesignSystem/LensTheme.swift \
  ios/TCGLens/Sources/Models/LensResult.swift

echo '[7/7] Web preview syntax'
node --check apps/web-preview/app.js

echo 'VALIDATION OK'
echo 'Note: Android APK build requires Android SDK/Gradle; iOS binary build requires Xcode on macOS.'
