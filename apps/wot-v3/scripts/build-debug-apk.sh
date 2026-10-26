#!/usr/bin/env bash
# Debug APK of the v3 app for testing on a phone: the Play web bundle (VITE_TARGET=play, no live
# update, the mediator from VITE_MEDIATOR_DID) in the native shell android/, signed with Gradle's debug
# key, application id org.reallife.weboftrust.debug (installs next to the Gen-2 app).
#
# Usage (from anywhere): VITE_MEDIATOR_DID=did:… JAVA_HOME=<JDK 21> apps/wot-v3/scripts/build-debug-apk.sh
# Checks: store-build check on the web bundle and on the synced assets (scripts/check-build.mjs),
# native artifact check on the APK (scripts/check-native-artifact.sh no-ota).
# Prints the absolute path of the APK on the last line.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
abort() { echo "ABORT: $*" >&2; exit 1; }

[ -n "${VITE_MEDIATOR_DID:-}" ] || abort "VITE_MEDIATOR_DID is not set (the DID of the VTI mediator; never written to the repo)"
[ -n "${JAVA_HOME:-}" ] || abort "JAVA_HOME is not set (Capacitor 8 needs JDK 21)"
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
[ -n "${ANDROID_HOME:-}" ] || abort "ANDROID_HOME is not set"
export VITE_TARGET=play

echo "==> 1/5 web bundle (play) + store-build check"
pnpm build:play

echo "==> 2/5 cap sync android (play: no live-update plugin)"
pnpm exec cap sync android

echo "==> 3/5 store-build check on the synced assets"
node scripts/check-build.mjs android/app/src/main/assets/public build-meta/module-graph.json

echo "==> 4/5 gradlew assembleDebug"
OUT_DIR=android/app/build/outputs/apk/debug
rm -rf "$OUT_DIR"
( cd android && ./gradlew --no-daemon assembleDebug )
APK="$APP_DIR/$OUT_DIR/app-debug.apk"
[ -f "$APK" ] || abort "no APK at $APK"

echo "==> 5/5 native artifact check (no live update)"
scripts/check-native-artifact.sh "$APK" no-ota

echo "size: $(du -h "$APK" | cut -f1) ($(stat -c %s "$APK") bytes)"
echo "install: adb install -r $APK"
echo "$APK"
