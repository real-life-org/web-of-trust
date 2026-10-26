#!/usr/bin/env bash
# Bring a log update (and, with --keys, new operating keys) to the server, in
# the order that keeps C consistent: keys -> did-latest.jsonl -> mediator
# restart (healthy) -> full did.jsonl. Every file goes to <name>.new first;
# it replaces the live file only after its SHA-256 on the server equals the
# local one. Any failure stops before the next step; files not yet replaced
# stay as they were.
#
# usage: scripts/to-server.sh [--keys|--first]
#   --keys   also secrets/secrets.sops.json -> secrets/secrets.json (after
#            replacing the operating keys)
#   --first  first start (README step 6): secrets.json, .env (from
#            secrets/mediator.sops.env), did-latest.jsonl and did.jsonl; no
#            restart, the stack is started by hand in step 7
# env: SERVER (default timo@h2980589.stratoserver.net), REMOTE_DIR (default
#      apps/mediator, relative to the server user's home), MEDIATOR_HOST
#      (optional: then the public log is compared at the end)
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
SERVER=${SERVER:-timo@h2980589.stratoserver.net}
RD=${REMOTE_DIR:-apps/mediator}
SSH=${SSH:-ssh}
die() { echo "to-server: $*" >&2; exit 1; }

keys=0; first=0
case "${1:-}" in --keys) keys=1 ;; --first) keys=1; first=1 ;; "") ;; *) die "usage: $0 [--keys|--first]" ;; esac
command -v jq >/dev/null 2>&1 || die "jq not found"

work=$(mktemp -d .to-server.XXXXXX)
trap 'rm -rf "$work"' EXIT

# local checks, before anything moves
[ -s did/did.jsonl ] && [ -s did/did-latest.jsonl ] || die "did/did.jsonl or did/did-latest.jsonl missing"
jq -ce . did/did.jsonl > /dev/null || die "did/did.jsonl is not JSON lines"
tail -n 1 did/did.jsonl | cmp -s - did/did-latest.jsonl || die "did/did-latest.jsonl is not the last line of did/did.jsonl (run scripts/publish-log.sh)"
if [ "$keys" = 1 ]; then
  command -v sops >/dev/null 2>&1 || die "sops not found; nothing sent"
  sops -d secrets/secrets.sops.json > "$work/secrets.json" || die "sops could not decrypt secrets/secrets.sops.json; nothing sent"
  jq -e '.entries.mediator_jwt_secret and .entries.mediator_admin_credential and .entries.mediator_operating_secrets' \
    "$work/secrets.json" > /dev/null || die "decrypted secrets.json is incomplete; nothing sent"
fi
if [ "$first" = 1 ]; then
  sops -d --input-type dotenv --output-type dotenv secrets/mediator.sops.env > "$work/env" \
    || die "sops could not decrypt secrets/mediator.sops.env; nothing sent"
  grep -q '^REDIS_PASSWORD=..' "$work/env" && grep -q '^MEDIATOR_DID=did:' "$work/env" \
    || die "decrypted .env lacks REDIS_PASSWORD or MEDIATOR_DID; nothing sent"
fi

# put <local file> <remote path relative to RD> <mode>: upload to .new, check, rename
put() {
  local src=$1 dst=$2 mode=$3 sum
  sum=$(sha256sum < "$src" | cut -d' ' -f1)
  "$SSH" "$SERVER" "set -eu; cd ~/$RD; umask 077; cat > '$dst.new'; chmod $mode '$dst.new'; \
    [ -s '$dst.new' ] && [ \"\$(sha256sum < '$dst.new' | cut -d' ' -f1)\" = '$sum' ] || { rm -f '$dst.new'; echo 'checksum mismatch' >&2; exit 1; }; \
    mv -f '$dst.new' '$dst'" < "$src" || die "$dst not replaced; stopping"
  echo "to-server: $dst replaced"
}

if [ "$keys" = 1 ]; then
  put "$work/secrets.json" secrets/secrets.json 600
fi
if [ "$first" = 1 ]; then
  put "$work/env" .env 600
  put did/did-latest.jsonl did/did-latest.jsonl 644
  put did/did.jsonl did/did.jsonl 644
  echo "to-server: first-start files in place; continue with README step 7"
  exit 0
fi
put did/did-latest.jsonl did/did-latest.jsonl 644
"$SSH" "$SERVER" "set -eu; cd ~/$RD; docker compose restart mediator; \
  for i in \$(seq 1 30); do [ \"\$(docker inspect -f '{{.State.Health.Status}}' mediator)\" = healthy ] && exit 0; sleep 2; done; \
  echo 'mediator not healthy after 60 s' >&2; exit 1" \
  || die "mediator restart failed; did/did.jsonl NOT replaced on the server"
echo "to-server: mediator restarted and healthy"
put did/did.jsonl did/did.jsonl 644

if [ -n "${MEDIATOR_HOST:-}" ]; then
  curl -fsS "https://$MEDIATOR_HOST/.well-known/did.jsonl" | cmp -s - did/did.jsonl \
    || die "https://$MEDIATOR_HOST/.well-known/did.jsonl differs from did/did.jsonl"
  echo "to-server: public log equals did/did.jsonl"
fi
