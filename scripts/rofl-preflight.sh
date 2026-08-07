#!/bin/bash
# Validate a generated compose file before it is baked into an ORC bundle.
#
# WHY THIS EXISTS SEPARATELY FROM rofl-set-secrets.sh.
# That script guards the .env -> compose step, which only covers `rofl:set:<env>`.
# But `rofl:build:<env>` does `cp compose.<env>.yaml compose.yaml && oasis rofl build`
# WITHOUT running set, so a stale or hand-edited compose could still be bundled — the
# guard was bypassable by the one command whose entire job is producing the artifact.
# Both review bots caught this independently. This script is therefore called from the
# BUILD path, where it is the last gate before an ORC exists.
#
# WHAT IT CATCHES. Everything in the plaintext section is baked in as a literal, so
# these cannot be caught by any startup check inside the TEE:
#
#   PLACEHOLDERS — `ethers` does NOT reject a non-address string at construction; it
#   treats it as an ENS name and defers resolution:
#       new ethers.Contract("0xYourAIAgentAddressHere", abi, provider)
#         -> OK, target="0xYourAIAgentAddressHere"
#   so the oracle boots, looks healthy, accepts prompts, and fails asynchronously on
#   every answer while the wallet pays gas.
#
#   QUOTED VALUES — docker-compose does not strip surrounding quotes, so KEY="MAX"
#   reaches the container as the 5-character string "MAX" and an exact comparison
#   silently takes the wrong branch. sense-ai-core shipped exactly that on mainnet.
#   `mcp` is the one deliberate exception (emitted bare on purpose).
#
# Secrets are NOT checked: they are `${VAR:-}` placeholders here by design, resolved
# at runtime from the ROFL manifest, so a missing one fails closed rather than shipping.
set -euo pipefail

COMPOSE_FILE="${1:?usage: rofl-preflight.sh <compose-file>}"
[ -f "$COMPOSE_FILE" ] || { echo "❌ Preflight: '$COMPOSE_FILE' not found."; exit 1; }

. "$(dirname "$0")/rofl-config-patterns.sh"
failures=""

# Scan ONLY the plaintext config block, not the whole YAML. The `- ` prefix alone also
# matches ports:, volumes: and any future service list, so a volume like
# `- /data/store?x=1:/container` would be parsed as a key/value pair and could trip the
# placeholder check or mask a real one. Bounding the scan removes that whole class.
in_config_block=false

while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in *"ORC BUNDLE CONFIGURATION"*) in_config_block=true; continue ;; esac
  $in_config_block || continue
  [[ "$trimmed" != "- "* ]] && continue

  key="${trimmed#- }"; key="${key%%=*}"
  val="${trimmed#*=}"

  [ "$key" = "mcp" ] && continue          # deliberately bare-empty
  [ -z "$val" ] && continue
  [[ "$val" == '${'* ]] && continue        # runtime-injected secret

  if printf '%s' "$val" | grep -qE "$ROFL_PLACEHOLDER_RE"; then
    failures+="  ✗ ${key}=${val}\n      placeholder — would be baked into the bundle and fail at use time, not at boot\n"
  fi
  if rofl_is_quoted "$val"; then
    failures+="  ✗ ${key}=${val}\n      quoted — docker-compose keeps the quotes, so the container sees them in the value\n"
  fi
done < "$COMPOSE_FILE"

if [ -n "$failures" ]; then
  echo ""
  echo "❌ Preflight failed for '$COMPOSE_FILE' — refusing to build an ORC bundle."
  printf '%b' "$failures"
  env_name="$(basename "$COMPOSE_FILE" .yaml)"; env_name="${env_name#compose.}"
  echo "   These come from oracle/.env.oracle.${env_name} (NOT this file — it is regenerated)."
  echo "   Fix them there, then \`bun run rofl:set:${env_name}\`. No bundle was built."
  exit 1
fi
echo "✅ Preflight: '$COMPOSE_FILE' has no placeholder or quoted values."
