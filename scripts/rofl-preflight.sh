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

# FAIL CLOSED if the marker is missing. Without it the bounded scan never opens, nothing is
# examined, and this script reported a clean pass — a bypass where a hand-edited or truncated
# compose sails into an ORC bundle unvalidated, which is the exact hole it exists to close.
# Verified before the fix: a compose whose only config line was `0xYourAIAgentAddressHere`
# passed with exit 0. Found by review on the sense-ai-core port of this file (#103) and applied
# to both copies so they do not diverge.
# The one marker string, matched EXACTLY. A loose substring also hits a comment such as
# `# see the ORC BUNDLE CONFIGURATION block below`, which would open the scan early over the
# secrets half, where quoted values are legitimate and deliberately unchecked. It also disagreed
# with the error message below, which quotes the full marker. -F because it is a fixed string.
ORC_MARKER='# === 📄 ORC BUNDLE CONFIGURATION (PLAINTEXT) ==='

# A whole LINE equal to the marker, not a substring anywhere in the file.
#
# History, because this has now been wrong twice. First a loose `grep -q "ORC BUNDLE
# CONFIGURATION"` matched a comment merely mentioning the phrase. Then `grep -qF` on the full
# marker still matched that text appearing INSIDE another line while the real marker line was
# absent — in both cases the scan never opened, `failures` stayed empty and the script exited 0.
# awk compares each line to the marker after trimming both ends; the loop below trims both ends
# too, which is what actually makes presence and scan-open test the same thing.
if ! awk -v m="$ORC_MARKER" '{ line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line); if (line == m) found = 1 } END { exit !found }' "$COMPOSE_FILE"; then
  echo "❌ Preflight: '$COMPOSE_FILE' has no '$ORC_MARKER' marker."
  echo "   The plaintext block cannot be located, so nothing can be validated. Regenerate the"
  echo "   compose with \`bun run rofl:set:<env>\` rather than editing it by hand."
  exit 1
fi

while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  # Trailing whitespace too. The awk presence check trims BOTH ends, this stripped only the
  # leading end — so a marker line carrying trailing spaces (an ordinary editor artefact, and
  # precisely the hand-edited case this gate exists for) satisfied awk while never opening the
  # scan. The file was then read to EOF with `failures` empty and the script exited 0: the
  # silent pass this whole check was added to close, reintroduced by the fix for it.
  trimmed="${trimmed%"${trimmed##*[^[:space:]]}"}"
  if [[ "$trimmed" == "$ORC_MARKER" ]]; then in_config_block=true; continue; fi
  # Explicit string test rather than `$in_config_block || continue`: that idiom only works
  # because `true`/`false` happen to be executable builtins, so any other value would be run as
  # a command. No live bug, but a trap for whoever patches this next.
  [[ "$in_config_block" == "true" ]] || continue
  # Only real assignments. `- ` alone also matches ports: and volumes:, and in_config_block is
  # never reset — so any such list appearing AFTER the environment block falls inside the scan
  # and is parsed as a key/value pair. This repo's generated composes happen to put ports: and
  # volumes: BEFORE the environment block, so it is latent here; sense-ai-core's put them after,
  # where `- "3000:3000"` really was being scanned and escaped a quoted-value report only
  # because, with no `=` in the line, `${trimmed#*=}` returns the whole string including `- `.
  # Fixed in both copies rather than only where it currently bites.
  [[ "$trimmed" =~ ^-[[:space:]][A-Za-z_][A-Za-z0-9_]*= ]] || continue

  key="${trimmed#- }"; key="${key%%=*}"
  val="${trimmed#*=}"
  # Trailing whitespace off, so a hand-edited `- KEY="MAX"   ` is still seen as quoted: without
  # it, rofl_is_quoted fails its `'"'*'"'` pattern because the value does not END in a quote.
  # sense-ai-core's TypeScript parseEnvFile already trimmed, so the two validators disagreed on
  # exactly the hand-edited case this gate exists for.
  val="${val%"${val##*[^[:space:]]}"}"

  # `mcp` is exempt from the quote and placeholder rules because bare-empty is its CORRECT
  # form — but exempting it outright also exempted it from every check, so a hand-edited compose
  # carrying `mcp=""` (the v0.3.3 TEE regression) or `mcp=#` (which broke callbacks across
  # v0.3.0-v0.3.2) passed clean. It has its own rule instead: any value at all is wrong, because
  # plugin-mcp reads this setting first and only falls back to character.settings.mcp when it is
  # falsy, so anything truthy registers ZERO MCP servers.
  if [ "$key" = "mcp" ]; then
    if [ -n "$val" ]; then
      failures+="  ✗ mcp=${val}\n      must be bare empty — any value registers ZERO MCP servers (see CLAUDE.md)\n"
    fi
    continue
  fi
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
