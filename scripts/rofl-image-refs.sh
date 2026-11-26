# shellcheck shell=bash
# How a compose file names its images. Sourced by rofl-preflight.sh (which refuses to bundle a
# compose whose image is not pinned) and pin-image-digest.sh (which writes the pin), so the two
# agree on what an image line is and what a pin looks like.
#
# The ROFL bundle measures compose.yaml, not the image it names. A tag can be pointed at other
# content after the bundle is built; a digest cannot. So the enclave identity fixes which oracle
# code runs only when every image is named as <name>[:<tag>]@sha256:<64 lower-case hex>.
# `oasis rofl build` does not resolve a digest itself.

# Prints one line per service, tab-separated: the line number of its `image:` (0 when it has
# none), the service name, and the image reference with any quotes and trailing comment removed
# (empty when it has none). A file with no service under `services:` gives one line `0<TAB><TAB>`,
# so a caller that refuses empty fields fails closed on it.
#
# It reads the YAML layout compose files use: `services:` at the left margin, each service one
# indent in, its keys one indent further. An `image:` deeper than that (inside another key) is not
# the service's image.
rofl_image_entries() {
  awk '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    function flush() { if (svc != "" && !seen) printf "0\t%s\t\n", svc }
    { sub(/\r$/, "") }
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
        printf "%d\t%s\t%s\n", NR, svc, v
        seen = 1
      }
    }
    END {
      if (in_services) flush()
      if (!services) printf "0\t\t\n"
    }
  ' "$1"
}

# True when the reference is pinned: a name with no space or `@`, then `@sha256:` and exactly 64
# lower-case hex characters, and nothing after them.
rofl_is_pinned_ref() {
  local ref="$1" name digest
  [[ "$ref" == *@sha256:* ]] || return 1
  name="${ref%@sha256:*}"
  digest="${ref##*@sha256:}"
  [ -n "$name" ] || return 1
  [[ "$name" != *[[:space:]@]* ]] || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
}

# Prints one line per service that is not pinned: the service (empty when the file has none), the
# unit separator (\037, not a tab: a tab is whitespace to `read`, so an empty first field would
# vanish) and why. Prints nothing when every service's image is pinned.
rofl_unpinned_images() {
  local service ref
  while IFS=$'\t' read -r _ service ref; do
    if [ -z "$service" ]; then
      printf '\037no service found under services:\n'
    elif [ -z "$ref" ]; then
      printf '%s\037has no image: line\n' "$service"
    elif ! rofl_is_pinned_ref "$ref"; then
      printf '%s\037names %s, which is not <name>:<tag>@sha256:<64 lower-case hex>\n' "$service" "$ref"
    fi
  done < <(rofl_image_entries "$1")
}
