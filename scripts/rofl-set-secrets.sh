#!/bin/bash
# pipefail so a failure on the LEFT of a pipeline (e.g. the awk that enumerates
# on-chain secret names feeding the PART 4 purge loop) aborts instead of being
# masked by the exit status of the loop it feeds.
set -euo pipefail

# Syncs the oracle's env-driven secrets/config to a ROFL deployment AND
# regenerates the deployment compose `environment:` block from the same source
# (single source of truth). Ported from sense-ai-core's hardened script and
# adapted for the oracle's TWO-FILE env layout:
#
#   * reads oracle/.env.oracle.<env> (env-specific, WINS) then oracle/.env.oracle
#     (base, fills gaps) — same precedence the running oracle uses
#     (contractUtility.js loads ENV_FILE first, then .env.oracle).
#   * each file is split by the delimiter into a 🔒 SECRETS section (pushed
#     on-chain, injected as ${KEY:-}) and a 📄 CONFIG section (plaintext literal
#     in the ORC bundle — costs ZERO ROFL secret slots). Put credentials above
#     the delimiter, everything else below.
#   * Cloud-SQL ownership mirrors sense-ai-core:
#       - CLIENT_CERT / CLIENT_KEY        → rofl-init-cloud-sql.sh (minted cert)
#       - POSTGRES_PASSWORD / SERVER_CA   → GCP Secret Manager, fetched in PART 3
#     Both are "externally managed": injected as ${KEY:-} but NOT pushed/purged
#     from the .env flow.
#   * `mcp` always emits a literal `- mcp=<value>` (quotes stripped) to satisfy
#     the @elizaos/plugin-mcp env-precedence footgun (see sense-ai-core CLAUDE.md).
#
# ⚠️  INLINE COMMENTS ARE UNSUPPORTED IN THE 🔒 SECRETS SECTION. Values there are
#     treated as opaque bytes (trailing whitespace trimmed only), because ANY
#     comment-stripping rule can silently truncate a credential that legitimately
#     contains `#` — which surfaces later only as an unexplained auth failure inside
#     the TEE. Put commentary on its own `#` line above the key. The 📄 CONFIG
#     section is unaffected (its values are plaintext and never comment-stripped).
#
# Sensitive values go to 0700 temp files passed via file-path mode
# (`oasis rofl secret set <file>` — stdin reads only the first line of multi-line
# values), cleaned via an EXIT trap so a `set -e` abort leaves no plaintext.

SECRETS_TMP_DIR=$(mktemp -d)
chmod 700 "$SECRETS_TMP_DIR"
trap 'rm -rf "$SECRETS_TMP_DIR"' EXIT

ENV="$1"
if [ -z "$ENV" ]; then
  echo "❌ Usage: $0 <env>   (base-testnet | base-mainnet | testnet | mainnet)"
  exit 1
fi

DEPLOYMENT_TARGET="$ENV"
BASE_ENV_FILE="./oracle/.env.oracle"
ENV_FILE="./oracle/.env.oracle.${ENV}"
COMPOSE_TEMPLATE="compose.${ENV}.yaml"

SPLIT_DELIMITER="=== 📄 ORC BUNDLE CONFIGURATION (PLAINTEXT) ==="

for f in "$BASE_ENV_FILE" "$ENV_FILE" "$COMPOSE_TEMPLATE"; do
  [ -f "$f" ] || { echo "❌ Required file not found: $f"; exit 1; }
done
for f in "$BASE_ENV_FILE" "$ENV_FILE"; do
  grep -q "$SPLIT_DELIMITER" "$f" || {
    echo "❌ Delimiter missing in $f — add:  # $SPLIT_DELIMITER"
    exit 1
  }
done

# --- Cloud-SQL ownership (mirrors sense-ai-core) ---
is_init_managed_key() { case "$1" in POSTGRES_CLIENT_CERT|POSTGRES_CLIENT_KEY) return 0;; *) return 1;; esac; }
is_sm_managed_key()   { case "$1" in POSTGRES_PASSWORD|POSTGRES_SERVER_CA_CERT) return 0;; *) return 1;; esac; }
is_externally_managed_key() { is_init_managed_key "$1" || is_sm_managed_key "$1"; }
sm_secret_name_for_key() {
  case "$1" in
    POSTGRES_PASSWORD)       echo "SENSE_AI_APP_SQL_PASSWORD" ;;
    POSTGRES_SERVER_CA_CERT) echo "SENSE_AI_APP_SQL_SERVER_CA_CERT" ;;
    *) echo "" ;;
  esac
}
gcp_project_for_env() {
  case "$1" in
    testnet|base-testnet) echo "tradable-app-garrick" ;;
    mainnet|base-mainnet) echo "tradable-app" ;;
    *) echo "" ;;
  esac
}
GCP_PROJECT="$(gcp_project_for_env "$ENV")"
[ -z "$GCP_PROJECT" ] && echo "⚠️  No GCP project mapping for env '$ENV' — Secret Manager fetch will be skipped."

