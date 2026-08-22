#!/usr/bin/env bash
# Build dsh-token-sql plugin: generate tsconfig.build.json, compile src/ → lib/
# with tsc, then bundle src/client/ → lib/client.js with tsdown when present.
#
# Usage:
#   bash scripts/build.sh          # build
#   bash scripts/build.sh typecheck  # typecheck only, no output
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-build}"

# Generate tsconfig.build.json (also detects DSH_CHECKOUT).
DSH_CHECKOUT="${DSH_CHECKOUT:-}" node scripts/generate-tsconfig.mjs

# Detect the same checkout for the tsc binary.
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] && [ -d "$ROOT/../../packages" ]; then
  CHECKOUT="$(cd "$ROOT/../.." && pwd)"
fi
# Fallback: read the generated config's first path to locate checkout.
if [ -z "$CHECKOUT" ] && [ -f "$ROOT/tsconfig.build.json" ]; then
  CHECKOUT="$(node - <<'NODE'
const fs = require('fs')
const path = require('path')
const cfg = JSON.parse(fs.readFileSync('tsconfig.build.json', 'utf8'))
const key = Object.keys(cfg.compilerOptions?.paths ?? {})[0]
if (key) {
  const p = cfg.compilerOptions.paths[key][0]
  // p is absolute like <checkout>/vendor/...
  const parts = p.split(path.sep)
  const idx = parts.indexOf('vendor')
  if (idx > 0) console.log(parts.slice(0, idx).join(path.sep))
}
NODE
)"
fi

if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: 未自动探测到 DSH checkout，请设置 DSH_CHECKOUT 环境变量" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

if [ "$MODE" = "typecheck" ]; then
  "$TSC" -p tsconfig.build.json --noEmit
else
  rm -rf lib
  "$TSC" -p tsconfig.build.json
  if [ -d "$ROOT/src/client" ]; then
    if [ -x "$ROOT/node_modules/.bin/tsdown" ]; then
      (cd "$ROOT" && npm run build:client)
    elif [ -x "$CHECKOUT/node_modules/.bin/tsdown" ]; then
      (cd "$ROOT" && "$CHECKOUT/node_modules/.bin/tsdown" --tsconfig tsconfig.build.json)
    else
      echo "build: src/client exists but tsdown is not installed; skipping client bundle" >&2
    fi
  fi
  echo "=== Build complete ==="
fi
