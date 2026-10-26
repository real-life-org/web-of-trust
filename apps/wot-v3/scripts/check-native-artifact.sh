#!/usr/bin/env bash
# Store-build check on the native artifact (architecture §8.2 step 3): whether the live-update (OTA)
# plugin is in an APK or AAB, in its code and in its Capacitor configuration.
#
# Usage: scripts/check-native-artifact.sh <file.apk|file.aab> <no-ota|ota>
#   no-ota (play, appstore, the debug APK): no class of io.capawesome.capacitorjs.plugins.liveupdate in
#           any dex, no LiveUpdate in assets/capacitor.config.json or assets/capacitor.plugins.json.
#   ota    (fdroid): the plugin is in the dex and in capacitor.plugins.json.
# Positive control in both cases: the app's own plugins and the Capacitor bridge are found in the same
# dex files, so a check that reads nothing cannot pass. apkanalyzer (Android SDK cmdline-tools) is used
# for an APK when it is on PATH or under $ANDROID_HOME; the dex strings are read in every case.
set -euo pipefail

FILE="${1:-}"
MODE="${2:-}"
abort() { echo "✗ $*" >&2; exit 1; }
[ -f "$FILE" ] || abort "usage: $0 <file.apk|file.aab> <no-ota|ota> (no file at '${FILE}')"
case "$MODE" in no-ota|ota) ;; *) abort "mode must be no-ota or ota (got '${MODE}')" ;; esac
command -v unzip >/dev/null || abort "unzip is needed"

case "$FILE" in
  *.apk) DEX_GLOB='classes*.dex'; PREFIX='' ;;
  *.aab) DEX_GLOB='base/dex/*.dex'; PREFIX='base/' ;;
  *) abort "not an .apk or .aab: $FILE" ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

unzip -qq -o "$FILE" "$DEX_GLOB" -d "$WORK/dex" 2>/dev/null || true
shopt -s nullglob globstar
DEXES=("$WORK"/dex/**/*.dex)
shopt -u nullglob globstar
[ ${#DEXES[@]} -gt 0 ] || abort "no dex files in $FILE"
# class names stand in the dex string table as Lpackage/Class;
cat "${DEXES[@]}" | LC_ALL=C grep -aoE 'L(io/capawesome/capacitorjs/plugins/liveupdate|org/reallife/weboftrust|com/getcapacitor)/[A-Za-z0-9_$/]+;' | sort -u > "$WORK/classes.txt" || true

CONFIG="$(unzip -p "$FILE" "${PREFIX}assets/capacitor.config.json" 2>/dev/null || true)"
PLUGINS="$(unzip -p "$FILE" "${PREFIX}assets/capacitor.plugins.json" 2>/dev/null || true)"
[ -n "$CONFIG" ] || abort "no ${PREFIX}assets/capacitor.config.json in $FILE"
[ -n "$PLUGINS" ] || abort "no ${PREFIX}assets/capacitor.plugins.json in $FILE"

# positive control
for own in 'Lcom/getcapacitor/BridgeActivity;' 'Lorg/reallife/weboftrust/BiometricKeystorePlugin;' 'Lorg/reallife/weboftrust/ScreenProtectionPlugin;' 'Lorg/reallife/weboftrust/AppSettingsPlugin;'; do
  grep -qxF "$own" "$WORK/classes.txt" || abort "positive control: $own not found in the dex files of $FILE"
done
grep -q 'CapacitorBarcodeScanner\|zxing' <<<"$PLUGINS" || abort "positive control: the scanner plugin is not in capacitor.plugins.json"

LU_CLASSES=$(grep -c '^Lio/capawesome/capacitorjs/plugins/liveupdate/' "$WORK/classes.txt" || true)
LU_CONFIG=$(grep -c '"LiveUpdate"' <<<"$CONFIG" || true)
LU_PLUGINS=$(grep -c 'liveupdate\|LiveUpdate' <<<"$PLUGINS" || true)

APKANALYZER=""
if [ "${FILE##*.}" = apk ]; then
  if command -v apkanalyzer >/dev/null; then APKANALYZER=apkanalyzer
  elif [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" ]; then APKANALYZER="$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer"
  fi
fi
LU_APKANALYZER="-"
if [ -n "$APKANALYZER" ]; then
  LU_APKANALYZER=$("$APKANALYZER" dex packages "$FILE" 2>/dev/null | grep -c 'io\.capawesome\.capacitorjs\.plugins\.liveupdate' || true)
fi

echo "- $(basename "$FILE"): $(wc -l < "$WORK/classes.txt") app/bridge classes read from ${#DEXES[@]} dex file(s)"
echo "- live-update classes in dex: $LU_CLASSES; apkanalyzer dex packages: $LU_APKANALYZER; LiveUpdate in capacitor.config.json: $LU_CONFIG; in capacitor.plugins.json: $LU_PLUGINS"

if [ "$MODE" = no-ota ]; then
  [ "$LU_CLASSES" = 0 ] || abort "live-update plugin classes in $FILE"
  [ "$LU_APKANALYZER" = "-" ] || [ "$LU_APKANALYZER" = 0 ] || abort "apkanalyzer finds the live-update package in $FILE"
  [ "$LU_CONFIG" = 0 ] || abort "LiveUpdate in the Capacitor configuration of $FILE"
  [ "$LU_PLUGINS" = 0 ] || abort "live-update plugin registered in $FILE"
  echo "✓ native artifact check passed: no live-update plugin in $(basename "$FILE")"
else
  [ "$LU_CLASSES" != 0 ] || abort "ota expected, but no live-update classes in $FILE"
  [ "$LU_PLUGINS" != 0 ] || abort "ota expected, but the live-update plugin is not registered in $FILE"
  echo "✓ native artifact check passed: live-update plugin present in $(basename "$FILE")"
fi
