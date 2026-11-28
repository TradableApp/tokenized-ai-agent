# shellcheck shell=bash
# How a compose file names its images. Sourced by rofl-preflight.sh (which refuses to bundle a
# compose whose image is not pinned) and pin-image-digest.sh (which writes the pin), so the two
# agree on what an image line is and what a pin looks like.
#
# The ROFL bundle measures compose.yaml, not the image it names. A tag can be pointed at other
# content after the bundle is built; a digest cannot. So the enclave identity fixes which oracle
# code runs only when every image is named as <name>@sha256:<64 lower-case hex>. The digest stands
# alone: the registry transport the ROFL runtime pulls through (containers/image, under Podman)
# does not take a tag and a digest in one reference. The tag the digest was read from is kept in a
# comment directly above the image line, `# pinned from :<tag>`, for the reader and for the next
# pin. `oasis rofl build` does not resolve a digest itself.

# Prints one line per service, its fields separated by the unit separator (\037; a tab is
# whitespace to `read`, so an empty field would vanish and shift the rest): the line number of its
# `image:` (0 when it has none), the service name, the image reference with any quotes and
# trailing comment removed (empty when it has none), and the tag recorded on the line directly
# above as `# pinned from :<tag>` (empty when that line is anything else). A file with no service
# under `services:` gives one line with the number 0 and every other field empty, so a caller that
# refuses empty fields fails closed on it.
#
# It reads the YAML layout compose files use: `services:` at the left margin, each service one
# indent in, its keys one indent further. An `image:` deeper than that (inside another key) is not
# the service's image.
rofl_image_entries() {
  awk '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    function flush() { if (svc != "" && !seen) printf "0\037%s\037\037\n", svc }
    { sub(/\r$/, ""); above = here; here = $0 }
    /^[[:space:]]*(#.*)?$/ { next }
    {
      match($0, /^ */); ind = RLENGTH
      if (ind == 0) {
        if (in_services) flush()
        in_services = ($0 ~ /^services:[[:space:]]*(#.*)?$/)
        svc = ""; svc_ind = 0; key_ind = 0
        next
      }
      if (!in_services) next
      if (svc_ind == 0) svc_ind = ind
      if (ind < svc_ind) next
      if (ind == svc_ind) {
        flush()
        svc = trim($0); sub(/:.*$/, "", svc); gsub(/["'\'']/, "", svc)
        seen = 0; key_ind = 0; services++
        next
      }
      if (key_ind == 0) key_ind = ind
      if (ind == key_ind && $0 ~ /^[[:space:]]*image:/) {
        v = $0
        sub(/^[[:space:]]*image:/, "", v)
        sub(/[[:space:]]+#.*$/, "", v)
        v = trim(v)
        if (length(v) >= 2 && (v ~ /^".*"$/ || v ~ /^'\''.*'\''$/)) v = substr(v, 2, length(v) - 2)
        recorded = ""
        if (above ~ /^[[:space:]]*# pinned from :/) {
          recorded = above
          sub(/^[[:space:]]*# pinned from :/, "", recorded)
          recorded = trim(recorded)
        }
        printf "%d\037%s\037%s\037%s\n", NR, svc, v, recorded
        seen = 1
      }
    }
    END {
      if (in_services) flush()
      if (!services) printf "0\037\037\037\n"
    }
  ' "$1"
}

# True when the reference names a tag: a `:` after its last `/` (a registry host may carry a
# port, `host:5000/name`, so a `:` before the last `/` is not one).
rofl_ref_has_tag() {
  local name="${1%%@*}"
  [[ "${name##*/}" == *:* ]]
}

# True when the reference is pinned: a name with no space, `@` or tag, then `@sha256:` and exactly
# 64 lower-case hex characters, and nothing after them.
rofl_is_pinned_ref() {
  local ref="$1" name digest
  [[ "$ref" == *@sha256:* ]] || return 1
  name="${ref%@sha256:*}"
  digest="${ref##*@sha256:}"
  [ -n "$name" ] || return 1
  [[ "$name" != *[[:space:]@]* ]] || return 1
  ! rofl_ref_has_tag "$name" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
}

# True when the text is a tag as registries take it: a word character, then up to 127 word
# characters, dots and dashes.
rofl_is_tag() {
  [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]
}

# Prints one line per service that is not pinned: the service (empty when the file has none), the
# unit separator and why; exits 1 when it printed any. Prints nothing and exits 0 only when every
# service's image is pinned.
#
# Fails closed: the entries are captured before they are read, so a reader that fails (an
# unreadable file, awk exiting early) is a refusal, and so is no output at all. Read through a
# process substitution instead, such a failure would run the loop zero times and print nothing,
# which is what "every image is pinned" looks like.
rofl_unpinned_images() {
  local entries service ref status=0
  if ! entries="$(rofl_image_entries "$1")" || [ -z "$entries" ]; then
    printf '\037could not read the image entries of %s\n' "$1"
    return 1
  fi
  while IFS=$'\037' read -r _ service ref _; do
    if [ -z "$service" ]; then
      printf '\037no service found under services:\n'; status=1
    elif [ -z "$ref" ]; then
      printf '%s\037has no image: line\n' "$service"; status=1
    elif ! rofl_is_pinned_ref "$ref" && [[ "$ref" == *@* ]] && rofl_ref_has_tag "$ref"; then
      printf '%s\037names %s, which carries a tag and a digest; the registry transport takes one, so write <name>@sha256:<64 lower-case hex> and keep the tag in "# pinned from :<tag>" on the line above\n' "$service" "$ref"; status=1
    elif ! rofl_is_pinned_ref "$ref"; then
      printf '%s\037names %s, which is not <name>@sha256:<64 lower-case hex>\n' "$service" "$ref"; status=1
    fi
  done <<< "$entries"
  return "$status"
}

# Run as a program rather than sourced: `bash scripts/rofl-image-refs.sh --unpinned <compose-file>`
# prints what rofl_unpinned_images prints and exits with its status.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [ "${1:-}" = "--unpinned" ] && [ -n "${2:-}" ]; then
    rofl_unpinned_images "$2"
    exit $?
  fi
  echo "usage: rofl-image-refs.sh --unpinned <compose-file>" >&2
  exit 2
fi
