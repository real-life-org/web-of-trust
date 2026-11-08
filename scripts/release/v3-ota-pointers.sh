#!/usr/bin/env bash
# The live-update pointers of the v3 app for the Pages deploy (deploy.yml): reads the newest published
# GitHub release ota-v3-<n> (made by the signing service wot-release), checks every channel manifest in
# it against the bundle it names and against the public key compiled into the shells
# (apps/wot-v3/ota/live-update-public.pem), and writes <out>/<channel>/latest.json. A manifest that
# does not verify stops the deploy, rather than publishing a pointer the phones would refuse anyway.
# No ota-v3 release yet: nothing is written, the phones keep their own bundle.
#
# Usage: scripts/release/v3-ota-pointers.sh <out dir, e.g. combined/updates>   (needs gh with GH_TOKEN)
set -euo pipefail

OUT="${1:-}"
[ -n "$OUT" ] || { echo "usage: $0 <out dir>" >&2; exit 2; }
REPO="${GITHUB_REPOSITORY:-real-life-org/web-of-trust}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="$ROOT/apps/wot-v3/ota/live-update-public.pem"
CHANNELS=(v3-android v3-ios)
abort() { echo "ABORT: $*" >&2; exit 1; }

TAG=$(gh api "repos/$REPO/releases?per_page=100" --jq '[.[] | select(.draft == false and (.tag_name | test("^ota-v3-[0-9]+$")))] | sort_by(.published_at) | last | .tag_name // empty')
if [ -z "$TAG" ]; then echo "no ota-v3 release yet: no v3 live-update pointer"; exit 0; fi
echo "v3 live update: $TAG"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
gh release download "$TAG" --repo "$REPO" --dir "$WORK" --pattern 'latest-*.json' --pattern '*.zip'

for channel in "${CHANNELS[@]}"; do
  m="$WORK/latest-$channel.json"
  [ -f "$m" ] || abort "$TAG has no latest-$channel.json"
  zip="$WORK/$channel.zip"
  [ -f "$zip" ] || abort "$TAG has no $channel.zip"
  # the manifest names this release and this file, the checksum and the signature fit the file
  M="$m" TAG="$TAG" CH="$channel" REPO="$REPO" node -e '
    const e = process.env, m = JSON.parse(require("fs").readFileSync(e.M, "utf8"))
    const url = `https://github.com/${e.REPO}/releases/download/${e.TAG}/${e.CH}.zip`
    if (m.bundleId !== e.TAG) throw new Error(`bundleId ${m.bundleId} != ${e.TAG}`)
    if (m.url !== url) throw new Error(`url ${m.url} != ${url}`)
    if (!/^[0-9a-f]{64}$/.test(m.checksum ?? "")) throw new Error("checksum is not SHA-256 hex")
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(m.minNative ?? "")) throw new Error("minNative is not major.minor.patch")
    if (typeof m.signature !== "string" || !m.signature) throw new Error("no signature")
  ' || abort "manifest of $channel in $TAG"
  want=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).checksum)' "$m")
  got=$(sha256sum "$zip" | cut -d' ' -f1)
  [ "$got" = "$want" ] || abort "$channel.zip in $TAG: SHA-256 $got != manifest $want"
  node -e 'process.stdout.write(Buffer.from(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).signature, "base64"))' "$m" > "$WORK/$channel.sig"
  openssl dgst -sha256 -verify "$KEY" -signature "$WORK/$channel.sig" "$zip" >/dev/null \
    || abort "$channel.zip in $TAG: the signature does not verify against apps/wot-v3/ota/live-update-public.pem"
  mkdir -p "$OUT/$channel"
  cp "$m" "$OUT/$channel/latest.json"
  echo "  ok: $channel → $TAG (signature verified)"
done