# Warn (don't fail) if a CONFIG-section value looks like it embeds a credential —
# it would otherwise be baked into the ORC as plaintext instead of a secret.
looks_like_embedded_secret() {
  echo "$1" | grep -Eiq 'alchemy\.com/v2/[A-Za-z0-9_-]{8,}|infura\.io/v3/[A-Za-z0-9]|quiknode|[?&](api[_-]?key|apikey|access[_-]?token)='
}

echo "🔐 Parsing '${ENV_FILE}' (wins) + '${BASE_ENV_FILE}' (base) for '$ENV'..."

SECRETS_YAML=""   # 🔒 section body (compose)
CONFIG_YAML=""    # 📄 section body (compose)
SECRETS_LIST=""   # KEY__SEP__VALUE lines to push on-chain
SEEN_KEYS=""      # |KEY| dedup registry (env-specific wins)
KEEP_KEYS=""      # |KEY| the secrets that SHOULD stay on-chain (for orphan purge)

is_seen()  { case "$SEEN_KEYS" in *"|$1|"*) return 0;; *) return 1;; esac; }
mark_seen(){ SEEN_KEYS="${SEEN_KEYS}|$1|"; }
is_kept()  { case "$KEEP_KEYS" in *"|$1|"*) return 0;; *) return 1;; esac; }
keep_key() { KEEP_KEYS="${KEEP_KEYS}|$1|"; }

process_file() {
  local file="$1" is_config=0 line key remainder value
  while IFS= read -r line || [ -n "$line" ]; do
    # delimiter → switch to config section (no compose output; banners added once, later)
    if [[ "$line" == *"$SPLIT_DELIMITER"* ]]; then is_config=1; continue; fi
    # drop comments / blanks (compose is a clean generated artifact)
    [[ "$line" == "#"* ]] && continue
    [ -z "$(echo "$line" | tr -d '[:space:]')" ] && continue
    [[ "$line" != *"="* ]] && continue

    key=$(echo "$line" | cut -d= -f1 | tr -d '[:space:]')
    remainder=$(echo "$line" | cut -d= -f2- | sed 's/[[:space:]]*$//')
    is_seen "$key" && continue
    mark_seen "$key"

    if [ "$is_config" -eq 0 ]; then
      # 🔒 SECRETS SECTION
      if is_externally_managed_key "$key"; then
        SECRETS_YAML+="      - $key=\${$key:-}\n"      # inject, don't push
        keep_key "$key"                                # PART 3 / init own the value
        continue
      fi
      # Secret values are treated as OPAQUE: trailing whitespace is trimmed and
      # nothing else. We deliberately do NOT strip inline comments here — any such
      # rule (`#…`, or even ` #…`) can truncate a legitimate secret that contains
      # that byte sequence, pushing a corrupted credential on-chain that fails as an
      # opaque auth error inside the TEE. Inline comments are therefore UNSUPPORTED
      # in the 🔒 section (see the header note); put them on their own `#` line.
      value=$(echo "$remainder" | sed 's/[[:space:]]*$//')
      # SECRETS_LIST is a newline-delimited KEY__SEP__VALUE string, so a value
      # containing a newline would split into bogus entries: the real secret gets
      # truncated at the first line AND a phantom secret named after the second line is
      # pushed. Multi-line material (PEMs) belongs in Secret Manager / rofl-init, which
      # never routes through here, so treat a newline as an operator error.
      # NOTE: must be $'\n', not "$(printf '\n')" — command substitution strips trailing
      # newlines, yielding an EMPTY pattern that matches every value and would reject
      # every secret.
      case "$value" in
      *$'\n'*)
        echo "❌ Secret '$key' contains a newline. Multi-line values must come from"
        echo "   Secret Manager (PART 3) or rofl-init-cloud-sql.sh, not the .env file."
        exit 1
        ;;
      esac
      SECRETS_LIST+="${key}__SEP__${value}"$'\n'        # push (or purge if blank)
      if [ -n "$value" ]; then
        SECRETS_YAML+="      - $key=\${$key:-}\n"
        keep_key "$key"                                 # non-blank ⇒ stays on-chain
      fi
    else
      # 📄 CONFIG SECTION (plaintext literal)
      if [ "$key" = "mcp" ]; then
        value=$(echo "$remainder" | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')
        CONFIG_YAML+="      - mcp=$value\n"
      elif [ -n "$remainder" ]; then
        looks_like_embedded_secret "$remainder" && \
          echo "  ⚠️  '$key' is in the CONFIG section but its value looks like it embeds a credential — move it ABOVE the delimiter."
        CONFIG_YAML+="      - $key=$remainder\n"
      fi
    fi
  done < "$file"
}

