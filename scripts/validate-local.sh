#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo '[1/8] TypeScript core + tests compile'
tsc -p tsconfig.core.json --pretty false

echo '[2/8] Ingestion suites compile'
tsc -p tsconfig.ingestion-test.json --pretty false
tsc -p tsconfig.market-test.json --pretty false
tsc -p tsconfig.sealed-test.json --pretty false
tsc -p tsconfig.market-integration.json --pretty false
tsc -p tsconfig.sealed-integration.json --pretty false
tsc -p apps/ingestion/tsconfig.json --pretty false

echo '[3/8] API typecheck (runtime shims when node_modules are unavailable)'
tsc -p apps/api/tsconfig.json --noEmit --pretty false

echo '[4/8] Unit tests'
node --test .tmp-core/packages/resolution/test/resolution.test.js
node --test .tmp-ingestion-test/packages/ingestion/test/tcgdex-bootstrap.test.js
node --test .tmp-market-test/packages/ingestion/test/market-connectors.test.js
node --test .tmp-sealed-test/packages/ingestion/test/sealed-barcode.test.js

echo '[5/8] SQL migrations'
bash scripts/check-sql.sh

echo '[6/8] iOS syntax parse'
swiftc -parse \
  ios/TCGLens/Sources/App/TCGLensApp.swift \
  ios/TCGLens/Sources/Camera/CameraPreview.swift \
  ios/TCGLens/Sources/Camera/CameraService.swift \
  ios/TCGLens/Sources/Camera/LensCameraScreen.swift \
  ios/TCGLens/Sources/DesignSystem/LensTheme.swift \
  ios/TCGLens/Sources/Models/LensResult.swift

echo '[7/8] Web preview syntax'
node --check apps/web-preview/app.js
find apps/web-preview-live-repro/lens -name '*.js' -print0 | xargs -0 -n1 node --check
node --check apps/web-preview-live-repro/app-1.js
node --check apps/web-preview-live-repro/app-2.js
node --check apps/web-preview-live-repro/app-3.js
node --check apps/web-preview-live-repro/app-4.js

echo '[8/8] Lens runtime policy tests'
node --test apps/web-preview-live-repro/test/lens-runtime.test.js

echo 'VALIDATION OK'
echo 'Note: Android APK build requires Android SDK/Gradle; iOS binary build requires Xcode on macOS.'
