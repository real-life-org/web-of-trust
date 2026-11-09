#!/usr/bin/env bash
# Store-build check on the native artifact (architecture §8.2 step 3): whether the live-update (OTA)
# plugin is in an APK, AAB, IPA or .app bundle, in its code and in its Capacitor configuration.
#
# Usage: scripts/check-native-artifact.sh <file.apk|file.aab|file.ipa|Name.app> <no-ota|ota>
#   no-ota (play, appstore, the debug APK): no class of io.capawesome.capacitorjs.plugins.liveupdate in
#           any dex, no LiveUpdate in assets/capacitor.config.json or assets/capacitor.plugins.json.
#           iOS: no LiveUpdatePlugin / CapawesomeCapacitorLiveUpdate in the executable, no LiveUpdate in
#           capacitor.config.json (plugins or packageClassList, the iOS plugin registry); the bundle
#           carries PrivacyInfo.xcprivacy with the file-timestamp reason of the filesystem plugin.
#   ota    (every v3 release build): the plugin is in the dex and in capacitor.plugins.json (Android), or
#           LiveUpdatePlugin is in the executable and in packageClassList (iOS); in both the Capacitor
#           configuration carries LiveUpdate with a readyTimeout and WITHOUT a publicKey: with one set the
#           plugin checks only the zip's signature and skips the checksum, which binds the zip to the
#           envelope the app verified (web-of-trust#526).
# Positive control in both cases: the app's own plugins and the Capacitor bridge are found in the same
# dex files or the same executable, so a check that reads nothing cannot pass. apkanalyzer (Android SDK
# cmdline-tools) is used for an APK when it is on PATH or under $ANDROID_HOME; the dex strings are read
# in every case. An IPA is read from Payload/<Name>.app, an .app directory (the unsigned archive's
# Products/Applications/<Name>.app) directly; the executable is the file named like the bundle.
set -euo pipefail

FILE="${1:-}"
MODE="${2:-}"
abort() { echo "✗ $*" >&2; exit 1; }
[ -e "$FILE" ] || abort "usage: $0 <file.apk|file.aab|file.ipa|Name.app> <no-ota|ota> (nothing at '${FILE}')"
case "$MODE" in no-ota|ota) ;; *) abort "mode must be no-ota or ota (got '${MODE}')" ;; esac
command -v unzip >/dev/null || abort "unzip is needed"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# the LiveUpdate configuration of an ota build: a readyTimeout (rollback) and no publicKey (#526)
ota_config() {
  grep -q '"readyTimeout"' <<<"$1" || abort "ota expected, but the LiveUpdate configuration of $2 has no readyTimeout (a broken bundle would never roll back)"
  if grep -q '"publicKey"' <<<"$1"; then
    abort "ota expected, but the LiveUpdate configuration of $2 names a publicKey (the plugin would skip the checksum from the signed envelope)"
  fi
}

