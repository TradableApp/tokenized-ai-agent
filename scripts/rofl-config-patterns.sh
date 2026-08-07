# Shared config-validation patterns. Sourced by BOTH rofl-set-secrets.sh (which guards
# the .env -> compose step) and rofl-preflight.sh (which guards compose -> ORC bundle).
#
# They live here because the two scripts guard different pipeline stages but must agree
# on what "unusable config" means. Duplicating the regex meant the next person adding a
# pattern would update one and not the other — flagged in review of the PR that
# introduced the second copy.
#
# PLACEHOLDER: `ethers` does NOT reject a non-address string at construction; it treats
# it as an ENS name and defers resolution, so a placeholder boots healthy and fails
# asynchronously on every answer while the wallet pays gas.
ROFL_PLACEHOLDER_RE='0x[Yy]our|your_.*_here|YourAddressHere|ChangeMe|CHANGEME|<[a-z_]*>'

# Quoted values: docker-compose does not strip surrounding quotes, so KEY="MAX" reaches
# the container as the 5-character string "MAX" and an exact comparison takes the wrong
# branch. `mcp` is the one deliberate exception — emitted bare on purpose.
rofl_is_quoted() {
  case "$1" in
    '"'*'"'|"'"*"'") return 0 ;;
    *) return 1 ;;
  esac
}
