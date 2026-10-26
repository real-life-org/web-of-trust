#!/usr/bin/env bash
# Unpack the sealed VTA state into vta/ and point its config at this
# directory (vta/config.toml stores absolute paths of the machine that made it).
#
# usage: scripts/vta-open.sh
#   then: export VTI_SECURE_STORE=file PNM_HOME="$PWD/vta/pnm" VTA_ALLOW_PRIVATE_ENDPOINTS=1
#   (VTI_SECURE_STORE=file keeps pnm's session in vta/pnm, inside the sealed
#   archive, instead of the OS keyring of one machine)
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
die() { echo "vta-open: $*" >&2; exit 1; }
[ ! -e vta ] || die "vta/ exists already; seal it (scripts/seal.sh vta) or remove it first"
command -v sops >/dev/null 2>&1 || die "sops not found"
[ -s secrets/vta-mediator.sops.json ] || die "secrets/vta-mediator.sops.json missing"

work=$(mktemp -d .vta-open.XXXXXX)
trap 'rm -rf "$work"' EXIT
sops -d --input-type json --output-type binary secrets/vta-mediator.sops.json > "$work/vta.tar.gz"
tar -xzf "$work/vta.tar.gz" -C "$work"
[ -f "$work/vta/config.toml" ] || die "archive has no vta/config.toml"
# the only local path in the config is data_dir = "<vta dir>/data"
old=$(sed -n 's|^data_dir *= *"\(.*\)/data"$|\1|p' "$work/vta/config.toml")
[ -n "$old" ] || die "vta/config.toml has no data_dir"
if [ "$old" != "$PWD/vta" ]; then
  # the new path goes through the environment, not into a sed or awk program
  NEW_DATA_DIR="$PWD/vta/data" awk '/^data_dir *=/ { print "data_dir = \"" ENVIRON["NEW_DATA_DIR"] "\""; next } { print }' \
    "$work/vta/config.toml" > "$work/config.toml"
  mv "$work/config.toml" "$work/vta/config.toml"
fi
mv "$work/vta" vta
echo "vta-open: vta/ ready ($old -> $PWD/vta)"
echo "vta-open: now  export VTI_SECURE_STORE=file PNM_HOME=\"$PWD/vta/pnm\" VTA_ALLOW_PRIVATE_ENDPOINTS=1"
