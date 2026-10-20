#!/usr/bin/env bash
# Deploy the Lens web app as a SEPARATE Vercel preview project (never touches existing projects).
#   VERCEL_TOKEN=... [VERCEL_SCOPE=911corps-projects] [PROJECT=tcg-lens-v032-preview] scripts/deploy-preview.sh
# Requires the candidate-pool export in apps/web-preview-live-repro/data (npm run build:coverage).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/web-preview-live-repro"
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
PROJECT="${PROJECT:-tcg-lens-v032-preview}"
for lang in fr en ja; do
  test -s "$APP/data/candidate-pool-$lang.json" || { echo "missing candidate pool for $lang; run npm run build:coverage" >&2; exit 1; }
done
SCOPE_ARGS=(); if [ -n "${VERCEL_SCOPE:-}" ]; then SCOPE_ARGS=(--scope "$VERCEL_SCOPE"); fi
cd "$APP"
rm -rf .vercel
npx --yes vercel@64.7.0 link --yes --project "$PROJECT" --token "$VERCEL_TOKEN" "${SCOPE_ARGS[@]}" >/dev/null
URL="$(npx --yes vercel@64.7.0 deploy --prod --yes --token "$VERCEL_TOKEN" "${SCOPE_ARGS[@]}")"
echo "$URL"
for path in / /api/visual-cards?lang=fr\&size=8 "/api/candidate-lookup?lang=en&number=199&total=165"; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$URL$path")" "$path"
done