process_file "$ENV_FILE"      # env-specific wins
process_file "$BASE_ENV_FILE" # base fills gaps

# Assemble the full environment block: secrets, delimiter banner, config.
ENV_YAML="      # =============================================================================\n"
ENV_YAML+="      # AUTO-GENERATED by scripts/rofl-set-secrets.sh — do NOT hand-edit.\n"
ENV_YAML+="      # Source: oracle/.env.oracle{,.${ENV}}  ·  regenerated on every rofl:set:${ENV}.\n"
ENV_YAML+="      # 🔒 On-chain ROFL secrets (injected at runtime):\n"
ENV_YAML+="      # =============================================================================\n"
ENV_YAML+="$SECRETS_YAML"
ENV_YAML+="      # =============================================================================\n"
ENV_YAML+="      # $SPLIT_DELIMITER\n"
ENV_YAML+="      # =============================================================================\n"
ENV_YAML+="$CONFIG_YAML"

# --- PART 0.5: PREFLIGHT — refuse to generate a bundle from unusable config ---
#
# Everything below the delimiter is written into the ORC bundle as a LITERAL value, so a
# bad one is not caught by any startup guard — it reaches the TEE and fails at use time.
# Both failure modes below were found on real deploys, not hypothetically.
#
#   PLACEHOLDERS. `ethers` does NOT reject a non-address string when the Contract is
#   constructed — it treats it as an ENS name and defers resolution:
#       new ethers.Contract("0xYourAIAgentAddressHere", abi, provider)
#         -> OK, target="0xYourAIAgentAddressHere"
#   so the oracle BOOTS, looks healthy, accepts prompts, and then fails asynchronously
#   on every answer while the wallet pays gas. Failing here — before an ORC exists —
#   is the only place this can be stopped cheaply.
#
#   QUOTED VALUES. docker-compose does not strip surrounding quotes, so `KEY="MAX"`
#   reaches the container as the 5-character string "MAX", quotes included, and an exact
#   comparison silently takes the wrong branch. This is the same footgun documented for
#   `mcp` in sense-ai-core's CLAUDE.md, where it cost several releases. `mcp` is the one
#   legitimate exception: the script deliberately emits it bare.
#
# Secrets are NOT checked: they are opaque bytes by design (a credential may legitimately
# contain quotes or the substring "your"), and they are injected at runtime rather than
# baked in, so a bad one fails closed.
. "$(dirname "$0")/rofl-config-patterns.sh"
preflight_failures=""

while IFS= read -r cfg_line; do
  [ -z "$cfg_line" ] && continue
  cfg_key="${cfg_line%%=*}"
  cfg_key="${cfg_key#      - }"
  cfg_val="${cfg_line#*=}"

  # `mcp` is intentionally emitted bare-empty — see the plugin-mcp null-deref workaround.
  # `mcp` is exempt from the quote and placeholder rules — bare-empty is its CORRECT form — but
  # exempting it outright also exempted it from validation, so `mcp=""` (the v0.3.3 TEE
  # regression) or `mcp=#` (which broke callbacks across v0.3.0-v0.3.2) could be written into the
  # tracked compose unchallenged. Reachable directly, or with SKIP_ENV_PARITY_CHECK=1. It gets its
  # own rule: any value at all is wrong, since anything truthy registers ZERO MCP servers.
  if [ "$cfg_key" = "mcp" ]; then
    # Trailing whitespace off first, matching the parallel check in rofl-preflight.sh. Without it
    # `mcp=   ` reads as non-empty and fails as though it carried a value. Latent for generated
    # content, reachable by hand-editing — which SKIP_ENV_PARITY_CHECK=1 leaves unguarded.
    cfg_val="${cfg_val%"${cfg_val##*[^[:space:]]}"}"
    if [ -n "$cfg_val" ]; then
      preflight_failures+="  ✗ mcp=${cfg_val}\n      must be bare empty — any value registers ZERO MCP servers (see CLAUDE.md)\n"
    fi
    continue
  fi
  [ -z "$cfg_val" ] && continue

  if printf '%s' "$cfg_val" | grep -qE "$ROFL_PLACEHOLDER_RE"; then
    preflight_failures+="  ✗ ${cfg_key}=${cfg_val}\n      placeholder — would be baked into the bundle and fail at use time, not at boot\n"
  fi
  case "$cfg_val" in
    '"'*'"'|"'"*"'")
      preflight_failures+="  ✗ ${cfg_key}=${cfg_val}\n      quoted — docker-compose keeps the quotes, so the container sees them as part of the value\n"
      ;;
  esac
