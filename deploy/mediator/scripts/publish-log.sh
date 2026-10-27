#!/usr/bin/env bash
# Export the DID log from the VTA, check it, and only then replace
# did/did.jsonl and did/did-latest.jsonl. On any failure both files stay
# byte for byte as they were. The VTA must be stopped.
#
# Checks: every line is JSON; the last entry is <DID>; the current log is an
# unchanged prefix of the new one; the new log resolves (didwebvh-ts, the
# resolver the app uses) to its last version; that version carries the
# TSPTransport service.
#
# usage: scripts/publish-log.sh <DID>
#   Needs node and npm: the resolver is installed from scripts/resolver
#   (didwebvh-ts 2.8.0, every dependency pinned by package-lock.json) with
#   `npm ci --ignore-scripts` into a temporary directory, so no install script
#   runs next to the open vta/. DIDWEBVH_CLI=<path>/didwebvh-ts/dist/cli/didwebvh.js
#   uses an existing copy instead.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 022
die() { echo "publish-log: $*; did/ unchanged" >&2; exit 1; }
[ $# -eq 1 ] || die "usage: $0 <DID>"
did=$1

mkdir -p did
work=$(mktemp -d .publish.XXXXXX)
trap 'rm -rf "$work"' EXIT
vta did-mgmt dids get-log -c vta/config.toml "$did" > "$work/raw" 2> "$work/err" \
  || { sed -n '/rror/p' "$work/err" >&2; die "export from the VTA failed (is the VTA stopped?)"; }
grep '^{' "$work/raw" > "$work/did.jsonl" || die "the VTA returned no log"
jq -ce . "$work/did.jsonl" > /dev/null || die "a log line is not JSON"
[ "$(tail -n 1 "$work/did.jsonl" | jq -r .state.id)" = "$did" ] || die "the last entry is not $did"

if [ -s did/did.jsonl ]; then
  n=$(wc -l < did/did.jsonl)
  head -n "$n" "$work/did.jsonl" | cmp -s - did/did.jsonl || die "the current did/did.jsonl is not a prefix of the exported log"
  [ "$(wc -l < "$work/did.jsonl")" -gt "$n" ] || die "no new entry"
fi

last=$(tail -n 1 "$work/did.jsonl" | jq -r .versionId)
cli=${DIDWEBVH_CLI:-}
if [ -z "$cli" ]; then
  mkdir "$work/resolver"
  cp scripts/resolver/package.json scripts/resolver/package-lock.json "$work/resolver/"
  (cd "$work/resolver" && npm ci --ignore-scripts --no-audit --no-fund --silent > /dev/null) || die "could not install the resolver (scripts/resolver)"
  cli="$work/resolver/node_modules/didwebvh-ts/dist/cli/didwebvh.js"
fi
# the package's bin only runs under bun; call its resolve handler from node
node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { handleResolve } = await import(pathToFileURL(process.argv[1]).href); await handleResolve(["--log", process.argv[2]]);' \
  "$cli" "$work/did.jsonl" > "$work/resolved" 2>&1 || { tail -n 5 "$work/resolved" >&2; die "the new log does not resolve"; }
grep -q "\"versionId\": \"$last\"" "$work/resolved" || die "the log does not resolve to its last version $last"
tail -n 1 "$work/did.jsonl" | jq -e '.state.service[] | select(.type | index("TSPTransport"))' > /dev/null \
  || die "the last version has no TSPTransport service"

tail -n 1 "$work/did.jsonl" > "$work/did-latest.jsonl"
# same file system: rename is atomic; the full log first, it is the public one
mv -f "$work/did.jsonl" did/did.jsonl
mv -f "$work/did-latest.jsonl" did/did-latest.jsonl
echo "publish-log: did/did.jsonl now ends at $last ($(wc -l < did/did.jsonl) entries); did/did-latest.jsonl updated"
