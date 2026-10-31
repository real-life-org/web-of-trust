#!/usr/bin/env bash
# iOS build from a release tag for the v3 app (app-v3.* and later), the counterpart of
# scripts/build-android.sh. Called by the job `ios` of .github/workflows/build-on-tag.yml on a macOS
# runner; runs the same on a Mac with Xcode. Writes out/release-ios/ (repository root): the signed IPA
# (or, without signing secrets, the unsigned archive as a zip), build-info.json and SHA256SUMS; the
# workflow uploads it as ios-<tag> and hands the IPA to scripts/upload-testflight.sh.
#
# What it guarantees:
#   1. Exactly the given tag is built (HEAD carries it); MARKETING_VERSION from the tag, CURRENT_PROJECT_VERSION
#      (the build number) major*10000 + minor*100 + patch, the versionCode formula of the Android shell
#      (scripts/version-from-tag.sh), passed to xcodebuild as build settings.
#   2. App Store web bundle (VITE_TARGET=appstore: no live update, VITE_MEDIATOR_DID required), store-build
#      check on the bundle and on the synced assets (scripts/check-build.mjs), every plugin of
#      capacitor.config.ts in the generated Swift package, and on the IPA or the archived .app: no
#      live-update plugin in the executable or the configuration (scripts/check-native-artifact.sh no-ota).
#   3. Signing only with the secrets of the workflow (deploy/ios/README.md): IOS_TEAM_ID,
#      IOS_DIST_CERT_P12_BASE64, IOS_DIST_CERT_PASSWORD, IOS_PROVISIONING_PROFILE_BASE64. They live in a
#      temporary keychain for this run and are removed at the end. Without them the archive is built
#      unsigned (CODE_SIGNING_ALLOWED=NO) and shipped as App-unsigned.xcarchive.zip, so the first run on a
#      tag passes without any key material; build-info.json says signed false.
#
# Not here: the upload (scripts/upload-testflight.sh), the App Store Connect record, TestFlight groups.
set -euo pipefail

APP_ID=org.reallife.weboftrust
SCHEME=App

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$ROOT/apps/wot-v3"
IOS_DIR="$APP_DIR/ios/App"
OUT="$ROOT/out/release-ios"
WORK="$ROOT/out/ios-work"

TAG="${1:-}"
abort() { echo "ABORT: $*" >&2; exit 1; }
[ -n "$TAG" ] || abort "usage: $0 <tag>   (e.g. app-v3.0.0)"

echo "==> 1/7 tag and version"
eval "$("$APP_DIR/scripts/version-from-tag.sh" "$TAG")"
cd "$ROOT"
git tag --points-at HEAD | grep -qxF "$TAG" || abort "HEAD does not carry the tag '$TAG'. Check out the tag first."
echo "    ok: $TAG -> MARKETING_VERSION $VERSION_NAME, CURRENT_PROJECT_VERSION $BUILD_NUMBER"
[ -n "${VITE_MEDIATOR_DID:-}" ] || abort "VITE_MEDIATOR_DID is not set (repository variable VITE_MEDIATOR_DID)"
command -v xcodebuild >/dev/null || abort "xcodebuild is needed (a Mac with Xcode; in CI the macOS runner of build-on-tag.yml)"
xcodebuild -version | tr '\n' ' '; echo
export VITE_TARGET=appstore

# ---- signing material: all four or none ------------------------------------------------------------
SIGNED=false
KEYCHAIN="$WORK/build.keychain-db"
PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
PROFILE_FILE=""
cleanup() {
  if [ -f "$KEYCHAIN" ]; then security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true; fi
  if [ -n "$PROFILE_FILE" ] && [ -f "$PROFILE_FILE" ]; then rm -f "$PROFILE_FILE"; fi
  rm -f "$WORK/cert.p12" "$WORK/profile.mobileprovision" "$WORK/profile.plist"
}
trap cleanup EXIT
rm -rf "$WORK" "$OUT" && mkdir -p "$WORK" "$OUT"

MISSING=()
for v in IOS_TEAM_ID IOS_DIST_CERT_P12_BASE64 IOS_DIST_CERT_PASSWORD IOS_PROVISIONING_PROFILE_BASE64; do
  [ -n "${!v:-}" ] || MISSING+=("$v")