done <<< "$(printf '%b' "$CONFIG_YAML")"

if [ -n "$preflight_failures" ]; then
  echo ""
  echo "❌ Preflight failed for '$ENV' — refusing to generate the compose block."
  printf '%b' "$preflight_failures"
  echo "   Fix these in oracle/.env.oracle{,.$ENV} and re-run. Nothing has been written or pushed."
  exit 1
fi
echo "✅ Preflight: no placeholder or quoted values in the plaintext config."

# --- PART 1: REGENERATE THE COMPOSE environment: BLOCK ---
echo "📄 Updating '${COMPOSE_TEMPLATE}' environment block..."
# The rewrite below targets the FIRST `environment:` key in the file, which is only
# correct while the oracle service owns the only one. `ollama` is declared ABOVE
# `oracle`, so if it ever gains an `environment:` block the rewrite would inject the
# oracle's secrets into the OLLAMA container and leave the oracle's block stale — a
# silent misconfiguration that also leaks credentials into the wrong service. The drift
# guard cannot catch this (it only detects "no environment: found"), so assert the
# assumption; if this ever fires, anchor the awk on `/^  oracle:/` instead.
ENV_BLOCK_COUNT=$(grep -c '^[[:space:]]*environment:' "$COMPOSE_TEMPLATE" || true)
if [ "${ENV_BLOCK_COUNT:-0}" -ne 1 ]; then
  echo "❌ $COMPOSE_TEMPLATE has $ENV_BLOCK_COUNT 'environment:' blocks; this script"
  echo "   assumes exactly 1 (the oracle service). Anchor the awk on the service name"
  echo "   before proceeding — otherwise the wrong service would receive the secrets."
  exit 1
fi
printf "%b" "$ENV_YAML" > "$SECRETS_TMP_DIR/env.yaml"
# Drift guard: if `environment:` is ever removed or renamed, awk matches nothing,
# copies the file through verbatim and exits 0 — the secrets block would silently NOT
# be regenerated and the deployment would run on a stale env. awk itself reports
# whether it substituted (exit 3), which is the only reliable signal: grepping the
# output for our banner does NOT work, because a verbatim copy still carries the
# banner emitted by the PREVIOUS run.
# Capture awk's own status: exit 3 is OUR drift signal, anything else non-zero is an
# awk/IO failure (unreadable template, full disk, unwritable dir). Conflating them
# would print "no environment: key" during an I/O outage and send the operator hunting
# a renamed key that was never renamed. `$?` inside an `if !` branch is the status of
# the negation, not of awk, so it must be captured here.
awk_rc=0
awk '
  /^[[:space:]]*environment:/ {
    print
    while ((getline l < "'"$SECRETS_TMP_DIR"'/env.yaml") > 0) print l
    in_env = 1
    substituted = 1
    next
  }
  in_env && /^[[:space:]]*[A-Za-z0-9_-]+:/ { in_env = 0 }
  in_env { next }
  { print }
  END { if (!substituted) exit 3 }
' "$COMPOSE_TEMPLATE" > "${COMPOSE_TEMPLATE}.new" || awk_rc=$?
if [ "$awk_rc" -eq 3 ]; then
  echo "❌ compose rewrite failed: no 'environment:' key found in $COMPOSE_TEMPLATE, so"
  echo "   the block was NOT regenerated. Fix the template (or the awk) rather than"
  echo "   deploying a stale environment block."
  rm -f "${COMPOSE_TEMPLATE}.new"
  exit 1
