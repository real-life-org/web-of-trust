#!/bin/bash
# Build the Vault Docker image.
#
# Uses the repository root as the Docker build context so the Dockerfile can
# read @web_of_trust/core directly from packages/wot-core/ instead of a
# vendored generated bundle.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-wot-vault:local}"

echo "Building Docker image $IMAGE_TAG from $REPO_ROOT ..."
docker build \
  -f packages/wot-vault/Dockerfile \
  -t "$IMAGE_TAG" \
  "$REPO_ROOT"

echo "Done. To deploy on the server:"
echo "  cd $REPO_ROOT"
echo "  docker compose -f packages/wot-vault/docker-compose.yml up -d --build"
