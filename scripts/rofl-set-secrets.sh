#!/bin/bash
set -e

ENV="$1"

if [ -z "$ENV" ]; then
  echo "❌ Usage: $0 <env>"
  echo "   (e.g., testnet, mainnet, base-testnet, base-mainnet)"
  exit 1
fi

# The environment name now maps DIRECTLY to the deployment name in rofl.yaml.
# No complex mapping is needed.
DEPLOYMENT_TARGET="$ENV"

echo "🔐 Setting secrets for environment '$ENV' on ROFL deployment '$DEPLOYMENT_TARGET'..."

# --- File Paths ---
BASE_ENV_FILE="./oracle/.env.oracle"
ENV_FILE="./oracle/.env.oracle.${ENV}"

if [ ! -f "$BASE_ENV_FILE" ]; then
  echo "❌ Base env file not found: $BASE_ENV_FILE"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Env-specific file not found: $ENV_FILE"
  exit 1
fi

# --- Merge and Set Secrets ---
MERGED_VARS=$( (cat "$BASE_ENV_FILE"; cat "$ENV_FILE") | grep -v '^#' | grep -E '.+=' | awk -F= '!seen[$1]++' )

while IFS='=' read -r KEY VALUE; do
  if [ -z "$KEY" ] || [ -z "$VALUE" ]; then
    continue
  fi

  echo "  - Setting secret: $KEY"
  oasis rofl secret rm "$KEY" --deployment "$DEPLOYMENT_TARGET" 2>/dev/null || true
  echo -n "$VALUE" | oasis rofl secret set "$KEY" --deployment "$DEPLOYMENT_TARGET" -
done <<< "$MERGED_VARS"

echo "✅ Done: All secrets set for '$ENV' on ROFL deployment '$DEPLOYMENT_TARGET'."
echo "⚠️  Don't forget to run: oasis rofl update --deployment '$DEPLOYMENT_TARGET'"