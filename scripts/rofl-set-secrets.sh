#!/bin/bash
set -e

ENV="$1"

if [ -z "$ENV" ]; then
  echo "❌ Usage: $0 <env> (e.g., localnet, testnet, mainnet)"
  exit 1
fi

echo "🔐 Setting ROFL secrets from merged environment ($ENV)..."

# Paths
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

# Merge with env-specific overwriting base
MERGED_VARS=$( (cat "$BASE_ENV_FILE"; cat "$ENV_FILE") | grep -v '^#' | grep '=' | awk -F= '!seen[$1]++' )

# Export to local shell session
eval "$MERGED_VARS"

# Loop and delete+set each secret
while IFS='=' read -r KEY VALUE; do
  if [ -z "$KEY" ] || [ -z "$VALUE" ]; then
    continue
  fi

  # Delete existing secret (ignore error if not exists)
  oasis rofl secret rm "$KEY" 2>/dev/null || true

  # Set new secret
  echo -n "$VALUE" | oasis rofl secret set "$KEY" -
done <<< "$MERGED_VARS"

echo "✅ Done: All secrets set from merged env ($ENV)"
echo "⚠️  Don't forget to run: oasis rofl update"
