#!/usr/bin/env bash
# Upload of the IPA that scripts/build-ios.sh wrote to App Store Connect, and its distribution to the
# external TestFlight group (deploy/ios/README.md). Called by the job `ios` of build-on-tag.yml after
# the artifact upload; runs the same on a Mac with fastlane.
#
# Needs: ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_BASE64 (an App Store Connect API key with the role
# App Manager). Optional: IOS_TESTFLIGHT_GROUP (the name of the external group; with it the build is
# added to the group, which submits it to Beta App Review the first time and notifies the testers;
# without it the build is only uploaded and waits in App Store Connect), IOS_TESTFLIGHT_NOTES (the
# "What to Test" text; default names version, build and tag).
#
# The App Store Connect record (the app with this bundle id) must exist: fastlane pilot adds builds to
# an app, it does not create one. Export compliance: the answer is ITSAppUsesNonExemptEncryption in the
# app's Info.plist (ios/App/App/Info.plist); it is read from the built IPA and passed to pilot, which
# would otherwise answer "false" by itself. With a group set, an IPA without the key stops before the
# upload.
set -euo pipefail

APP_ID=org.reallife.weboftrust
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/out/release-ios"

TAG="${1:-}"
abort() { echo "ABORT: $*" >&2; exit 1; }
[ -n "$TAG" ] || abort "usage: $0 <tag>"
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_API_KEY_P8_BASE64; do [ -n "${!v:-}" ] || abort "$v is not set"; done
command -v fastlane >/dev/null || abort "fastlane is needed (preinstalled on the GitHub macOS runners; locally: brew install fastlane)"
[ -f "$OUT/build-info.json" ] || abort "no $OUT/build-info.json: run scripts/build-ios.sh $TAG first"

INFO_TAG=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tag' "$OUT/build-info.json")
[ "$INFO_TAG" = "$TAG" ] || abort "build-info.json is for $INFO_TAG, not $TAG"
SIGNED=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).signed' "$OUT/build-info.json")
[ "$SIGNED" = true ] || abort "the build of $TAG is unsigned (no signing secrets in that run); nothing to upload"
IPA="$OUT/$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).artifacts.ipa' "$OUT/build-info.json")"
[ -f "$IPA" ] || abort "no IPA at $IPA"
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).versionName' "$OUT/build-info.json")
BUILD=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).buildNumber' "$OUT/build-info.json")

# the export-compliance answer of the built app (the Info.plist Apple reads)
NON_EXEMPT_ENCRYPTION=""
PLIST_DIR="$(mktemp -d)"
if unzip -qq -o "$IPA" 'Payload/*.app/Info.plist' -d "$PLIST_DIR" 2>/dev/null; then
  NON_EXEMPT_ENCRYPTION="$(plutil -extract ITSAppUsesNonExemptEncryption raw "$PLIST_DIR"/Payload/*.app/Info.plist 2>/dev/null || true)"
fi
rm -rf "$PLIST_DIR"
case "$NON_EXEMPT_ENCRYPTION" in true|false) ;; *) NON_EXEMPT_ENCRYPTION="" ;; esac

KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT
# the key file fastlane reads (key_id, issuer_id, key as the .p8 content)
ASC_KEY_ID="$ASC_KEY_ID" ASC_ISSUER_ID="$ASC_ISSUER_ID" ASC_P8="$(echo "$ASC_API_KEY_P8_BASE64" | base64 --decode)" \
node -e '
const e = process.env;
require("fs").writeFileSync(process.argv[1], JSON.stringify({ key_id: e.ASC_KEY_ID, issuer_id: e.ASC_ISSUER_ID, key: e.ASC_P8, in_house: false }));
' "$KEY_DIR/asc-key.json"
chmod 600 "$KEY_DIR/asc-key.json"

NOTES="${IOS_TESTFLIGHT_NOTES:-Web of Trust $VERSION (build $BUILD), tag $TAG.}"
export FASTLANE_SKIP_UPDATE_CHECK=1 FASTLANE_HIDE_CHANGELOG=1 FASTLANE_DISABLE_COLORS=1

if [ -n "${IOS_TESTFLIGHT_GROUP:-}" ] && [ -z "$NON_EXEMPT_ENCRYPTION" ]; then
  abort "the Info.plist of $IPA does not answer ITSAppUsesNonExemptEncryption (true or false); no distribution without the export-compliance answer"
fi

if [ -n "${IOS_TESTFLIGHT_GROUP:-}" ]; then
  echo "==> upload $IPA and add it to the external group '$IOS_TESTFLIGHT_GROUP'"
  fastlane pilot upload \
    --api_key_path "$KEY_DIR/asc-key.json" \
    --app_identifier "$APP_ID" \
    --ipa "$IPA" \
    --changelog "$NOTES" \
    --distribute_external true \
    --uses_non_exempt_encryption "$NON_EXEMPT_ENCRYPTION" \
    --groups "$IOS_TESTFLIGHT_GROUP" \
    --notify_external_testers true
else
  echo "==> upload $IPA (IOS_TESTFLIGHT_GROUP is not set: no distribution, the build waits in App Store Connect)"
  fastlane pilot upload \
    --api_key_path "$KEY_DIR/asc-key.json" \
    --app_identifier "$APP_ID" \
    --ipa "$IPA" \
    --skip_waiting_for_build_processing true
fi
echo "DONE: $TAG ($VERSION, build $BUILD) is in App Store Connect"
