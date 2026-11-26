#!/bin/bash
set -euo pipefail # Stop at a failed command, a failed pipeline stage or an unset variable

# --- 0. VALIDATE INPUT ---
# The script now requires the path to the target mainnet compose file as an argument.
if [ -z "${1:-}" ]; then
  echo "Error: No compose file specified."
  echo "Usage: ./scripts/release-mainnet.sh <path_to_compose_file>"
  echo "Example: ./scripts/release-mainnet.sh compose.base-mainnet.yaml"
  exit 1
fi

COMPOSE_FILE=$1
IMAGE_BASE_NAME="ghcr.io/tradableapp/tokenized-ai-agent"

. "$(dirname "$0")/rofl-image-refs.sh"

# --- 1. SET VERSION ---
# Get and display the current version from rofl.yaml
# Nothing is written until both the current and the new version are known to be usable.
CURRENT_VERSION=$(awk '/^version:/ {print $2; exit}' rofl.yaml)
if [ -z "$CURRENT_VERSION" ]; then
  echo "❌ rofl.yaml has no 'version:' line. Aborting; nothing was changed."
  exit 1
fi
echo "Current ROFL version is: $CURRENT_VERSION"

# Prompt the user for the new version number
read -r -p "Enter the new mainnet version number for '$COMPOSE_FILE': " NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
  echo "No version entered. Aborting."
  exit 1
fi

# The version becomes the image tag and is written into both files, so it has to be one.
if ! rofl_is_tag "$NEW_VERSION"; then
  echo "❌ '$NEW_VERSION' is not a valid image tag (letters, digits, underscores, dots and dashes; not starting with a dot or dash). Aborting; nothing was changed."
  exit 1
fi

# Update rofl.yaml with the new version
# This portable syntax works on macOS and Linux
sed -i.bak "s/^version: .*/version: $NEW_VERSION/" rofl.yaml
rm rofl.yaml.bak
echo "✅ rofl.yaml updated to version: $NEW_VERSION"

# --- 2. PREPARE AND PUSH IMAGE ---
# Point the compose file at the new version tag. The regex finds the base image name and replaces
# the tag or digest after it (`:` or `@`) and everything that follows; step 3 then names the
# pushed image by its digest alone and records this version in the `# pinned from :<tag>` line
# above it. The '|' character is used as a delimiter to avoid issues with slashes '/' in the path.
echo "Updating '$COMPOSE_FILE' to the version tag..."
sed -i.bak "s|${IMAGE_BASE_NAME}[:@].*|${IMAGE_BASE_NAME}:${NEW_VERSION}|g" "$COMPOSE_FILE"
rm "${COMPOSE_FILE}.bak"

# Build and push the version-tagged Docker image
IMAGE_FULL_NAME="${IMAGE_BASE_NAME}:${NEW_VERSION}"
echo "Building mainnet image: $IMAGE_FULL_NAME..."
docker build --platform linux/amd64 -t "$IMAGE_FULL_NAME" -f Dockerfile.oracle .

echo "Pushing mainnet image..."
docker push "$IMAGE_FULL_NAME"

# --- 3. PIN THE PUSHED IMAGE BY DIGEST ---
# The ROFL bundle measures the compose file, and rofl-preflight.sh refuses to bundle one that names
# an image by tag alone. Write the digest of what was just pushed, read back from the registry.
echo "Pinning '$COMPOSE_FILE' to the digest of $IMAGE_FULL_NAME..."
if ! bash "$(dirname "$0")/pin-image-digest.sh" "$COMPOSE_FILE"; then
  echo "❌ $IMAGE_FULL_NAME was pushed, but its digest was not written to '$COMPOSE_FILE'."
  echo "   Run \`bash scripts/pin-image-digest.sh $COMPOSE_FILE\` once the registry answers;"
  echo "   until then the preflight refuses to bundle it."
  exit 1
fi

# --- 4. PROVIDE NEXT STEPS ---
echo ""
echo "✅ Success! Release assets are prepared for '$COMPOSE_FILE'."
echo ""
echo "Next Steps:"
echo "  1. Review the changes and commit the version bump and the pinned image:"
echo "     git add rofl.yaml $COMPOSE_FILE"
echo "     git commit -m \"chore: Release ROFL v$NEW_VERSION\""
echo ""
echo "  2. Manually run the final deployment steps for your target environment."
echo "     (e.g., for base mainnet, run 'bun run rofl:build:base-mainnet', etc.)"