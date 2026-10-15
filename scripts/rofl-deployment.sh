#!/bin/bash
# rofl-deployment.sh — shared checks for scripts that take a ROFL deployment name.
# Sourced, not executed. The manifest (rofl.yaml) is the source of truth for which
# deployments exist, so a name is validated against it rather than a hard-coded list.

# require_deployment_in_manifest <deployment> [manifest]
# Fails fast when the deployment has no block in the manifest. Called before any
# side effect (cert minting, compose rewrite, secret push) so a typo in
# ROFL_DEPLOYMENT or a not-yet-created deployment cannot consume a Cloud SQL cert
# slot or rewrite config for a target the CLI will later reject.
require_deployment_in_manifest() {
  local deployment="$1" manifest="${2:-rofl.yaml}"
  if ! grep -qE "^  ${deployment}:[[:space:]]*$" "$manifest" 2>/dev/null; then
    echo "❌ Deployment '$deployment' is not in $manifest."
    echo "   Create it first (bun run rofl:create:<deployment>) or fix ROFL_DEPLOYMENT."
    return 1
  fi
}

# oasis_account_for_deployment <deployment>
# The CLI account that signs for a deployment, matching the package.json scripts.
oasis_account_for_deployment() {
  case "$1" in
    testnet|base-testnet) echo "oasis_testnet" ;;
    mainnet|base-mainnet) echo "oasis_mainnet" ;;
    *) echo "oasis_${1##*-}" ;;
  esac
}
