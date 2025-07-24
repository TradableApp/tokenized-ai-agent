#!/bin/bash
set -e # Exit immediately if a command fails

# --- 1. SET VERSION ---
# Get and display the current version from rofl.yaml
CURRENT_VERSION=$(grep '^version:' rofl.yaml | awk '{print $2}')
echo "Current ROFL version is: $CURRENT_VERSION"

# Prompt the user for the new version number
read -p "Enter the new mainnet version number: " NEW_VERSION

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
# Define the mainnet compose file
COMPOSE_MAINNET="compose.mainnet.yaml"

# Ensure the placeholder in compose.mainnet.yaml is reverted, even if the script fails
trap 'git checkout -- $COMPOSE_MAINNET' EXIT

# Temporarily replace the ':mainnet-latest' placeholder with the new version tag
echo "Temporarily updating compose file for versioned build..."
sed -i.bak "s/:mainnet-latest/:$NEW_VERSION/g" $COMPOSE_MAINNET
rm "${COMPOSE_MAINNET}.bak"

# Build and push the version-tagged Docker image
echo "Building mainnet image: ghcr.io/tradableapp/tokenized-ai-agent:$NEW_VERSION..."
docker build -t "ghcr.io/tradableapp/tokenized-ai-agent:$NEW_VERSION" -f Dockerfile.oracle .

echo "Pushing mainnet image..."
docker push "ghcr.io/tradableapp/tokenized-ai-agent:$NEW_VERSION"

# The trap will automatically clean up the compose file now

# --- 3. PROVIDE NEXT STEPS ---
echo ""
echo "✅ Success! Release assets are prepared."
echo ""
echo "Next Steps:"
echo "  1. Review the changes and commit the version bump:"
echo "     git add rofl.yaml"
echo "     git commit -m \"chore: Release ROFL v$NEW_VERSION\""
echo ""
echo "  2. Manually run the final deployment steps:"
echo "     npm run rofl:build:mainnet"
echo "     npm run rofl:update:mainnet"
echo "     npm run rofl:deploy:mainnet"