elif [ "$awk_rc" -ne 0 ]; then
  echo "❌ compose rewrite failed: awk exited $awk_rc while rewriting $COMPOSE_TEMPLATE."
  echo "   This is NOT the drift guard (which exits 3) — check for an unreadable template,"
  echo "   an unwritable directory or a full disk before assuming the key was renamed."
  rm -f "${COMPOSE_TEMPLATE}.new"
  exit 1
fi
mv "${COMPOSE_TEMPLATE}.new" "$COMPOSE_TEMPLATE"
echo "✅ $COMPOSE_TEMPLATE updated."

# --- PART 2: PUSH .ENV SECRETS ON-CHAIN (rm-then-set; purge blanks) ---
echo "🛰️  Synchronizing secrets on-chain for deployment '$DEPLOYMENT_TARGET'..."
secret_exists() {
  # Bound the block at the next 2-space key (the sibling deployment), matching
  # list_onchain_secret_names below. Resetting only on a column-0 key would let the
  # scan run on past `  base-mainnet:` into other deployments, so a key present ONLY
  # in another deployment would report as existing here.
  awk -v target="^  $DEPLOYMENT_TARGET:" -v key="$1" '
    $0 ~ target { in_block=1; next }
    in_block && /^  [a-zA-Z]/ { in_block=0 }
    in_block && $0 ~ "name: " key " *$" { found=1; exit }
    END { if(found) print "true" }
  ' rofl.yaml
}
echo "$SECRETS_LIST" | while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  KEY="${entry%%__SEP__*}"; VALUE="${entry#*__SEP__}"
  EXISTS=$(secret_exists "$KEY")
  if [ -n "$VALUE" ]; then
    echo "  - Encrypting secret:   $KEY"
    [ "$EXISTS" == "true" ] && oasis rofl secret rm "$KEY" --deployment "$DEPLOYMENT_TARGET" 2>/dev/null || true
    TMP_VAL="$SECRETS_TMP_DIR/${KEY}.val"
    ( umask 077; printf "%s" "$VALUE" > "$TMP_VAL" )
    oasis rofl secret set "$KEY" --deployment "$DEPLOYMENT_TARGET" "$TMP_VAL"
    rm -f "$TMP_VAL"
  elif [ "$EXISTS" == "true" ]; then
    echo "  - Purging blank key:   $KEY"
    oasis rofl secret rm "$KEY" --deployment "$DEPLOYMENT_TARGET" 2>/dev/null || true
  fi
done

# --- PART 3: FETCH SECRET-MANAGER-MANAGED SECRETS + PUSH (mirrors sense-ai-core) ---
if [ -n "$GCP_PROJECT" ]; then
  echo "🛰️  Fetching Secret Manager secrets from project '$GCP_PROJECT'..."
  for rofl_key in POSTGRES_PASSWORD POSTGRES_SERVER_CA_CERT; do
    sm_name="$(sm_secret_name_for_key "$rofl_key")"
    sm_err="$SECRETS_TMP_DIR/${rofl_key}.stderr"
    if ! sm_value=$(gcloud secrets versions access latest --secret="$sm_name" --project="$GCP_PROJECT" 2>"$sm_err"); then
      echo "  ⚠️  Skipped $rofl_key — gcloud failed fetching '$sm_name' from '$GCP_PROJECT':"
      sed 's/^/      /' "$sm_err" >&2 || true
      continue
    fi
    [ -z "$sm_value" ] && { echo "  ⚠️  Skipped $rofl_key — SM returned empty for '$sm_name'."; continue; }
    [ "$(secret_exists "$rofl_key")" == "true" ] && oasis rofl secret rm "$rofl_key" --deployment "$DEPLOYMENT_TARGET" 2>/dev/null || true
    TMP_SM="$SECRETS_TMP_DIR/${rofl_key}.sm"
    # Multi-line CA base64-encoded to survive compose env-substitution (truncates at
    # first \n); postgresBootstrap auto-detects raw (-----BEGIN) vs base64 at read time.
    if [ "$rofl_key" = "POSTGRES_SERVER_CA_CERT" ]; then
      ( umask 077; printf "%s" "$sm_value" | base64 | tr -d '\n' > "$TMP_SM" )
      echo "  - Encrypted from SM:   $rofl_key  (← $sm_name, base64)"
    else
      ( umask 077; printf "%s" "$sm_value" > "$TMP_SM" )
      echo "  - Encrypted from SM:   $rofl_key  (← $sm_name)"
    fi
    oasis rofl secret set "$rofl_key" --deployment "$DEPLOYMENT_TARGET" "$TMP_SM"
    rm -f "$TMP_SM"
  done
