#!/usr/bin/env bash
# Android build from a release tag for the v3 app (app-v3.* and later; app-v0/1/2 stay with
# scripts/release/build-android.sh and apps/demo). Called by .github/workflows/build-on-tag.yml, runs
# the same locally. Writes the artifact the signing service wot-release expects from the Gen-2 run, in
# the same format: out/release/ (repository root) with the unsigned AAB and APK, build-info.json and
# SHA256SUMS (`sha256sum ./*`); the workflow uploads it as android-<tag>.
#
# What it guarantees:
#   1. Exactly the given tag is built (HEAD carries it); versionName from the tag, versionCode
#      major*10000 + minor*100 + patch (3.0.0 -> 30000), passed to Gradle (-PwotVersionName).
#   2. Play web bundle (VITE_TARGET=play, live-update channel v3-android, VITE_MEDIATOR_DID required),
#      store-build check on the bundle and on the synced assets (scripts/check-build.mjs), and on the
#      AAB and the APK: the live-update plugin with the public key of the OTA signing key
#      (scripts/check-native-artifact.sh ota).
#   3. Unsigned (no signing config in android/app/build.gradle); the service signs the AAB with the
#      Play upload key and the APK with the F-Droid key (GitHub release and F-Droid index).
#      build-info.json: signed false, otaChannels.aab and .apk "v3-android", commit = the tag's commit.
#
# The APK is built from the same Play web bundle and reads the same channel v3-android, never the Gen-2
# channels (android-foss serves Gen-2 web bundles). Signed and published, this APK moves Gen-2 F-Droid
# and Obtainium users to v3 (the cutover); the app shows them the Gen-2 notice.
set -euo pipefail

APP_ID=org.reallife.weboftrust
TAG_PREFIX=app-v
GRADLE_TASKS=(bundleRelease assembleRelease)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$ROOT/apps/wot-v3"
AAB_OUT="$APP_DIR/android/app/build/outputs/bundle/release"
APK_OUT="$APP_DIR/android/app/build/outputs/apk/release"
OUT="$ROOT/out/release"

TAG="${1:-}"
abort() { echo "ABORT: $*" >&2; exit 1; }
[ -n "$TAG" ] || abort "usage: $0 <tag>   (e.g. ${TAG_PREFIX}3.0.0)"

echo "==> 1/6 tag and version"
WANT="${TAG#"$TAG_PREFIX"}"
[ "$WANT" != "$TAG" ] || abort "tag '$TAG' does not start with '$TAG_PREFIX'"
if [[ ! "$WANT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  abort "tag '$TAG': the version '$WANT' is not major.minor.patch"
fi
_MJ=$((10#${BASH_REMATCH[1]})); _MN=$((10#${BASH_REMATCH[2]})); _PT=$((10#${BASH_REMATCH[3]}))
[ "$_MJ" -ge 3 ] || abort "tag '$TAG' is a Gen-2 tag (major < 3): scripts/release/build-android.sh builds it from apps/demo"
if [ "$_MN" -ge 100 ] || [ "$_PT" -ge 100 ]; then abort "the versionCode formula needs minor/patch < 100: $WANT"; fi
VERSION_NAME="$WANT"
VERSION_CODE=$(( _MJ * 10000 + _MN * 100 + _PT ))
cd "$ROOT"
# -F: the tag is a literal, not a pattern
git tag --points-at HEAD | grep -qxF "$TAG" || abort "HEAD does not carry the tag '$TAG'. Check out the tag first."
echo "    ok: $TAG -> versionName $VERSION_NAME, versionCode $VERSION_CODE"

[ -n "${VITE_MEDIATOR_DID:-}" ] || abort "VITE_MEDIATOR_DID is not set (repository variable VITE_MEDIATOR_DID)"
export VITE_TARGET=play

echo "==> 2/6 dependencies (frozen lockfile)"
pnpm install --frozen-lockfile --filter wot-v3

echo "==> 3/6 Play web bundle (no live update) + store-build check"
( cd "$APP_DIR" && pnpm build:play )

echo "==> 4/6 cap sync android + store-build check on the synced assets"
( cd "$APP_DIR" && pnpm exec cap sync android )
( cd "$APP_DIR" && node scripts/check-build.mjs android/app/src/main/assets/public build-meta/module-graph.json )

echo "==> 5/6 ${GRADLE_TASKS[*]} (unsigned AAB and APK) + native artifact check"
rm -rf "$AAB_OUT" "$APK_OUT" "$OUT" && mkdir -p "$OUT"
( cd "$APP_DIR/android" && ./gradlew --no-daemon "-PwotVersionName=$VERSION_NAME" "${GRADLE_TASKS[@]}" )
shopt -s nullglob
AABS=("$AAB_OUT"/*.aab)
APKS=("$APK_OUT"/*.apk)
shopt -u nullglob
[ ${#AABS[@]} -eq 1 ] || abort "expected exactly one AAB in $AAB_OUT, found: ${AABS[*]:-none}"
[ ${#APKS[@]} -eq 1 ] || abort "expected exactly one APK in $APK_OUT, found: ${APKS[*]:-none}"
AAB="${AABS[0]}"
APK="${APKS[0]}"
for f in "$AAB" "$APK"; do
  if unzip -Z1 "$f" | grep -qiE '^META-INF/[^/]+\.(RSA|DSA|EC)$'; then abort "$f carries a signature; the release artifact must be unsigned"; fi
  "$APP_DIR/scripts/check-native-artifact.sh" "$f" ota
  cp "$f" "$OUT/"
done

echo "==> 6/6 build-info + checksums"
COMMIT=$(git rev-parse HEAD)
# the fields of the Gen-2 build-info (scripts/release/build-android.sh) the signing service checks:
# app, tag, commit, signed, otaChannels.<kind>, artifacts.<kind>; no time stamp (reproducible)
BI_APP="$APP_ID" BI_TAG="$TAG" BI_COMMIT="$COMMIT" \
BI_VNAME="$VERSION_NAME" BI_VCODE="$VERSION_CODE" BI_TASK="${GRADLE_TASKS[*]}" \
BI_AAB="$(basename "$AAB")" BI_APK="$(basename "$APK")" BI_MEDIATOR="$VITE_MEDIATOR_DID" \
BI_NODE="$(node --version)" BI_PNPM="$(pnpm --version)" BI_JAVA="$(java -version 2>&1 | head -1)" \
node -e '
const e = process.env;
require("fs").writeFileSync(process.argv[1], JSON.stringify({
  app: e.BI_APP, tag: e.BI_TAG, commit: e.BI_COMMIT,
  versionName: e.BI_VNAME, versionCode: Number(e.BI_VCODE),
  gradleTask: e.BI_TASK,
  artifacts: { aab: e.BI_AAB, apk: e.BI_APK },
  otaChannels: { aab: "v3-android", apk: "v3-android" },
  mediator: e.BI_MEDIATOR,
  toolchain: { node: e.BI_NODE, pnpm: e.BI_PNPM, java: e.BI_JAVA },
  signed: false,
  note: "v3 app (apps/wot-v3): AAB for Play and APK for GitHub and F-Droid, both on live-update channel v3-android (signed bundles only), unsigned. Signed separately (key custody)."
}, null, 2) + "\n");
' "$OUT/build-info.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$OUT/build-info.json"

( cd "$OUT" && sha256sum ./* > SHA256SUMS )

echo
echo "DONE: $OUT/"
ls -la "$OUT/"