done
if [ ${#MISSING[@]} -eq 0 ]; then
  SIGNED=true
elif [ ${#MISSING[@]} -lt 4 ]; then
  abort "signing needs all of IOS_TEAM_ID, IOS_DIST_CERT_P12_BASE64, IOS_DIST_CERT_PASSWORD, IOS_PROVISIONING_PROFILE_BASE64; missing: ${MISSING[*]}"
else
  echo "    no signing material (IOS_TEAM_ID, IOS_DIST_CERT_P12_BASE64, IOS_DIST_CERT_PASSWORD, IOS_PROVISIONING_PROFILE_BASE64): unsigned archive"
fi

echo "==> 2/7 dependencies (frozen lockfile)"
pnpm install --frozen-lockfile --filter wot-v3

echo "==> 3/7 App Store web bundle (no live update) + store-build check"
( cd "$APP_DIR" && pnpm build:appstore )

echo "==> 4/7 cap sync ios + store-build check on the synced assets + plugin completeness"
( cd "$APP_DIR" && pnpm exec cap sync ios )
( cd "$APP_DIR" && node scripts/check-build.mjs ios/App/App/public build-meta/module-graph.json )
# the CLI only warns when a plugin has no Package.swift and leaves it out of CapApp-SPM: fail closed
WANT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).includePlugins.length)' "$IOS_DIR/App/capacitor.config.json")
HAVE=$(grep -c '^\s*\.product(name: "' "$IOS_DIR/CapApp-SPM/Package.swift")
# Capacitor and Cordova are products of the bridge, not plugins
[ "$((HAVE - 2))" -eq "$WANT" ] || abort "CapApp-SPM/Package.swift links $((HAVE - 2)) plugins, capacitor.config.ts names $WANT (a plugin without Package.swift at its root; see the warnings of cap sync)"
echo "    ok: $WANT plugins in CapApp-SPM/Package.swift"

echo "==> 5/7 signing identity"
SIGN_ARGS=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= CODE_SIGN_ENTITLEMENTS=)
PROFILE_NAME=""
if $SIGNED; then
  KEYCHAIN_PW="$(openssl rand -hex 24)"
  security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
  echo "$IOS_DIST_CERT_P12_BASE64" | base64 --decode > "$WORK/cert.p12"
  security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -f pkcs12 >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "Apple Distribution" || abort "the certificate in IOS_DIST_CERT_P12_BASE64 is not an 'Apple Distribution' identity"
  echo "$IOS_PROVISIONING_PROFILE_BASE64" | base64 --decode > "$WORK/profile.mobileprovision"
  security cms -D -i "$WORK/profile.mobileprovision" > "$WORK/profile.plist"
  PROFILE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$WORK/profile.plist")"
  PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$WORK/profile.plist")"
  PROFILE_APP="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$WORK/profile.plist")"
  [ "$PROFILE_APP" = "$IOS_TEAM_ID.$APP_ID" ] || abort "the provisioning profile is for '$PROFILE_APP', the build needs '$IOS_TEAM_ID.$APP_ID'"
  /usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.developer.associated-domains' "$WORK/profile.plist" >/dev/null 2>&1 \
    || abort "the provisioning profile lacks the Associated Domains capability (App.entitlements claims applinks:web-of-trust.de)"
  mkdir -p "$PROFILE_DIR"
  PROFILE_FILE="$PROFILE_DIR/$PROFILE_UUID.mobileprovision"
  cp "$WORK/profile.mobileprovision" "$PROFILE_FILE"
  SIGN_ARGS=(CODE_SIGN_STYLE=Manual "DEVELOPMENT_TEAM=$IOS_TEAM_ID" "CODE_SIGN_IDENTITY=Apple Distribution" "PROVISIONING_PROFILE_SPECIFIER=$PROFILE_NAME" "OTHER_CODE_SIGN_FLAGS=--keychain $KEYCHAIN")
  echo "    ok: Apple Distribution identity, profile '$PROFILE_NAME' for $PROFILE_APP"
else
  echo "    skipped: unsigned archive"
fi

echo "==> 6/7 xcodebuild archive + export + native artifact check"
ARCHIVE="$WORK/$SCHEME.xcarchive"
xcodebuild -project "$IOS_DIR/$SCHEME.xcodeproj" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$WORK/DerivedData" \
  "MARKETING_VERSION=$VERSION_NAME" "CURRENT_PROJECT_VERSION=$BUILD_NUMBER" "${SIGN_ARGS[@]}" \
  archive > "$WORK/archive.log" 2>&1 || { tail -120 "$WORK/archive.log"; abort "xcodebuild archive failed (full log: $WORK/archive.log)"; }
