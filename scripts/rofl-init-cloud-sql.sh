#!/bin/bash
# rofl-init-cloud-sql.sh — ONE-TIME Cloud SQL setup per ORACLE ROFL deployment.
#
# Port of sense-ai-core's script for the Oracle body (Phase 4, CU-86d3dwme6),
# with two deliberate differences:
#   - Cert name is "rofl-oracle-<env>" — the SOCIAL body already owns
#     "rofl-<env>" on the SAME shared Cloud SQL instance; each body gets its
#     own client cert so rotation never couples them.
#   - Also fetches POSTGRES_PASSWORD + POSTGRES_SERVER_CA_CERT from GCP
#     Secret Manager and pushes them: unlike core, this repo's
#     rofl-set-secrets.sh has no Secret Manager stage, and these values are
#     one-time/rotation-rare — folding them here keeps the per-release flow
#     untouched.
#
# Multi-line PEMs bypass the .env pipeline entirely (docker-compose env
# substitution truncates at the first newline): everything is base64-encoded
# and pushed via file, and oracle/src/postgresBootstrap.js auto-detects
# raw-vs-base64 at read time.
#
# Usage:
#   bash scripts/rofl-init-cloud-sql.sh testnet | base-testnet | mainnet | base-mainnet
#
# Prereqs: gcloud authenticated for the target project; oasis CLI
# authenticated for the matching deployment account; Cloud SQL instance
# provisioned by the Infrastructure repo's Terraform.

set -e

ENV="$1"

if [ -z "$ENV" ]; then
  echo "❌ Usage: $0 <env>   (testnet | base-testnet | mainnet | base-mainnet)"
  exit 1
fi

case "$ENV" in
  testnet|base-testnet)
    GCP_PROJECT="tradable-app-garrick"
    INSTANCE="sense-ai-app-garrick"
    ;;
  mainnet|base-mainnet)
    GCP_PROJECT="tradable-app"
    INSTANCE="sense-ai-app"
    ;;
  *)
    echo "❌ Unknown env: $ENV (expected testnet, base-testnet, mainnet, or base-mainnet)"
    exit 1
    ;;
esac

CERT_NAME="rofl-oracle-${ENV}"
ENV_FILE="oracle/.env.oracle.${ENV}"

echo "🔍 Checking for existing client cert '$CERT_NAME' on $INSTANCE ($GCP_PROJECT)..."
EXISTING=$(gcloud sql ssl client-certs list \
  --instance="$INSTANCE" \
  --project="$GCP_PROJECT" \
  --format='value(commonName)' 2>/dev/null | grep -c "^${CERT_NAME}$" || true)

if [ "$EXISTING" -gt 0 ]; then
  echo "✅ Cert '$CERT_NAME' already exists — skipping creation."
  echo "   (To rotate: gcloud sql ssl client-certs delete $CERT_NAME --instance=$INSTANCE --project=$GCP_PROJECT, then re-run.)"
  exit 0
fi

# Private 0700 temp dir for all sensitive material; EXIT trap removes it on
# success or failure. gcloud requires the key path NOT to pre-exist.
TMP_DIR=$(mktemp -d)
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_KEY="$TMP_DIR/client.key"
TMP_CERT="$TMP_DIR/client.crt"

echo "🔐 Generating client cert '$CERT_NAME' on $INSTANCE..."
gcloud sql ssl client-certs create "$CERT_NAME" "$TMP_KEY" \
  --instance="$INSTANCE" \
  --project="$GCP_PROJECT"
chmod 600 "$TMP_KEY"

echo "📥 Fetching signed cert PEM..."
gcloud sql ssl client-certs describe "$CERT_NAME" \
  --instance="$INSTANCE" \
  --project="$GCP_PROJECT" \
  --format='value(cert)' > "$TMP_CERT"
chmod 600 "$TMP_CERT"

push_b64_secret() {
  local name="$1" src="$2" b64="$TMP_DIR/$1.b64"
  ( umask 077; base64 -i "$src" | tr -d '\n' > "$b64" )
  oasis rofl secret set "$name" --deployment "$ENV" "$b64"
}

echo "🛰️  Pushing POSTGRES_CLIENT_CERT / POSTGRES_CLIENT_KEY to deployment '$ENV' (base64)..."
push_b64_secret POSTGRES_CLIENT_CERT "$TMP_CERT"
push_b64_secret POSTGRES_CLIENT_KEY "$TMP_KEY"

echo "🛰️  Fetching POSTGRES_PASSWORD + server CA from Secret Manager and pushing..."
TMP_PW="$TMP_DIR/pw"
TMP_CA="$TMP_DIR/server-ca.crt"
( umask 077
  gcloud secrets versions access latest --secret=SENSE_AI_APP_SQL_PASSWORD --project="$GCP_PROJECT" > "$TMP_PW"
  gcloud secrets versions access latest --secret=SENSE_AI_APP_SQL_SERVER_CA_CERT --project="$GCP_PROJECT" > "$TMP_CA"
)
oasis rofl secret set POSTGRES_PASSWORD --deployment "$ENV" "$TMP_PW"
push_b64_secret POSTGRES_SERVER_CA_CERT "$TMP_CA"

# Stamp the Cloud SQL public IP into the env file (handles instance recreation).
PUBLIC_IP=$(gcloud sql instances describe "$INSTANCE" \
  --project="$GCP_PROJECT" \
  --format='value(ipAddresses[0].ipAddress)' 2>/dev/null)

if [ -z "$PUBLIC_IP" ]; then
  echo "⚠️  Could not fetch Cloud SQL public IP — leaving $ENV_FILE unchanged."
elif [ ! -f "$ENV_FILE" ]; then
  echo "⚠️  $ENV_FILE not found — add manually: POSTGRES_HOST=$PUBLIC_IP"
elif grep -q "^POSTGRES_HOST=" "$ENV_FILE"; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^POSTGRES_HOST=.*|POSTGRES_HOST=$PUBLIC_IP|" "$ENV_FILE"
  else
    sed -i "s|^POSTGRES_HOST=.*|POSTGRES_HOST=$PUBLIC_IP|" "$ENV_FILE"
  fi
  echo "📝 Stamped POSTGRES_HOST=$PUBLIC_IP in $ENV_FILE"
else
  echo "⚠️  $ENV_FILE has no POSTGRES_HOST line — add manually: POSTGRES_HOST=$PUBLIC_IP"
fi

echo ""
echo "✅ Done. Client cert valid ~10 years."
echo ""
echo "Next steps:"
echo "  1. bash scripts/rofl-set-secrets.sh $ENV       # sync the .env-driven secrets/config"
echo "  2. oasis rofl update --deployment $ENV          # commit manifest on-chain"
echo "  3. bun run rofl:deploy:$ENV                     # apply to the machine"
