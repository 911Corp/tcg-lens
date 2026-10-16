#!/usr/bin/env bash
set -euo pipefail
for f in db/migrations/*.sql; do
  echo "checking $f"
  grep -q "BEGIN;" "$f"
  grep -q "COMMIT;" "$f"
done