fi

# --- PART 4: PURGE ORPHANED SECRETS (config keys that migrated to plaintext) ---
# Keys previously pushed on-chain (e.g. by an earlier everything-as-secret run) that
# are now in the 📄 CONFIG section must be removed so they stop consuming ROFL slots.
# Purge any base-testnet secret NOT in the KEEP set (real secrets with a value +
# the externally-managed Cloud-SQL keys). CLIENT_CERT/KEY are kept (init owns them).
echo "🧹 Reconciling — purging orphaned secrets no longer in the 🔒 section..."
list_onchain_secret_names() {
  awk -v target="^  $DEPLOYMENT_TARGET:" '
    $0 ~ target { inblk=1; next }
    inblk && /^  [a-zA-Z]/ { inblk=0; insec=0 }
    inblk && /^    secrets:/ { insec=1; next }
    inblk && insec && /^    [a-zA-Z]/ { insec=0 }
    inblk && insec && /name:/ {
      n=$0; sub(/.*name:[[:space:]]*/,"",n); sub(/[[:space:]].*/,"",n); print n
    }
  ' rofl.yaml
}
# Enumeration parses rofl.yaml because that is the right SOURCE: the manifest is what
# `oasis rofl update` will push, and it can legitimately hold entries not yet on-chain,
# which reconciling against the chain would skip. (For reference, the authoritative
# on-chain view is `oasis rofl show --deployment <env> --format json` → `.app.secrets`,
# a name-keyed object — useful for debugging, but the wrong source for this purge.)
#
# The indentation-sensitive parse could in principle drift and turn the purge into a
# silent no-op. Guarding that proportionately: the worst case is orphaned secrets
# continuing to occupy slots — not data loss — so the count is printed (a run reporting
# 0 is immediately visible to whoever is deploying) plus one cheap local assertion for
# the clear-cut case where the manifest plainly has secrets but the parse found none.
deployment_has_secrets_block() {
  awk -v target="^  $DEPLOYMENT_TARGET:" '
    $0 ~ target { inblk=1; next }
    inblk && /^  [a-zA-Z]/ { inblk=0 }
    inblk && /^    secrets:/ { found=1; exit }
    END { if (found) print "true" }
  ' rofl.yaml
}
ONCHAIN_NAMES="$(list_onchain_secret_names)"
ONCHAIN_COUNT="$(printf '%s\n' "$ONCHAIN_NAMES" | grep -c '[^[:space:]]' || true)"
echo "   Examining ${ONCHAIN_COUNT:-0} secret(s) currently in the manifest for '$DEPLOYMENT_TARGET'."
if [ -z "$ONCHAIN_NAMES" ] && [ "$(deployment_has_secrets_block)" == "true" ]; then
  echo "❌ Purge aborted: rofl.yaml has a secrets: block for '$DEPLOYMENT_TARGET' but the"
  echo "   parser extracted no names — its indentation assumptions have drifted. Fix"
  echo "   list_onchain_secret_names before trusting this step."
  exit 1
fi
printf '%s\n' "$ONCHAIN_NAMES" | while IFS= read -r sname; do
  [ -z "$sname" ] && continue
  # HARD floor, independent of how KEEP_KEYS was built: never purge a key whose value
  # is owned elsewhere (mTLS cert/key from rofl-init-cloud-sql.sh; password/server-CA
  # from Secret Manager in PART 3). keep_key() only fires for these when the key still
  # appears in an env file's 🔒 section, so deleting a blank placeholder — which looks
  # like harmless dead weight, since the value comes from elsewhere — would otherwise
  # make PART 4 destroy the on-chain mTLS cert and break the next boot's Cloud SQL
  # connection. For the SM pair it would be worse still: PART 4 runs AFTER PART 3, so
  # it would purge the value PART 3 had just pushed.
  if is_externally_managed_key "$sname"; then
    continue
  fi
  if ! is_kept "$sname"; then
    echo "  - Purging orphaned:    $sname  (now plaintext config)"
    oasis rofl secret rm "$sname" --deployment "$DEPLOYMENT_TARGET" 2>/dev/null || true
  fi
done

echo "✅ Done: secrets synced + compose regenerated for '$ENV'."
echo "   (POSTGRES_CLIENT_CERT/KEY owned by rofl-init-cloud-sql.sh — not pushed here.)"
echo "⚠️  REMINDER: run \`oasis rofl update --deployment $DEPLOYMENT_TARGET\` to commit on-chain."
