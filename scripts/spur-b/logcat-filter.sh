#!/usr/bin/env bash
# Spur-B helper: tail logcat filtered to the app's own process (WebView console + Capacitor).
# Handy for spotting a reconnect storm / outbox loop (S11) or SEQ_COLLISION on relaunch (S1).
set -euo pipefail

PKG="${WOT_PKG:-org.reallife.weboftrust}"

PID="$(adb shell pidof -s "$PKG" 2>/dev/null | tr -d '\r' || true)"
if [ -z "$PID" ]; then
  echo "app $PKG is not running — start it first (or run scripts/spur-b/force-stop.sh --relaunch)" >&2
  exit 1
fi

echo "tailing logcat for $PKG (pid $PID) — Ctrl-C to stop" >&2
adb logcat --pid="$PID"
