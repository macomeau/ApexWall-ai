#!/usr/bin/env bash
# Full deploy pipeline: static export -> embed -> neon deploy.
# Run from anywhere: bash neon/deploy.sh
set -euo pipefail

NEON_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$NEON_DIR")"
cd "$ROOT"

echo "==> installing dependencies"
# The root app has a pre-existing peer conflict (@neondatabase/auth wants
# Next >= 16, the app pins Next 14) — legacy resolution matches the
# already-installed tree.
npm install --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1 || npm install --legacy-peer-deps --no-audit --no-fund
cd "$NEON_DIR"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
cd "$ROOT"

echo "==> building static export"
bash scripts/build-static.sh >/dev/null
echo "==> embedding web assets"
node "$NEON_DIR/scripts/embed-web.mjs"

echo "==> resolving deploy credentials"
export PATH="$PATH:$(npm root -g)/.bin:$HOME/workspace/.npm-global/bin"
# NEON_API_KEY may be provided externally (e.g. a pasted project-scoped key).
# Otherwise use the stored Special-AI credential (custom.neon-apexwall),
# falling back to the legacy shared entry.
if [ -z "${NEON_API_KEY:-}" ]; then
  export NEON_API_KEY="$(python3 -c "
import sys; sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import dynamic_credential_entry
for _name in ('custom.neon-apexwall', 'custom.neon'):
    try:
        print(dynamic_credential_entry(_name, 'access_token')['surrogate'])
        break
    except Exception:
        continue
")"
fi

# Pull the branch's env (DATABASE_URL, auth base, AI gateway) into a temp
# file. Missing vars (e.g. the gateway token before it's provisioned) are
# simply absent — neon.ts only declares keys that are set.
ENV_FILE="$(mktemp)"
neon env pull --project-id frosty-fog-97413615 --branch production \
  --file "$ENV_FILE" \
  -e DATABASE_URL,NEON_AUTH_BASE_URL,NEON_AI_GATEWAY_TOKEN,NEON_AI_GATEWAY_BASE_URL \
  >/dev/null 2>&1 || true
if ! grep -q "^DATABASE_URL=" "$ENV_FILE" 2>/dev/null; then
  echo "ERROR: neon env pull did not return DATABASE_URL" >&2
  rm -f "$ENV_FILE"
  exit 1
fi

echo "==> deploying to Special-AI (production branch)"
cd "$NEON_DIR"
neon deploy --env "$ENV_FILE" --update-existing
rm -f "$ENV_FILE"

echo "==> done"
