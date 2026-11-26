#!/bin/bash
# Writes into a compose file the content digest of each image it names. A pinned image line is
#
#     # pinned from :<tag>
#     image: <name>@sha256:<digest>
#
# The digest stands alone on the image line, because the registry transport the ROFL runtime
# pulls through does not take a tag and a digest in one reference; the comment directly above
# records the tag the digest was read from, for whoever reads the file and for the next run.
# rofl-preflight.sh refuses to bundle a compose without a digest, because the ROFL bundle measures
# the compose file and a tag can later point at other content.
#
#   bash scripts/pin-image-digest.sh <compose-file>
#
# Run it after the image is pushed (`image:push:<env>` runs it; release-mainnet.sh runs it after
# its push), then commit the compose file.
#
# Which tag is looked up: the one on the image line when it has one (`<name>:<tag>`, as written
# before a first pin or by release-mainnet.sh), otherwise the one in `# pinned from :<tag>` on the
# line directly above. With neither it refuses. The comment is written, or rewritten, with the tag
# that was looked up, so a run after a new push writes the new digest and a run with nothing new
# pushed changes nothing. Every lookup is done before anything is written, and the file is
# replaced only when all of them gave a digest, so a failure leaves it as it was.
#
# The digest is read from the registry with `docker buildx imagetools inspect`, which needs no
# running Docker daemon. ROFL_IMAGE_DIGEST_CMD, when set, names a command used instead: it is given
# the reference (`<name>:<tag>`) and prints its digest as `sha256:<64 lower-case hex>`. ROFL_DOCKER
# names the docker CLI (default `docker`).
set -euo pipefail

COMPOSE_FILE="${1:?usage: pin-image-digest.sh <compose-file>}"
[ -f "$COMPOSE_FILE" ] || { echo "❌ Pin: '$COMPOSE_FILE' not found." >&2; exit 1; }

. "$(dirname "$0")/rofl-image-refs.sh"

DOCKER="${ROFL_DOCKER:-docker}"

lookup_with_buildx() {
  local ref="$1" json
  if ! command -v "$DOCKER" > /dev/null 2>&1 || ! "$DOCKER" buildx version > /dev/null 2>&1; then
    echo "❌ Pin: the digest is read with \`docker buildx imagetools inspect\`, and the docker CLI with" >&2
    echo "   buildx is not available here. Install it, or set ROFL_IMAGE_DIGEST_CMD to a command that" >&2
    echo "   prints the digest (sha256:<64 hex>) of the reference it is given." >&2
    return 1
  fi
  json="$("$DOCKER" buildx imagetools inspect "$ref" --format '{{json .Manifest}}')" || return 1
  # The top-level digest: that of the reference itself (an image index when the push made one), not
  # of a manifest listed inside it.
  printf '%s' "$json" | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      try {
        const digest = JSON.parse(text).digest;
        if (typeof digest === "string") process.stdout.write(digest);
      } catch {
        // Not JSON: nothing is printed, and the caller refuses the empty answer.
      }
    });
  '
}

lookup_digest() {
  if [ -n "${ROFL_IMAGE_DIGEST_CMD:-}" ]; then
    "$ROFL_IMAGE_DIGEST_CMD" "$1"
  else
    lookup_with_buildx "$1"
  fi
}

# Every image line, resolved before anything is written.
replacements=""
count=0
while IFS=$'\037' read -r line_no service ref recorded; do
  if [ -z "$service" ]; then
    echo "❌ Pin: '$COMPOSE_FILE' has no service under services:. Nothing was written." >&2
    exit 1
  fi
  if [ -z "$ref" ]; then
    echo "❌ Pin: service '$service' in '$COMPOSE_FILE' has no image: line. Nothing was written." >&2
    exit 1
  fi
  untagged="${ref%%@*}"
  if rofl_ref_has_tag "$untagged"; then
    tag="${untagged##*:}"
    name="${untagged%:*}"
  elif [ -n "$recorded" ] && [[ "$ref" == *@* ]]; then
    tag="$recorded"
    name="$untagged"
  else
    echo "❌ Pin: service '$service' in '$COMPOSE_FILE' names '$ref', with no tag to look up." >&2
    echo "   Name the pushed tag on the image line (<name>:<tag>), or keep the record of it on the line" >&2
    echo "   directly above a pinned image: # pinned from :<tag>. Nothing was written." >&2
    exit 1
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9._/:-]+$ ]] || ! rofl_is_tag "$tag"; then
    echo "❌ Pin: service '$service' in '$COMPOSE_FILE' gives no usable <name>:<tag> to look up ('$name', '$tag')." >&2
    echo "   A pinned image keeps its tag on the line directly above it: # pinned from :<tag>. Nothing was written." >&2
    exit 1
  fi
  tagged="${name}:${tag}"
  if ! answer="$(lookup_digest "$tagged")"; then
    echo "❌ Pin: could not read the digest of '$tagged' for service '$service'. Nothing was written." >&2
    exit 1
  fi
  answer="${answer//[[:space:]]/}"
  if [[ ! "$answer" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "❌ Pin: the lookup for '$tagged' answered something that is not a sha256 digest" >&2
    echo "   (sha256: and 64 lower-case hex). Nothing was written." >&2
    exit 1
  fi
  replacements+="${line_no}"$'\t'"${name}@${answer}"$'\t'"${tag}"$'\n'
  count=$((count + 1))
done < <(rofl_image_entries "$COMPOSE_FILE")

tmp="$(mktemp "${COMPOSE_FILE}.pin.XXXXXX")"
trap 'rm -f "$tmp" "$tmp.map"' EXIT
printf '%s' "$replacements" > "$tmp.map"
# Copied first so the replacement keeps the file's mode, then overwritten in place.
cp -p "$COMPOSE_FILE" "$tmp"
# One line is held back, so the record above an image line can be replaced rather than repeated.
awk -v map="$tmp.map" '
  function release_held() { if (have) print held; have = 0 }
  BEGIN {
    while ((getline entry < map) > 0) {
      split(entry, f, "\t")
      want[f[1]] = f[2]
      tag[f[1]] = f[3]
    }
  }
  (FNR in want) {
    line = $0; cr = ""
    if (line ~ /\r$/) { cr = "\r"; sub(/\r$/, "", line) }
    match(line, /^[[:space:]]*/)
    indent = substr(line, 1, RLENGTH)
    match(line, /^[[:space:]]*image:/)
    head = substr(line, 1, RLENGTH)
    rest = substr(line, RLENGTH + 1)
    comment = ""
    if (match(rest, /[[:space:]]+#.*$/)) comment = substr(rest, RSTART)
    if (have && held ~ /^[[:space:]]*# pinned from :/) have = 0
    release_held()
    print indent "# pinned from :" tag[FNR] cr
    print head " " want[FNR] comment cr
    next
  }
  { release_held(); held = $0; have = 1 }
  END { release_held() }
' "$COMPOSE_FILE" > "$tmp"

if cmp -s "$tmp" "$COMPOSE_FILE"; then
  echo "✅ Pin: '$COMPOSE_FILE' already names the pushed digest of its $count image(s); unchanged."
  exit 0
fi
mv "$tmp" "$COMPOSE_FILE"
echo "✅ Pin: '$COMPOSE_FILE' now names its $count image(s) by digest:"
while IFS=$'\t' read -r _ pinned from_tag; do
  [ -n "$pinned" ] && echo "   $pinned (from :$from_tag)"
done <<< "$replacements"
echo "   Commit the file; rofl:build bundles it."
