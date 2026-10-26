#!/usr/bin/env bash
# Write the mediator's operating keys from the VTA into secrets/secrets.json
# (entry mediator_operating_secrets). The key material goes from the VTA
# into the file and is never printed. The VTA must be stopped.
#
# usage: scripts/operating-secrets.sh <base secrets.json> <DID#signing-key> <DID#key-agreement-key>
#   base: setup/conf/secrets.json (first setup) or the current
#   secrets/secrets.json (key replacement, decrypted with sops -d)
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
die() { echo "operating-secrets: $*" >&2; exit 1; }
[ $# -eq 3 ] || die "usage: $0 <base secrets.json> <DID#signing-key> <DID#key-agreement-key>"
base=$1; shift
[ -s "$base" ] || die "$base missing"
jq -e '.entries.mediator_jwt_secret and .entries.mediator_admin_credential' "$base" >/dev/null \
  || die "$base lacks the JWT key or the admin credential"

work=$(mktemp -d secrets/.ops.XXXXXX)
trap 'rm -rf "$work"' EXIT
vta keys secrets -c vta/config.toml "$@" > /dev/null 2> "$work/out" || die "vta keys secrets failed (is the VTA stopped?)"
sed -n 's/^Key ID: *//p; s/^Secret Key Multibase: *//p' "$work/out" | paste - - > "$work/keys.tsv"
rm "$work/out"
[ "$(wc -l < "$work/keys.tsv")" -eq 2 ] || die "expected two keys from the VTA"
for id in "$@"; do cut -f1 "$work/keys.tsv" | grep -qxF "$id" || die "VTA returned no key $id"; done

b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
ops=$(jq -Rsc 'split("\n") | map(select(length > 0) | split("\t")
        | {id: .[0], type: "Multikey", privateKeyMultibase: .[1]})
        | {version: 1, kind: "operating-secrets", data: .}' "$work/keys.tsv" | b64url)
jq --arg ops "$ops" '.entries.mediator_operating_secrets = $ops' "$base" > "$work/secrets.json"
mv -f "$work/secrets.json" secrets/secrets.json
echo "operating-secrets: secrets/secrets.json written with $*"
