#!/usr/bin/env bash
# Spur-B S1/S11 helper: hard-kill the app (durable-persistence-over-app-kill test),
# optionally relaunch it. NOT a test framework — just the one adb call the operator repeats.
set -euo pipefail

PKG="${WOT_PKG:-org.reallife.weboftrust}"
ACTIVITY="${WOT_ACTIVITY:-.MainActivity}"
RELAUNCH=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--relaunch]

Force-stops $PKG on the single connected device (adb).
  --relaunch   after the kill, cold-start the app again (for the S1 relaunch step)

Env overrides: WOT_PKG (app id), WOT_ACTIVITY (launch activity), ANDROID_SERIAL (device).
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --relaunch) RELAUNCH=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

echo "force-stopping $PKG ..." >&2
adb shell am force-stop "$PKG"
echo "done." >&2

if [ "$RELAUNCH" -eq 1 ]; then
  echo "relaunching $PKG/$ACTIVITY ..." >&2
  adb shell am start -n "$PKG/$ACTIVITY"
fi
