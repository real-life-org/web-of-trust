#!/usr/bin/env bash
# Version and build number of the v3 app from a release tag, the rule of scripts/build-android.sh and
# android/app/build.gradle in one place for the iOS build: app-v3.x.y -> VERSION_NAME 3.x.y
# (MARKETING_VERSION / versionName), BUILD_NUMBER major*10000 + minor*100 + patch (CURRENT_PROJECT_VERSION
# / versionCode; 3.0.0 -> 30000). Fails closed for Gen-2 tags (major < 3) and when minor or patch would
# collide (>= 100). Prints two lines, KEY=VALUE, for `eval`.
set -euo pipefail

TAG_PREFIX=app-v
TAG="${1:-}"
abort() { echo "ABORT: $*" >&2; exit 1; }
[ -n "$TAG" ] || abort "usage: $0 <tag>   (e.g. ${TAG_PREFIX}3.0.0)"

WANT="${TAG#"$TAG_PREFIX"}"
[ "$WANT" != "$TAG" ] || abort "tag '$TAG' does not start with '$TAG_PREFIX'"
if [[ ! "$WANT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  abort "tag '$TAG': the version '$WANT' is not major.minor.patch"
fi
_MJ=$((10#${BASH_REMATCH[1]})); _MN=$((10#${BASH_REMATCH[2]})); _PT=$((10#${BASH_REMATCH[3]}))
[ "$_MJ" -ge 3 ] || abort "tag '$TAG' is a Gen-2 tag (major < 3): scripts/release/build-android.sh builds it from apps/demo"
if [ "$_MN" -ge 100 ] || [ "$_PT" -ge 100 ]; then abort "the build-number formula needs minor/patch < 100: $WANT"; fi

echo "VERSION_NAME=$WANT"
echo "BUILD_NUMBER=$(( _MJ * 10000 + _MN * 100 + _PT ))"