# ---- iOS: IPA or .app bundle ------------------------------------------------------------------------
check_ios_bundle() {
  local app="$1"   # path of the .app directory
  local name; name="$(basename "$app" .app)"
  local exe="$app/$name"
  [ -f "$exe" ] || abort "no executable $name in $(basename "$app") (the executable is named like the bundle)"
  local config; config="$(cat "$app/capacitor.config.json" 2>/dev/null || true)"
  [ -n "$config" ] || abort "no capacitor.config.json in $(basename "$app")"
  # the app's privacy manifest (required-reason APIs of the filesystem plugin and the bridge)
  [ -f "$app/PrivacyInfo.xcprivacy" ] || abort "no PrivacyInfo.xcprivacy in $(basename "$app") (ios/App/App/PrivacyInfo.xcprivacy must be a resource of the target)"
  # the file-timestamp category with the reason C617.1 in the same entry (@capacitor/filesystem); an
  # entry that names the category without the reason is refused like a missing one
  node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8");
const entries = s.split(/<dict>/).slice(1).map((d) => d.split(/<\/dict>/)[0]);
const ts = entries.filter((d) => d.includes("<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>"));
if (ts.length === 0) { console.error("category"); process.exit(1) }
if (!ts.some((d) => /<key>NSPrivacyAccessedAPITypeReasons<\/key>[ \t\r\n]*<array>[^]*<string>C617\.1<\/string>/.test(d))) { console.error("reason"); process.exit(2) }
' "$app/PrivacyInfo.xcprivacy" 2>/dev/null || case $? in
    1) abort "PrivacyInfo.xcprivacy in $(basename "$app") does not declare NSPrivacyAccessedAPICategoryFileTimestamp (@capacitor/filesystem)" ;;
    *) abort "PrivacyInfo.xcprivacy in $(basename "$app") declares NSPrivacyAccessedAPICategoryFileTimestamp without the reason C617.1" ;;
  esac

  # ObjC class names and Swift module names stand in the executable as strings (statically linked SPM products)
  LC_ALL=C grep -aoE '(CAPBridgeViewController|BiometricKeystorePlugin|ScreenProtectionPlugin|AppSettingsPlugin|CapacitorBarcodeScannerPlugin|LiveUpdatePlugin|CapawesomeCapacitorLiveUpdate)' "$exe" | sort -u > "$WORK/classes.txt" || true

  # positive control: the bridge, the app's own plugins and the scanner, in the executable and in the registry
  for own in CAPBridgeViewController BiometricKeystorePlugin ScreenProtectionPlugin AppSettingsPlugin CapacitorBarcodeScannerPlugin; do
    grep -qxF "$own" "$WORK/classes.txt" || abort "positive control: $own not found in the executable of $(basename "$app")"
  done
  grep -q '"CapacitorBarcodeScannerPlugin"' <<<"$config" || abort "positive control: the scanner plugin is not in packageClassList of capacitor.config.json"

  local lu_classes lu_config
  lu_classes=$(grep -cE '^(LiveUpdatePlugin|CapawesomeCapacitorLiveUpdate)$' "$WORK/classes.txt" || true)
  lu_config=$(grep -c 'LiveUpdate' <<<"$config" || true)

  echo "- $(basename "$app"): $(wc -l < "$WORK/classes.txt") bridge/plugin classes read from the executable $name"
  echo "- live-update classes in the executable: $lu_classes; LiveUpdate in capacitor.config.json (plugins, packageClassList): $lu_config"
  if [ "$MODE" = no-ota ]; then
    [ "$lu_classes" = 0 ] || abort "live-update plugin classes in $(basename "$app")"
    [ "$lu_config" = 0 ] || abort "LiveUpdate in the Capacitor configuration of $(basename "$app")"
    echo "✓ native artifact check passed: no live-update plugin in $(basename "$1")"
  else
    [ "$lu_classes" != 0 ] || abort "ota expected, but no live-update classes in the executable of $(basename "$app")"
    grep -q '"LiveUpdatePlugin"' <<<"$config" || abort "ota expected, but LiveUpdatePlugin is not in packageClassList of $(basename "$app")"
    ota_config "$config" "$(basename "$app")"
    echo "✓ native artifact check passed: live-update plugin, checksum-bound, in $(basename "$1")"
  fi
}

case "$FILE" in
  *.ipa|*.app)
    if [ -d "$FILE" ]; then
      check_ios_bundle "$FILE"
    else
      unzip -qq -o "$FILE" 'Payload/*' -d "$WORK/ipa" 2>/dev/null || abort "no Payload/ in $FILE"
      shopt -s nullglob
      APPS=("$WORK"/ipa/Payload/*.app)
      shopt -u nullglob
      [ ${#APPS[@]} -eq 1 ] || abort "expected exactly one .app in Payload/ of $FILE, found: ${#APPS[@]}"
      check_ios_bundle "${APPS[0]}"
    fi
    exit 0
    ;;
esac

# ---- Android: APK or AAB ----------------------------------------------------------------------------
case "$FILE" in
  *.apk) DEX_GLOB='classes*.dex'; PREFIX='' ;;
  *.aab) DEX_GLOB='base/dex/*.dex'; PREFIX='base/' ;;
  *) abort "not an .apk, .aab, .ipa or .app: $FILE" ;;
esac

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
  ota_config "$CONFIG" "$FILE"
  echo "✓ native artifact check passed: live-update plugin, checksum-bound, in $(basename "$FILE")"
fi
