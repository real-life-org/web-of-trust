#!/usr/bin/env bash
# Live-update bundles of the v3 app from an OTA tag (ota-v3-<n>). Called by .github/workflows/ota-v3.yml,
# runs the same locally. Writes out/ota/ (repository root): one zip per channel, build-info.json and
# SHA256SUMS (`sha256sum ./*`); the workflow uploads it as ota-<tag>. The signing service wot-release
# signs each zip with the OTA key, publishes the zips and the signed manifests as the GitHub release
# <tag>, and the Pages deploy serves the manifests under web-of-trust.de/updates/<channel>/latest.json.
#
# What it guarantees:
#   1. Exactly the given tag is built (HEAD carries it).
#   2. Each channel is the web bundle of its native target, as the store builds make it:
#        v3-android: VITE_TARGET=play (the Play AAB and the APK read this channel)
#        v3-ios:     VITE_TARGET=appstore
#      with VITE_MEDIATOR_DID, each through the store-build check (scripts/check-build.mjs).
#   3. minNative: the version of the newest app-v3.* tag in the history of this commit, the oldest shell
#      the bundle runs on. A bundle may use native code up to that release and nothing after it; a
#      change to the native shell needs a store release (app-v3.*) before an OTA tag that relies on it.
#   4. Unsigned: build-info.json says signed false; the zips carry no signature.
set -euo pipefail

TAG_PREFIX=ota-v3-
APP_ID=org.reallife.weboftrust
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$ROOT/apps/wot-v3"
OUT="$ROOT/out/ota"

TAG="${1:-}"
abort() { echo "ABORT: $*" >&2; exit 1; }
[ -n "$TAG" ] || abort "usage: $0 <tag>   (e.g. ${TAG_PREFIX}1)"
[[ "$TAG" =~ ^ota-v3-[0-9]+$ ]] || abort "tag '$TAG' is not ${TAG_PREFIX}<number>"
cd "$ROOT"

echo "==> 1/4 tag, commit, shell version"
git tag --points-at HEAD | grep -qxF "$TAG" || abort "HEAD does not carry the tag '$TAG'. Check out the tag first."
NATIVE_TAG=$(git tag --merged HEAD --list 'app-v3.*' | sort -V | tail -1)
[ -n "$NATIVE_TAG" ] || abort "no app-v3.* tag in the history of $TAG: no shell to run the bundle on"
MIN_NATIVE="${NATIVE_TAG#app-v}"
[[ "$MIN_NATIVE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || abort "the newest native tag '$NATIVE_TAG' is not app-v<major.minor.patch>"
[ -n "${VITE_MEDIATOR_DID:-}" ] || abort "VITE_MEDIATOR_DID is not set (repository variable VITE_MEDIATOR_DID)"
echo "    ok: $TAG on $(git rev-parse --short HEAD), runs on shells from $MIN_NATIVE ($NATIVE_TAG)"

echo "==> 2/4 dependencies (frozen lockfile)"
pnpm install --frozen-lockfile --filter wot-v3

echo "==> 3/4 web bundles + store-build check"
rm -rf "$OUT" && mkdir -p "$OUT"
declare -A TARGET_OF=([v3-android]=play [v3-ios]=appstore)
for channel in v3-android v3-ios; do
  target="${TARGET_OF[$channel]}"
  ( cd "$APP_DIR" && pnpm "build:$target" )
  # the bundle names its own channel: a v3-ios bundle never asks the v3-android manifest
  grep -rqF "$channel" "$APP_DIR/dist-$target/assets" || abort "the $target bundle does not name its channel $channel"
  ( cd "$APP_DIR/dist-$target" && zip -qrX "$OUT/$channel.zip" . )
done

echo "==> 4/4 build-info + checksums"
BI_APP="$APP_ID" BI_TAG="$TAG" BI_COMMIT="$(git rev-parse HEAD)" BI_MIN="$MIN_NATIVE" \
BI_MEDIATOR="$VITE_MEDIATOR_DID" BI_NODE="$(node --version)" BI_PNPM="$(pnpm --version)" \
node -e '
const e = process.env;
require("fs").writeFileSync(process.argv[1], JSON.stringify({
  app: e.BI_APP, tag: e.BI_TAG, commit: e.BI_COMMIT,
  kind: "ota",
  minNative: e.BI_MIN,
  bundles: { "v3-android": "v3-android.zip", "v3-ios": "v3-ios.zip" },
  mediator: e.BI_MEDIATOR,
  toolchain: { node: e.BI_NODE, pnpm: e.BI_PNPM },
  signed: false,
  note: "v3 live-update bundles, unsigned. The signing service signs each zip with the OTA key (RSA, PKCS#1 v1.5 over SHA-256) and publishes the manifests."
}, null, 2) + "\n");
' "$OUT/build-info.json"
( cd "$OUT" && sha256sum ./* > SHA256SUMS )

echo
echo "DONE: $OUT/"
ls -la "$OUT/"
