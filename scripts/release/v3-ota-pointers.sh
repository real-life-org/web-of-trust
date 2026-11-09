#!/usr/bin/env bash
# The live-update pointers of the v3 app for the Pages deploy (deploy.yml): reads the newest published
# GitHub release ota-v3-<n> (made by the signing service wot-release), checks every channel manifest in
# it: its signed envelope (app, channel, bundle id, sequence, checksum, minNative) against the public key
# compiled into the app (apps/wot-v3/ota/live-update-public.pem), and the zip against the envelope's
# checksum; then writes <out>/<channel>/latest.json. A manifest that
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
  # the signed envelope (#526): app, this channel, this release, its sequence, the zip's checksum and
  # minNative, verified against the shells' public key; the client checks the same before it downloads
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    if (typeof m.envelope !== "string" || typeof m.envelopeSignature !== "string") throw new Error("no signed envelope")
    require("fs").writeFileSync(process.argv[2], m.envelope)
    require("fs").writeFileSync(process.argv[3], Buffer.from(m.envelopeSignature, "base64"))
  ' "$m" "$WORK/$channel.envelope" "$WORK/$channel.envelope.sig" || abort "manifest of $channel in $TAG has no signed envelope"
  openssl dgst -sha256 -verify "$KEY" -signature "$WORK/$channel.envelope.sig" "$WORK/$channel.envelope" >/dev/null \
    || abort "$channel in $TAG: the envelope signature does not verify against apps/wot-v3/ota/live-update-public.pem"
  SUM=$(sha256sum "$zip" | cut -d' ' -f1)
  E="$WORK/$channel.envelope" M="$m" TAG="$TAG" CH="$channel" REPO="$REPO" SUM="$SUM" node -e '
    const fs = require("fs"), e = process.env
    const env = JSON.parse(fs.readFileSync(e.E, "utf8")), m = JSON.parse(fs.readFileSync(e.M, "utf8"))
    const seq = Number(e.TAG.slice("ota-v3-".length))
    if (env.app !== "org.reallife.weboftrust") throw new Error(`envelope app ${env.app}`)
    if (env.channel !== e.CH) throw new Error(`envelope channel ${env.channel} != ${e.CH}`)
    if (env.bundleId !== e.TAG || env.seq !== seq) throw new Error(`envelope ${env.bundleId}/${env.seq} != ${e.TAG}/${seq}`)
    if (env.checksum !== e.SUM) throw new Error(`envelope checksum ${env.checksum} != zip ${e.SUM}`)
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(env.minNative ?? "")) throw new Error("minNative is not major.minor.patch")
    const url = `https://github.com/${e.REPO}/releases/download/${e.TAG}/${e.CH}.zip`
    if (m.url !== url) throw new Error(`url ${m.url} != ${url}`)
  ' || abort "envelope of $channel in $TAG"
  mkdir -p "$OUT/$channel"
  cp "$m" "$OUT/$channel/latest.json"
  echo "  ok: $channel → $TAG (envelope verified, zip matches its checksum)"
done
