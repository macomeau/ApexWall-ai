#!/usr/bin/env bash
# Build the static export for the Neon Functions deployment.
# Route handlers under src/app/api break `output: "export"`, so they are
# stashed aside for the build and restored afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STASH_DIR=""
if [ -d src/app/api ]; then
  STASH_DIR="$(mktemp -d)"
  mv src/app/api "$STASH_DIR/api"
  trap 'mv "$STASH_DIR/api" src/app/api; rm -rf "$STASH_DIR"' EXIT
fi

STATIC_EXPORT=1 npx next build

echo "Static export written to $ROOT/out"
