#!/usr/bin/env bash
# Whether a deploy of the Pages site (.github/workflows/deploy.yml) publishes new Gen-2 OTA bundles.
# The site carries the landing, the Gen-2 demo, the benchmark and the v3 web app; the OTA bundles are
# the Gen-2 demo (apps/demo) for the native Gen-2 apps. A push that changes none of the demo's inputs
# publishes none, so a landing or v3 merge does not hand the Gen-2 apps an update without content.
#
# Usage: scripts/release/gen2-ota-needed.sh <event name> <previous commit> <commit>
# Prints needed=true|false (for $GITHUB_OUTPUT) and the reason. On doubt (a dispatch, no previous
# commit, a previous commit not in the clone) it says true: publishing is what the deploy did before.
# Tested by scripts/release/test-gen2-ota-needed.mjs.
set -euo pipefail

EVENT="${1:-}"
BEFORE="${2:-}"
AFTER="${3:-}"
[ -n "$EVENT" ] || { echo "usage: $0 <event name> <previous commit> <commit>" >&2; exit 2; }

# the inputs of the Gen-2 demo build (the paths deploy.yml ran on before the v3 app)
INPUTS=(apps/demo packages/wot-core packages/adapter-yjs packages/adapter-automerge)

say() { echo "needed=$1"; echo "reason: $2" >&2; }

if [ "$EVENT" = workflow_dispatch ]; then say true "a dispatch (manual deploy or rollback)"; exit 0; fi
if [ -z "$BEFORE" ] || [[ "$BEFORE" =~ ^0+$ ]]; then say true "no previous commit"; exit 0; fi
if ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then say true "the previous commit $BEFORE is not in the clone"; exit 0; fi

if git diff --quiet "$BEFORE" "$AFTER" -- "${INPUTS[@]}"; then
  say false "no change under ${INPUTS[*]} since $BEFORE"
else
  say true "a change under ${INPUTS[*]} since $BEFORE"
fi
