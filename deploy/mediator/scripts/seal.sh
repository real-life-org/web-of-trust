#!/usr/bin/env bash
# Encrypt plaintext secrets with sops. The plaintext is removed only after the
# encrypted file decrypts back to the same content; on any failure the
# plaintext and the previous encrypted file stay as they were.
#
# usage: scripts/seal.sh vta|secrets|env...   (from anywhere)
#   vta      vta/                  -> secrets/vta-mediator.sops.json
#   secrets  secrets/secrets.json  -> secrets/secrets.sops.json
#   env      secrets/mediator.env  -> secrets/mediator.sops.env
# Stop the VTA before sealing vta/.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

die() { echo "seal: $*; plaintext kept, nothing removed" >&2; exit 1; }
command -v sops >/dev/null 2>&1 || die "sops not found"
command -v jq >/dev/null 2>&1 || die "jq not found"

tmp=""
cleanup() { [ -n "$tmp" ] && rm -f "$tmp"; return 0; }
trap cleanup EXIT

# seal <plaintext> <encrypted> <in-type> <out-type> <compare: bytes|json>
seal() {
  local plain=$1 enc=$2 itype=$3 otype=$4 compare=$5
  [ -s "$plain" ] || die "$plain missing or empty"
  tmp="$enc.tmp"
  # sops picks the creation rule (.sops.yaml) by the input path
  sops -e --input-type "$itype" --output-type "$otype" "$plain" > "$tmp" || die "sops could not encrypt $plain"
  [ -s "$tmp" ] || die "sops wrote nothing for $plain"
  local want got
  if [ "$compare" = json ]; then
    want=$(jq -cS . "$plain" | sha256sum)
    got=$(sops -d --input-type "$otype" --output-type "$itype" "$tmp" | jq -cS . | sha256sum) || die "round trip of $tmp failed"
  else
    want=$(sha256sum < "$plain")
    got=$(sops -d --input-type "$otype" --output-type "$itype" "$tmp" | sha256sum) || die "round trip of $tmp failed"
  fi
  [ "$want" = "$got" ] || die "$tmp does not decrypt to $plain"
  mv -f "$tmp" "$enc"
  tmp=""
  echo "seal: $enc written and checked"
}

[ $# -gt 0 ] || { echo "usage: $0 vta|secrets|env..." >&2; exit 2; }
for what in "$@"; do
  case "$what" in
    vta)
      [ -d vta ] || die "vta/ missing"
      tar -czf secrets/vta-mediator.tar.gz vta
      seal secrets/vta-mediator.tar.gz secrets/vta-mediator.sops.json binary json bytes
      rm -r vta secrets/vta-mediator.tar.gz
      ;;
    secrets)
      seal secrets/secrets.json secrets/secrets.sops.json json json json
      rm secrets/secrets.json
      ;;
    env)
      seal secrets/mediator.env secrets/mediator.sops.env dotenv dotenv bytes
      rm secrets/mediator.env
      ;;
    *) echo "seal: unknown $what" >&2; exit 2 ;;
  esac
  echo "seal: plaintext of $what removed"
done
