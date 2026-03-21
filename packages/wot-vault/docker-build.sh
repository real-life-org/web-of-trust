#!/bin/bash
# Update wot-core-dist/ and build Docker image.
# Run this locally after wot-core changes, then commit wot-core-dist/.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$SCRIPT_DIR/../wot-core"

echo "Building wot-core..."
(cd "$CORE_DIR" && pnpm build)

echo "Updating wot-core-dist/..."
rm -rf "$SCRIPT_DIR/wot-core-dist"
mkdir -p "$SCRIPT_DIR/wot-core-dist/dist"
cp -r "$CORE_DIR/dist/"* "$SCRIPT_DIR/wot-core-dist/dist/"
cp "$CORE_DIR/package.json" "$SCRIPT_DIR/wot-core-dist/package.json"

echo "wot-core-dist/ updated. Commit it, then deploy."
echo "On the server: docker compose up -d --build"
