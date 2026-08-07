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

PLACEHOLDER_RE='0x[Yy]our|your_.*_here|YourAddressHere|ChangeMe|CHANGEME|<[a-z_]*>'
failures=""

while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  [[ "$trimmed" != "- "* ]] && continue

  key="${trimmed#- }"; key="${key%%=*}"
  val="${trimmed#*=}"

  [ "$key" = "mcp" ] && continue          # deliberately bare-empty
  [ -z "$val" ] && continue
  [[ "$val" == '${'* ]] && continue        # runtime-injected secret

  if printf '%s' "$val" | grep -qE "$PLACEHOLDER_RE"; then
    failures+="  ✗ ${key}=${val}\n      placeholder — would be baked into the bundle and fail at use time, not at boot\n"
  fi
  case "$val" in
    '"'*'"'|"'"*"'")
      failures+="  ✗ ${key}=${val}\n      quoted — docker-compose keeps the quotes, so the container sees them in the value\n"
      ;;
  esac
done < "$COMPOSE_FILE"

if [ -n "$failures" ]; then
  echo ""
  echo "❌ Preflight failed for '$COMPOSE_FILE' — refusing to build an ORC bundle."
  printf '%b' "$failures"
  echo "   Fix the source env file and re-run \`bun run rofl:set:<env>\`. No bundle was built."
  exit 1
fi
echo "✅ Preflight: '$COMPOSE_FILE' has no placeholder or quoted values."
