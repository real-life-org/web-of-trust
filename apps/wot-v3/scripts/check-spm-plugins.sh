#!/usr/bin/env bash
# Plugin completeness of the Swift package that `cap sync ios` wrote (scripts/build-ios.sh step 4):
#   1. every plugin of capacitor.config.json (includePlugins) is a package of CapApp-SPM/Package.swift;
#      the CLI only warns when a plugin has no Package.swift at its root and leaves it out;
#   2. each plugin's own Package.swift declares the product the CLI asks for; the CLI derives the name
#      from the npm package name (RealLifeOrg…), and SwiftPM refuses a missing product only on the Mac.
# Fails when it reads no plugin package at all. POSIX character classes only: macOS sed and grep
# know no backslash-s class.
#
# Usage: scripts/check-spm-plugins.sh <ios/App directory>
set -euo pipefail

IOS_DIR="${1:-}"
abort() { echo "ABORT: $*" >&2; exit 1; }
[ -d "$IOS_DIR" ] || abort "usage: $0 <ios/App directory>"
SPM="$IOS_DIR/CapApp-SPM"
[ -f "$SPM/Package.swift" ] || abort "no $SPM/Package.swift (run cap sync ios)"
[ -f "$IOS_DIR/App/capacitor.config.json" ] || abort "no $IOS_DIR/App/capacitor.config.json (run cap sync ios)"

WANT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).includePlugins.length)' "$IOS_DIR/App/capacitor.config.json")

SEEN=0
while IFS=$'\t' read -r pname ppath; do
  [ -n "$pname" ] || continue
  SEEN=$((SEEN + 1))
  # the paths of the generated manifest are relative to the package directory (CapApp-SPM)
  manifest="$SPM/$ppath/Package.swift"
  [ -f "$manifest" ] || abort "plugin package $pname: no Package.swift at $ppath"
  # the name of a .library( product (on the same line or the next name: line), not of a target
  awk -v n="\"$pname\"" '/\.library\(/ { lib = 1 } lib && /name:/ { if (index($0, n)) found = 1; lib = 0 } END { exit !found }' "$manifest" \
    || abort "plugin package $pname: its Package.swift does not declare a product named \"$pname\" (the CLI derives the name from the npm package name)"
done < <(sed -nE 's/^[[:space:]]*\.package\(name: "([^"]+)", path: "([^"]+)".*/\1	\2/p' "$SPM/Package.swift")

[ "$SEEN" -gt 0 ] || abort "no plugin package in $SPM/Package.swift (capacitor.config.ts names $WANT)"
[ "$SEEN" -eq "$WANT" ] || abort "CapApp-SPM/Package.swift links $SEEN plugins, capacitor.config.ts names $WANT (a plugin without Package.swift at its root; see the warnings of cap sync)"
echo "    ok: $SEEN plugins in CapApp-SPM/Package.swift, each product declared by its package"
