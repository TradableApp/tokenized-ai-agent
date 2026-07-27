#!/bin/bash
# pipefail so a failure on the LEFT of a pipeline (e.g. the awk that enumerates
# on-chain secret names feeding the PART 4 purge loop) aborts instead of being
# masked by the exit status of the loop it feeds.
set -eo pipefail

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

# --- PART 1: REGENERATE THE COMPOSE environment: BLOCK ---
echo "📄 Updating '${COMPOSE_TEMPLATE}' environment block..."
printf "%b" "$ENV_YAML" > "$SECRETS_TMP_DIR/env.yaml"
# Drift guard: if `environment:` is ever removed or renamed, awk matches nothing,
# copies the file through verbatim and exits 0 — the secrets block would silently NOT
# be regenerated and the deployment would run on a stale env. awk itself reports
# whether it substituted (exit 3), which is the only reliable signal: grepping the
# output for our banner does NOT work, because a verbatim copy still carries the
# banner emitted by the PREVIOUS run.
if ! awk '
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
' "$COMPOSE_TEMPLATE" > "${COMPOSE_TEMPLATE}.new"; then
  echo "❌ compose rewrite failed: no 'environment:' key found in $COMPOSE_TEMPLATE, so"
  echo "   the block was NOT regenerated. Fix the template (or the awk) rather than"
  echo "   deploying a stale environment block."
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
# The enumeration above parses rofl.yaml with indentation-sensitive awk because the
# oasis CLI has no `secret list` (only get/import/rm/set) and no JSON output. That
# makes a CLI formatting change able to turn the purge into a SILENT no-op, letting
# orphans pile up and re-consume slots — the very thing this section exists to stop.
# So assert the parse still works: if the manifest clearly has a secrets: block for
# this deployment but we extracted nothing, the parser has drifted — fail loudly.
deployment_has_secrets_block() {
  awk -v target="^  $DEPLOYMENT_TARGET:" '
    $0 ~ target { inblk=1; next }
    inblk && /^  [a-zA-Z]/ { inblk=0 }
    inblk && /^    secrets:/ { found=1; exit }
    END { if (found) print "true" }
  ' rofl.yaml
}

# Independent cross-check against the CLI's own view. `oasis rofl show --format json`
# reports `.app.secrets` as a name-keyed object, so it can confirm the manifest parse
# without any indentation assumptions.
#
# NOTE we reconcile the MANIFEST (rofl.yaml), not this, and that is deliberate: the
# manifest is what `oasis rofl update` will push, and it can legitimately hold entries
# that are not on-chain yet (rofl:set writes locally; the push is a separate step).
# Reconciling against the chain would skip purging exactly those pending orphans.
# Best-effort: any CLI/parse failure returns 0 and simply skips the cross-check, so a
# tooling hiccup or an offline run can never block a deploy.
cli_onchain_secret_count() {
  oasis rofl show --deployment "$DEPLOYMENT_TARGET" --format json 2>/dev/null |
    python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(len((d.get("app") or {}).get("secrets") or {}))
except Exception:
    print(0)' 2>/dev/null || echo 0
}

ONCHAIN_NAMES="$(list_onchain_secret_names)"
CLI_COUNT="$(cli_onchain_secret_count)"
if [ -z "$ONCHAIN_NAMES" ] && [ "${CLI_COUNT:-0}" -gt 0 ]; then
  echo "❌ Purge aborted: 'oasis rofl show --format json' reports $CLI_COUNT on-chain"
  echo "   secret(s) for '$DEPLOYMENT_TARGET', but the rofl.yaml parser extracted none —"
  echo "   list_onchain_secret_names has drifted from the manifest format. Fix it before"
  echo "   trusting this step."
  exit 1
fi
if [ -z "$ONCHAIN_NAMES" ] && [ "$(deployment_has_secrets_block)" == "true" ]; then
  echo "❌ Purge aborted: rofl.yaml has a secrets: block for '$DEPLOYMENT_TARGET' but the"
  echo "   parser extracted no names — its indentation assumptions have drifted from the"
  echo "   oasis CLI's output. Fix list_onchain_secret_names before trusting this step."
  exit 1
fi
printf '%s\n' "$ONCHAIN_NAMES" | while IFS= read -r sname; do
  [ -z "$sname" ] && continue
  if ! is_kept "$sname"; then
    echo "  - Purging orphaned:    $sname  (now plaintext config)"
    oasis rofl secret rm "$sname" --deployment "$DEPLOYMENT_TARGET" 2>/dev/null || true
  fi
done

echo "✅ Done: secrets synced + compose regenerated for '$ENV'."
echo "   (POSTGRES_CLIENT_CERT/KEY owned by rofl-init-cloud-sql.sh — not pushed here.)"
echo "⚠️  REMINDER: run \`oasis rofl update --deployment $DEPLOYMENT_TARGET\` to commit on-chain."
