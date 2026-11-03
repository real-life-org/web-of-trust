#!/usr/bin/env bash
# Whether a deploy of the Pages site (.github/workflows/deploy.yml) publishes new Gen-2 OTA bundles.
# The site carries the landing, the Gen-2 demo, the benchmark and the v3 web app; the OTA bundles are
# the Gen-2 demo (apps/demo) for the native Gen-2 apps. A deploy whose commit changes none of the
# demo's inputs since the bundle that is LIVE publishes none, so a landing or v3 merge does not hand
# the Gen-2 apps an update without content.
#
# The comparison base is the commit of the live bundle: the bundleId in the live latest.json of every
# channel (a short commit id, set by deploy.yml), not the previous push. A cancelled or failed deploy
# leaves the live pointers where they were, so the next deploy still sees every change since.
#
# Usage: scripts/release/gen2-ota-needed.sh <event name> <commit to deploy>
#   OTA_POINTER_BASE: where the pointers live (default https://web-of-trust.de/updates; a file:// URL
#   in the test).
# Prints needed=true|false (for $GITHUB_OUTPUT) and the reason on stderr. On doubt (a dispatch, a
# missing or unreadable pointer, channels on different bundles, a bundle commit not in the clone) it
# says true: publishing is what the deploy did before. Tested by scripts/release/test-gen2-ota-needed.mjs.
set -euo pipefail

EVENT="${1:-}"
HEAD_COMMIT="${2:-}"
[ -n "$EVENT" ] && [ -n "$HEAD_COMMIT" ] || { echo "usage: $0 <event name> <commit to deploy>" >&2; exit 2; }
BASE="${OTA_POINTER_BASE:-https://web-of-trust.de/updates}"
CHANNELS=(ios android android-foss android-box)
# the inputs of the Gen-2 demo build: its sources, the packages it builds from source, and the files
# that decide its dependencies
INPUTS=(apps/demo packages/wot-core packages/adapter-yjs packages/adapter-automerge pnpm-lock.yaml package.json pnpm-workspace.yaml)

say() { echo "needed=$1"; echo "reason: $2" >&2; }

if [ "$EVENT" = workflow_dispatch ]; then say true "a dispatch (manual deploy or rollback)"; exit 0; fi

LIVE=""
for ch in "${CHANNELS[@]}"; do
  json="$(curl -fsS "$BASE/$ch/latest.json" 2>/dev/null)" || { say true "no live pointer for $ch"; exit 0; }
  id="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).bundleId;process.stdout.write(typeof v==="string"?v:"")}catch{}})')"
  [ -n "$id" ] || { say true "the live pointer of $ch names no bundleId"; exit 0; }
  if [ -z "$LIVE" ]; then LIVE="$id"; elif [ "$id" != "$LIVE" ]; then say true "the channels name different bundles ($LIVE, $id)"; exit 0; fi
done

[[ "$LIVE" =~ ^[0-9a-f]{7,40}$ ]] || { say true "the live bundleId '$LIVE' is no commit id"; exit 0; }
if ! LIVE_COMMIT="$(git rev-parse --verify --quiet "$LIVE^{commit}")"; then
  say true "the commit $LIVE of the live bundle is not in the clone"; exit 0
fi

if git diff --quiet "$LIVE_COMMIT" "$HEAD_COMMIT" -- "${INPUTS[@]}"; then
  say false "no change under ${INPUTS[*]} since the live bundle $LIVE"
else
  say true "a change under ${INPUTS[*]} since the live bundle $LIVE"
fi
