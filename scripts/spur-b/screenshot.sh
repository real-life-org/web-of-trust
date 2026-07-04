#!/usr/bin/env bash
# Spur-B helper: pull a screenshot off the connected device into the current dir.
# Used to attach visual evidence (D2 screen, decrypted data visible) to a result row.
# NOTE: never screenshot the mnemonic/seed screen (docs/testing/spur-b-native-dryrun.md § Sicherheit).
set -euo pipefail

OUT="${1:-spur-b-$(date +%Y%m%d-%H%M%S).png}"
DEVSHOT="/sdcard/spur-b-shot.png"

echo "capturing screenshot -> $OUT" >&2
adb shell screencap -p "$DEVSHOT"
adb pull "$DEVSHOT" "$OUT" >/dev/null
adb shell rm -f "$DEVSHOT"
echo "saved: $OUT" >&2
