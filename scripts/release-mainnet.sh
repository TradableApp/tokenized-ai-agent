#!/bin/bash
set -e # Exit immediately if a command fails

# --- 0. VALIDATE INPUT ---
# The script now requires the path to the target mainnet compose file as an argument.
if [ -z "$1" ]; then
  echo "Error: No compose file specified."
  echo "Usage: ./scripts/release-mainnet.sh <path_to_compose_file>"
  echo "Example: ./scripts/release-mainnet.sh compose.base-mainnet.yaml"
  exit 1
fi

COMPOSE_FILE=$1
IMAGE_BASE_NAME="ghcr.io/tradableapp/tokenized-ai-agent"

# --- 1. SET VERSION ---
# Get and display the current version from rofl.yaml
CURRENT_VERSION=$(grep '^version:' rofl.yaml | awk '{print $2}')
echo "Current ROFL version is: $CURRENT_VERSION"

# Prompt the user for the new version number
read -p "Enter the new mainnet version number for '$COMPOSE_FILE': " NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
  echo "No version entered. Aborting."
  exit 1
fi

# Update rofl.yaml with the new version
# This portable syntax works on macOS and Linux
sed -i.bak "s/^version: .*/version: $NEW_VERSION/" rofl.yaml
rm rofl.yaml.bak
echo "✅ rofl.yaml updated to version: $NEW_VERSION"

# --- 2. PREPARE AND PUSH IMAGE ---
# Ensure the placeholder in the target compose file is always reverted, even if the script fails.
trap 'git checkout -- $COMPOSE_FILE' EXIT

# Temporarily replace the image tag in the compose file with the new version tag.
# This regex finds the base image name and replaces the colon and everything after it.
# The '|' character is used as a delimiter to avoid issues with slashes '/' in the path.
echo "Temporarily updating '$COMPOSE_FILE' for versioned build..."
sed -i.bak "s|$IMAGE_BASE_NAME:.*|$IMAGE_BASE_NAME:$NEW_VERSION|g" "$COMPOSE_FILE"
rm "${COMPOSE_FILE}.bak"

# Build and push the version-tagged Docker image
IMAGE_FULL_NAME="${IMAGE_BASE_NAME}:${NEW_VERSION}"
echo "Building mainnet image: $IMAGE_FULL_NAME..."
docker build --platform linux/amd64 -t "$IMAGE_FULL_NAME" -f Dockerfile.oracle .

echo "Pushing mainnet image..."
docker push "$IMAGE_FULL_NAME"

# The trap will automatically clean up the compose file now by reverting any changes.
echo "✅ Compose file reverted to its original state."

# --- 3. PROVIDE NEXT STEPS ---
echo ""
echo "✅ Success! Release assets are prepared for '$COMPOSE_FILE'."
echo ""
echo "Next Steps:"
echo "  1. Review the changes and commit the version bump:"
echo "     git add rofl.yaml"
echo "     git commit -m \"chore: Release ROFL v$NEW_VERSION\""
echo ""
echo "  2. Manually run the final deployment steps for your target environment."
echo "     (e.g., for base mainnet, run 'npm run rofl:build:base-mainnet', etc.)"