grep -E '^\*\* ARCHIVE|warning:' "$WORK/archive.log" | sort -u | tail -20 || true
APP_BUNDLE="$ARCHIVE/Products/Applications/$SCHEME.app"
[ -d "$APP_BUNDLE" ] || abort "no $SCHEME.app in the archive"

ARTIFACT_KIND=""; ARTIFACT=""
if $SIGNED; then
  # Xcode 15.4+ names the App Store method app-store-connect (older: app-store)
  XCODE_MAJOR="$(xcodebuild -version | awk '/^Xcode/ {print int($2)}')"
  METHOD=app-store-connect; [ "$XCODE_MAJOR" -ge 16 ] || METHOD=app-store
  cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>$METHOD</string>
	<key>destination</key><string>export</string>
	<key>signingStyle</key><string>manual</string>
	<key>teamID</key><string>$IOS_TEAM_ID</string>
	<key>signingCertificate</key><string>Apple Distribution</string>
	<key>provisioningProfiles</key><dict><key>$APP_ID</key><string>$PROFILE_NAME</string></dict>
	<key>uploadSymbols</key><true/>
	<key>stripSwiftSymbols</key><true/>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" > "$WORK/export.log" 2>&1 \
    || { tail -80 "$WORK/export.log"; abort "xcodebuild -exportArchive failed (full log: $WORK/export.log)"; }
  shopt -s nullglob; IPAS=("$WORK"/export/*.ipa); shopt -u nullglob
  [ ${#IPAS[@]} -eq 1 ] || abort "expected exactly one IPA in $WORK/export, found: ${IPAS[*]:-none}"
  "$APP_DIR/scripts/check-native-artifact.sh" "${IPAS[0]}" no-ota
  ARTIFACT_KIND=ipa; ARTIFACT="$SCHEME-$VERSION_NAME.ipa"
  cp "${IPAS[0]}" "$OUT/$ARTIFACT"
else
  "$APP_DIR/scripts/check-native-artifact.sh" "$APP_BUNDLE" no-ota
  ARTIFACT_KIND=xcarchive; ARTIFACT="$SCHEME-unsigned.xcarchive.zip"
  ( cd "$WORK" && ditto -c -k --keepParent "$SCHEME.xcarchive" "$OUT/$ARTIFACT" )
fi

echo "==> 7/7 build-info + checksums"
COMMIT=$(git rev-parse HEAD)
# the fields of the Android build-info (scripts/build-android.sh): app, tag, commit, signed, otaChannels.<kind>,
# artifacts.<kind>; no time stamp (reproducible as far as Xcode allows)
BI_APP="$APP_ID" BI_TAG="$TAG" BI_COMMIT="$COMMIT" BI_VNAME="$VERSION_NAME" BI_BUILD="$BUILD_NUMBER" \
BI_KIND="$ARTIFACT_KIND" BI_FILE="$ARTIFACT" BI_SIGNED="$SIGNED" BI_TEAM="${IOS_TEAM_ID:-}" BI_PROFILE="$PROFILE_NAME" \
BI_MEDIATOR="$VITE_MEDIATOR_DID" BI_NODE="$(node --version)" BI_PNPM="$(pnpm --version)" BI_XCODE="$(xcodebuild -version | tr '\n' ' ' | sed 's/ $//')" \
node -e '
const e = process.env;
require("fs").writeFileSync(process.argv[1], JSON.stringify({
  app: e.BI_APP, tag: e.BI_TAG, commit: e.BI_COMMIT,
  versionName: e.BI_VNAME, buildNumber: Number(e.BI_BUILD),
  platform: "ios",
  artifacts: { [e.BI_KIND]: e.BI_FILE },
  otaChannels: { [e.BI_KIND]: "disabled" },
  mediator: e.BI_MEDIATOR,
  toolchain: { node: e.BI_NODE, pnpm: e.BI_PNPM, xcode: e.BI_XCODE },
  signed: e.BI_SIGNED === "true",
  signing: e.BI_SIGNED === "true" ? { teamId: e.BI_TEAM, profile: e.BI_PROFILE, certificate: "Apple Distribution" } : null,
  note: e.BI_SIGNED === "true"
    ? "v3 app (apps/wot-v3): IPA for App Store Connect / TestFlight, no live update, signed in CI with the distribution certificate of the workflow secrets."
    : "v3 app (apps/wot-v3): unsigned archive, no live update. No signing material in this run; nothing to upload."
}, null, 2) + "\n");
' "$OUT/build-info.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$OUT/build-info.json"

( cd "$OUT" && shasum -a 256 ./* > SHA256SUMS )

echo
echo "DONE: $OUT/"
ls -la "$OUT/"
