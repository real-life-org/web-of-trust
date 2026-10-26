# VTI mediator: mediator.web-of-trust.de

Our own instance of the Affinidi Messaging Mediator, the carrier `C` that the
Web of Trust app uses for VTI transport (TSP 1.0 over the mediator's routed
form). It runs on `timo` (h2980589.stratoserver.net, NixOS, Traefik with
Let's Encrypt) as three containers: the mediator, a Redis store and a small
file server for the DID log.

| | |
|---|---|
| Image | `ghcr.io/affinidi/messaging-mediator:v0.45.0`, pinned by digest |
| Protocol | TSP 1.0 (`YTSP-BAA`) and DIDComm v2 |
| DID | `did:webvh:<SCID>:mediator.web-of-trust.de`, full log at `/.well-known/did.jsonl` |
| DID keys | update and pre-rotation keys held in an offline VTA (OpenVTC), see "Mediator identity" |
| Sign-up | open: any DID may authenticate (`explicit_deny`) |
| Default ACL | `DENY_ALL,MODE_EXPLICIT_DENY,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES,SEND_FORWARDED` |
| Retention | undelivered messages 7 days, deleted on acknowledgement |
| Rate limit | Traefik, per client IP (20 req/s average, burst 60) |
| Updates | manual tag change; Watchtower is switched off for all containers |

Clients must speak TSP 1.0 (`@openvtc/vti-tsp-js` 0.4.0, `@openvtc/vti-didcomm-js`
0.13.0). Per the 0.45.0 release notes a TSP message addressed to the mediator
itself must be TSP 1.0, while Rev 3 messages between endpoints are still
routed: a Rev 3 client (`vti-tsp-js` 0.3.x) can deposit `direct`, but its
routed deposits (addressed to `C`) are refused.

Files in this directory:

| File | Purpose |
|---|---|
| `docker-compose.yml` | mediator, Redis and `did-log`; Traefik labels; configuration as environment |
| `.env.example` | every variable the compose file reads, without values |
| `.sops.yaml` | the age recipients for the secret files (one placeholder until the first key exists) |
| `did-template.json` | VTA DID template for the mediator's DID document (DIDComm, Authentication, TSP services) |
| `did/did.jsonl` | the mediator's full DID log (public; added after the first setup, extended by every update) |
| `secrets/`, `setup/`, `vta/` | local only, git-ignored: plaintext and encrypted secrets, wizard output, VTA state |

## Configuration

All settings are environment variables in `docker-compose.yml`; the image's
built-in container profile supplies the rest. The settings that make this an
open, routing-capable mediator:

| Variable | Value | Why |
|---|---|---|
| `MEDIATOR_ACL_MODE` | `explicit_deny` | Any DID may authenticate and is registered with the default ACL. Every relationship brings fresh `did:key`s, so a pre-registration list is not workable. |
| `GLOBAL_DEFAULT_ACL` | `DENY_ALL,MODE_EXPLICIT_DENY,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES,SEND_FORWARDED` | What every self-registered DID may do; each flag in "Access control" below. |
| `ENABLE_INTER_MEDIATOR_RELAY` | `true` | Accept anonymous relay hops from other mediators on `/inbound`. With `SEND_FORWARDED` in the default ACL the mediator does this anyway (deprecated implicit relay, warns at boot); the explicit flag keeps it working when upstream drops the implicit path. |
| `LOCAL_DIRECT_DELIVERY_ALLOWED` | `true` | A TSP message whose envelope names a local recipient is stored for pickup. The fallback form `egress-session` depends on it; without it every such deposit ends in 403 `direct_delivery.denied`. |
| `FORCE_SESSION_DID_MATCH` | `true` | The envelope sender must be the authenticated DID. Both of our forms satisfy it. |
| `DID_WEB_SELF_HOSTED` | `did/did-latest.jsonl` | The mediator's own DID document: the last entry of the log, one line. See "DID log". |
| `CORS_ALLOW_ORIGIN` | `*` | Browser and Capacitor clients send an `Origin`; without it they are refused. Endpoints use bearer tokens, not cookies. |
| `LIMIT_MESSAGE_EXPIRY_SECONDS` | `604800` | 7 days; must stay above the 72 h give-up horizon of the VTI profile. |
| `LIMIT_DELIVERED_EXPIRY_SECONDS` | `0` | A collected but unacknowledged message is kept for the full 7 days. |
| `LIMIT_RATE_LIMIT_PER_IP` | `0` | Behind Traefik the mediator sees one address for everyone; the per-IP limit lives in Traefik. |

Upstream references: `crates/affinidi-messaging-mediator/conf/mediator.toml`
(the `Env:` lines), `docs/acls.md`, `docs/multi-mediator.md` §4–§6,
`docs/cors-and-origin.md`, `docs/secrets-backend.md` in
[affinidi/affinidi-messaging-mediator](https://github.com/affinidi/affinidi-messaging-mediator/tree/v0.45.0).

### Access control

Two settings decide what a client can do. `MEDIATOR_ACL_MODE` decides who may
log in. `GLOBAL_DEFAULT_ACL` is written as the ACL of every DID at its first
login; it decides everything after that. `ALLOW_ALL` and `DENY_ALL` reset
every flag, so `DENY_ALL` comes first and the grants follow it.

What each flag does for the paths our clients use. "Direct" is a TSP message
whose envelope names the local recipient (the fallback form
`egress-session`). "Routed" is a TSP Routed message addressed to `C`, which
the mediator opens and delivers to the recipient named in the route (our
default form). "Relay" is a hop that another mediator posts to `/inbound`
without logging in.

| Flag | Login | Direct | Routed | Relay from another mediator |
|---|---|---|---|---|
| `DENY_ALL` | not checked | no rights | no rights | no rights |
| … and it sets the inbox to **allowlist** mode | | every recipient refuses every sender: 403 `delivery.refused` | same | same |
| `MODE_EXPLICIT_DENY` | not checked | inbox is a denylist; empty list, so every sender is admitted | same | same |
| `LOCAL` | not checked; needed afterwards for the WebSocket, pickup, list and delete (`authorization.local`) | the deposit travels on the socket | same | recipient's pickup |
| `SEND_MESSAGES` | not checked | sender gate (`authorization.send`) | not checked | not checked |
| `RECEIVE_MESSAGES` | not checked | recipient gate (`delivery.refused`) | recipient gate at the last hop (`delivery.refused`) | recipient gate (`delivery.refused`) |
| `SEND_FORWARDED` | not checked | not checked | sender gate (`authorization.send_forwarded`, error 44) | admits anonymous relay even without `ENABLE_INTER_MEDIATOR_RELAY` (deprecated) |

Not granted, and not needed:

| Flag | What it would do |
|---|---|
| `RECEIVE_FORWARDED` | Recipient gate for a DIDComm Routing 2.0 `forward`. A TSP Routed message to a local recipient is checked against `RECEIVE_MESSAGES` instead. |
| `ANON_RECEIVE` | Admits anonymous DIDComm senders. A TSP envelope always names its sender. |
| `CREATE_INVITES` | Out-of-band invitations. |
| `MODE_SELF_CHANGE`, `SELF_MANAGE_LIST`, `SELF_MANAGE_*_QUEUE_LIMIT`, `*_CHANGE` | Let a DID change its own inbox mode, access list, queue limits or capabilities. |
| `BLOCKED` | Never in the default: it would block every new DID at login. |

Measured on a local stack with exactly this compose file (see "Checking a
change locally"): without `MODE_EXPLICIT_DENY`, login and health checks pass,
and every delivery, routed and direct, is refused with 403
`e.p.delivery.refused`; the mediator logs "delivery blocked by the
recipient's access list". With it, the live delivery probe passes in both
forms. The other rows follow upstream `docs/acls.md` §3–§6 and the TSP
inbound handler (`src/messages/inbound.rs`).

The default ACL is copied into an account at its first login. Changing
`GLOBAL_DEFAULT_ACL` later does not change existing accounts; they need
`messaging/account/update` with the admin credential (`docs/acls.md` §8).

## First start

Who does what: steps 1–5 on a laptop with Docker, `sops`, `age`, `jq` and the
OpenVTC tools `vta` and `pnm`; steps 6–9 on the server as user `timo`. If you
log in as `root`, run the server commands as `timo` (`runuser -u timo -- …`),
so files and containers belong to `timo`.

### 1. DNS

At INWX, zone `web-of-trust.de`:

```text
mediator   A   85.214.196.122
```

No AAAA record: `timo` has no IPv6 address published for the other
web-of-trust.de services, and a wrong AAAA breaks the certificate challenge.
Check: `dig +short mediator.web-of-trust.de` prints `85.214.196.122`.

### 2. Traefik network on the host

Traefik only sees containers on networks it is attached to. Add the stack's
network to `hosts/timo/default.nix` in `real-life-org/infrastructure`:

```nix
realLife.traefik.extraNetworks = [ "humhub_default" "kreis" "mediator-edge" ];
```

After the merge the nightly rebuild (04:40) or
`nixos-rebuild switch --flake github:real-life-org/infrastructure#timo` (root)
activates it; the `traefik-netze` timer then attaches Traefik within five
minutes of the network appearing. Until then, `timo` can attach it by hand
after step 7: `docker network connect mediator-edge traefik` (lost on a
Traefik restart).

### 3. Age keys

Today only Anton holds an age key. Anton:

```bash
age-keygen -o ~/.config/sops/age/keys.txt   # keep this file private
age-keygen -y ~/.config/sops/age/keys.txt   # prints the public key age1…
```

Put the public key into `.sops.yaml` in place of the placeholder and commit
that change. An offline copy of `keys.txt` (paper or a USB stick in a safe) is
mandatory: with one recipient, losing that file makes every encrypted backup
unreadable, and with it the update keys of `C`.

Add a second person as soon as possible: they create their own key the same
way, their public key goes into `.sops.yaml` as a second entry, and every
existing secret file is re-encrypted for both with
`sops updatekeys secrets/<file>`. Then check that the second person can
decrypt (see "Backup").

### 4. Mediator identity

The mediator needs four secrets and one public DID log:

| What | Made by | Lives |
|---|---|---|
| JWT signing key, admin credential | `mediator-setup` (4a) | `secrets.json` on the server |
| operating keys of `C`: Ed25519 `#key-0` (signing), X25519 `#key-1` (key agreement) | the VTA (4b–4c) | the VTA, and a copy in `secrets.json` on the server |
| update key and pre-rotation keys of the did:webvh log | the VTA (4c) | only the VTA, never the server |
| `did/did.jsonl` | the VTA (4c) | git, and the server |

`mediator-setup` alone is not enough: it creates the did:webvh log with a
fresh update key and pre-rotation commitment but stores neither private key,
so a log made by it can never be updated. Here the VTA makes the DID and keeps
the keys that authorize updates; the operating keys go into `secrets.json` by
hand (upstream `docs/secrets-backend.md`, "Provisioning without the wizard").

Everything below runs on Anton's laptop, in a local checkout, in this
directory (`deploy/mediator/`; `setup/`, `secrets/` and `vta/` are
git-ignored).

#### 4a. JWT key and admin credential

```bash
IMAGE=ghcr.io/affinidi/messaging-mediator:v0.45.0@sha256:3e53ea634d9a3a26352480ff0b5266b8486489e0e672faa6bd6705549005f538
mkdir -p setup secrets did
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/setup:/work" -w /work \
  --entrypoint mediator-setup "$IMAGE" \
  --non-interactive --deployment container --protocol tsp \
  --did-method webvh --public-url "https://mediator.web-of-trust.de/mediator/v1" \
  --secret-storage file --database-url "redis://redis:6379/" \
  --admin generate -c conf/mediator.toml > /dev/null
```

- stdout goes to `/dev/null` because the wizard prints the admin private key;
  the same key is stored in `setup/conf/secrets.json`.
- We keep `mediator_jwt_secret` and `mediator_admin_credential` from
  `setup/conf/secrets.json` and the `admin_did` line of
  `setup/conf/mediator.toml`. The DID, its log and its operating keys that
  the wizard also writes are discarded; 4d replaces them.

#### 4b. The VTA

The VTA (Verifiable Trust Agent, OpenVTC) holds the DID's keys. It runs only
on the laptop and only while the DID is created or changed; between those
times its state exists only as an encrypted archive (step 5). Build `vta` and
`pnm` once from
[OpenVTC/verifiable-trust-infrastructure](https://github.com/OpenVTC/verifiable-trust-infrastructure)
at the commit this README was checked with (`6c57452a`, vta 0.64.0):

```bash
cargo build --release --locked -p vta-service -p pnm-cli   # about an hour
export PATH="<checkout>/target/release:$PATH"
```

Set up a VTA whose state lives in `vta/` (the paths are written into its
config, so restore it to the same place later):

```bash
export VTA_ALLOW_PRIVATE_ENDPOINTS=1   # the VTA's own DID is on localhost
export PNM_HOME="$PWD/vta/pnm"
mkdir -p vta
cat > vta/setup.toml <<EOF
config_path      = "$PWD/vta/config.toml"
data_dir         = "$PWD/vta/data"
public_url       = "http://localhost:3150"
data_dir_exists  = "delete"
overwrite_config = true

[server]
host = "127.0.0.1"
port = 3150

[secrets]
backend = "plaintext"   # vta/ is only ever stored encrypted (step 5)

[messaging]
kind = "skip"           # REST on localhost only

[vta_did]
kind = "create_webvh"
url  = "http://localhost:3150"
EOF
vta setup --from vta/setup.toml
pnm setup --name "Mediator keys"             # prints an admin did:key
vta --config vta/config.toml import-did --did <that did:key> --role admin
vta --config vta/config.toml &                # start
pnm setup continue mediator-keys --vta-did "$(sed -n 's/^vta_did = "\(.*\)"/\1/p' vta/config.toml)"
pnm health
pnm contexts create --id mediator --name Mediator
pnm did-templates create --file did-template.json --context mediator
```

`did-template.json` is the VTA's built-in `didcomm-mediator` template with the
`TSPTransport` service written in: the template's `SERVICE_TSP` slot cannot be
filled from the command line (`--var` values are strings).

#### 4c. The DID

```bash
H=mediator.web-of-trust.de
pnm did-mgmt dids create --context mediator --template wot-mediator \
  --did-url "https://$H/.well-known/did.jsonl" \
  --var URL="https://$H/mediator/v1" --var WS_URL="wss://$H/mediator/v1/ws" \
  --pre-rotation 2 --portable --label "mediator $H"
DID=did:webvh:<SCID>:mediator.web-of-trust.de       # "DID:" line of the output
pnm did-mgmt dids get-log "$DID" --out did/did.jsonl
```

The log's first entry names the update key and two pre-rotation commitments
(`nextKeyHashes`); the VTA holds all three private keys. Any later entry has
to be signed by a key that matches one of the commitments, so the operating
key `#key-0` on the server (which is also the initial update key) cannot
change the log by itself.

The SCID is a hash over the first log entry, so every run yields a new DID.
Run it once; the DID that goes live is `C` for every relationship formed
through this instance.

Check the document:

```bash
tail -n 1 did/did.jsonl | jq -r .state.id     # equals $DID
tail -n 1 did/did.jsonl | jq -c '.state.service[] | {id, type, serviceEndpoint}'
# #service (DIDCommMessaging, https and wss), #auth (Authentication), #tsp (TSPTransport)
```

#### 4d. secrets.json

Stop the VTA (the offline commands need its store to themselves), then copy
the operating keys into the wizard's `secrets.json`. The key material goes
from `vta keys secrets` straight into the file and is never printed:

```bash
kill %1                                       # the VTA started in 4b
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }
umask 077
OPS=$(vta keys secrets -c vta/config.toml "$DID#key-0" "$DID#key-1" 2>&1 >/dev/null \
  | sed -n 's/^Key ID: *//p; s/^Secret Key Multibase: *//p' | paste - - \
  | jq -Rsc 'split("\n") | map(select(length > 0) | split("\t")
      | {id: .[0], type: "Multikey", privateKeyMultibase: .[1]})
      | {version: 1, kind: "operating-secrets", data: .}' | b64url)
jq --arg ops "$OPS" '.entries.mediator_operating_secrets = $ops' \
  setup/conf/secrets.json > secrets/secrets.json
# check: two entries, ids #key-0 and #key-1
jq -r .entries.mediator_operating_secrets secrets/secrets.json | tr '_-' '/+' \
  | base64 -d 2>/dev/null | jq -c '.data[] | .id'
```

`secrets.json` (file backend) maps each entry name to a base64url envelope
`{version, kind, data}`; `operating-secrets` takes a list of
`{id, type, privateKeyMultibase}`, one per verification method.

Then the two DID files the server needs:

```bash
tail -n 1 did/did.jsonl > did/did-latest.jsonl
```

### 5. Encrypt the secrets

```bash
cat > secrets/mediator.env <<EOF
MEDIATOR_HOST=mediator.web-of-trust.de
MEDIATOR_DID=$DID
ADMIN_DID=$(sed -n 's/^admin_did = "did:\/\/\(.*\)"/\1/p' setup/conf/mediator.toml)
MEDIATOR_UID=
MEDIATOR_GID=
REDIS_PASSWORD=$(openssl rand -hex 32)
EOF
tar -czf secrets/vta-mediator.tar.gz vta
sops -e secrets/secrets.json > secrets/secrets.sops.json
sops -e --input-type dotenv --output-type dotenv secrets/mediator.env > secrets/mediator.sops.env
sops -e --input-type binary --output-type json secrets/vta-mediator.tar.gz > secrets/vta-mediator.sops.json
```

`MEDIATOR_UID`/`MEDIATOR_GID` are filled on the server (step 7). The three
`*.sops.*` files go into the private secrets repository, plus one offline
copy (see "Backup"). Commit `did/did.jsonl` here. Then remove every
plaintext: `rm -r setup vta secrets/secrets.json secrets/mediator.env secrets/vta-mediator.tar.gz`.

### 6. Copy files to the server

```bash
ssh timo@h2980589.stratoserver.net 'mkdir -p ~/apps/mediator/did ~/apps/mediator/secrets && chmod 700 ~/apps/mediator/secrets'
scp docker-compose.yml timo@h2980589.stratoserver.net:apps/mediator/
scp did/did.jsonl did/did-latest.jsonl timo@h2980589.stratoserver.net:apps/mediator/did/
sops -d secrets/secrets.sops.json | ssh timo@h2980589.stratoserver.net 'umask 077; cat > ~/apps/mediator/secrets/secrets.json'
sops -d secrets/mediator.sops.env | ssh timo@h2980589.stratoserver.net 'umask 077; cat > ~/apps/mediator/.env'
```

The decrypted files exist only on the server, mode 0600, owned by `timo`.
The VTA archive never goes to the server.

### 7. Start

On the server:

```bash
cd ~/apps/mediator
sed -i "s/^MEDIATOR_UID=.*/MEDIATOR_UID=$(id -u)/; s/^MEDIATOR_GID=.*/MEDIATOR_GID=$(id -g)/" .env
docker compose config -q && docker compose up -d
docker compose ps          # mediator and redis "healthy" after about 20 s, did-log "Up"
docker logs mediator 2>&1 | grep -E '"level":"(WARN|ERROR)"'
```

Expected warnings: plaintext `file://` secret backend, no TLS on the
container port (Traefik terminates TLS), Redis without TLS (internal network),
`trust_task_verification = "warn"`, the deprecated `functions_file` fallback
of the upstream image profile. Anything else needs a look.

If step 2 is not active yet: `docker network connect mediator-edge traefik`.

### 8. Check from outside

```bash
H=https://mediator.web-of-trust.de
curl -s $H/mediator/v1/healthchecker   # {"message":"… Version: 0.45.0, Started: …","status":"success"}
curl -s $H/mediator/v1/readyz | jq -c '{status, operating_keys_loaded}'   # "ready", true
curl -s $H/.well-known/did.jsonl | cmp - did/did.jsonl && echo "full log served"
curl -s $H/.well-known/did.jsonl | tail -n 1 | jq -r .state.id               # equals MEDIATOR_DID
curl -s -o /dev/null -D - -H 'Origin: https://localhost' $H/mediator/v1/healthchecker | grep -i access-control-allow-origin
# WebSocket route reaches the mediator (401 without a token, not 404/502):
curl -s -o /dev/null -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' $H/mediator/v1/ws
# Rate limit answers 429 under load (parallel, from one address):
seq 200 | xargs -P 40 -I{} curl -s -o /dev/null -w '%{http_code}\n' $H/mediator/v1/healthchecker | sort | uniq -c
```

### 9. Live probe

From `real-life-org/trust-protocol`, with `binding/` on `@openvtc/vti-tsp-js`
0.4.0 and `@openvtc/vti-didcomm-js` 0.13.0 (a binding on 0.3.0 speaks Rev 3
and its routed deposits are refused by this mediator):

```bash
(cd lib && npm ci && npm run build)
cd binding && npm ci
RLTP_LIVE_MEDIATOR=1 MEDIATOR_DID="did:webvh:<SCID>:mediator.web-of-trust.de" node live-delivery-probe.mjs
RLTP_LIVE_MEDIATOR=1 MEDIATOR_DID="…" RLTP_WIRE_DEPOSIT=egress-session node live-delivery-probe.mjs
```

Pass, in both forms: `delivery-ack B→A: delivered=yes`, trias
`accepted → delivered`. Health checks alone do not show a delivery problem;
this probe does.

## DID log

The log grows by one entry per change. Resolvers fetch the whole log from
`/.well-known/did.jsonl` and verify it from the first entry, so that URL must
always serve every entry. Mediator 0.45.0 cannot do that itself: it parses
`DID_WEB_SELF_HOSTED` as a single log entry and refuses to start on a file
with more than one line ("Couldn't parse content as LogEntry or Document").
Therefore:

- `did/did.jsonl`, the full log, is served by the `did-log` container
  (Caddy, file server). Its Traefik router
  `Host(…) && Path(/.well-known/did.jsonl)` has priority 100 and wins over the
  mediator's `Host(…)` router.
- `did/did-latest.jsonl`, the last line of the log, is the mediator's own
  `DID_WEB_SELF_HOSTED`. The mediator uses it for its own document and serves
  it at `/.well-known/did.json` (as did:web).

Both files change together, after every log update (runbook below).

## Backup

What must survive, and where it lives:

| What | Loss means | Kept |
|---|---|---|
| VTA state (`vta-mediator.sops.json`: update key, pre-rotation keys, operating keys, VTA config) | The log can no longer be updated: no key rotation, no endpoint change, no recovery after a compromise under the same `C`. | private secrets repository, plus one offline copy |
| `secrets.json` (operating keys of `C`, JWT key, admin credential) | The operating keys can be exported again from the VTA; the JWT key and admin credential can be made anew (step 4a; clients log in again). Without the VTA as well: a new `C`. | `secrets.sops.json`, same places |
| `.env` (Redis password, DIDs) | Recoverable: new Redis password, DIDs are public | `mediator.sops.env`, same places |
| `did/did.jsonl` | Recoverable from git, from `/.well-known/did.jsonl`, or from the VTA (`pnm did-mgmt dids get-log`) | this repository |
| age private key | All encrypted backups unreadable | Anton, offline copy mandatory; a second person to be added (step 3) |
| Redis volume `mediator-redis-data` | Waiting messages are gone; accounts are recreated at the next login; senders see their deposits end `failed` at the horizon | not backed up |

Check the backup after the first start and after every runbook run: decrypt
`secrets.sops.json` on another machine (once there is a second person: on
theirs) and compare its SHA-256 with the server file; decrypt
`vta-mediator.sops.json`, unpack it to the same path and run
`vta did-mgmt dids get-log -c vta/config.toml "$DID" | cmp - did/did.jsonl`.

## Runbook: key change

Every change to `C` is a new log entry, signed in the VTA on the laptop.
Steps common to all cases:

```bash
cd deploy/mediator
sops -d --input-type json --output-type binary secrets/vta-mediator.sops.json | tar -xzf -
export VTA_ALLOW_PRIVATE_ENDPOINTS=1 PNM_HOME="$PWD/vta/pnm"
DID=$(tail -n 1 did/did.jsonl | jq -r .state.id)
```

Then one of the cases below, then "Publish".

**Rotate the update key** (routine; also after restoring the VTA from a
backup, or when a pre-rotation key may have leaked). The document stays the
same; the VTA signs with a pre-rotated key and commits to two new ones:

```bash
tail -n 1 did/did.jsonl | jq .state > vta/doc.json
vta did-mgmt dids edit -c vta/config.toml --did "$DID" --document vta/doc.json \
  --pre-rotation 2 --label "rotate update key" --no-confirm
```

**Change a service endpoint**: as above, but edit `vta/doc.json` first.

**Replace the operating keys** (`#key-0`/`#key-1`; after a server compromise
or a leaked `secrets.json`). New keys get new verification-method ids (the
VTA keeps one key record per id):

```bash
vta --config vta/config.toml &
pnm keys create --key-type ed25519 --context mediator --label "mediator signing <date>" --yes   # note "Public Key"
pnm keys create --key-type x25519  --context mediator --label "mediator ka <date>" --yes        # note "Public Key"
# vta/doc.json: the last state, with #key-0/#key-1 replaced by #key-N/#key-N+1
# carrying the new public keys, and authentication, assertionMethod and
# keyAgreement pointing at the new ids
tail -n 1 did/did.jsonl | jq .state > vta/doc.json && $EDITOR vta/doc.json
pnm did-mgmt dids edit --did "$DID" --document vta/doc.json --pre-rotation 2 \
  --label "replace operating keys" --no-confirm
pnm did-mgmt dids realign-keys "$DID"          # key records take the new ids
kill %1
```

Then rebuild `secrets.json` as in step 4d with the new ids in place of
`#key-0`/`#key-1`, starting from the current file
(`sops -d secrets/secrets.sops.json > secrets/secrets.json`) instead of
`setup/conf/secrets.json`, and re-encrypt it.

**Publish** (every case):

```bash
vta did-mgmt dids get-log -c vta/config.toml "$DID" | grep '^{' > did/did.jsonl
tail -n 1 did/did.jsonl > did/did-latest.jsonl
git diff --stat did/did.jsonl                   # earlier lines unchanged, one line added
tar -czf secrets/vta-mediator.tar.gz vta
sops -e --input-type binary --output-type json secrets/vta-mediator.tar.gz > secrets/vta-mediator.sops.json
rm -r vta secrets/vta-mediator.tar.gz           # and secrets/secrets.json, if made
scp did/did.jsonl did/did-latest.jsonl timo@h2980589.stratoserver.net:apps/mediator/did/
# operating keys replaced: also copy secrets.json as in step 6
ssh timo@h2980589.stratoserver.net 'cd ~/apps/mediator && docker compose restart mediator'
```

Then step 8 and step 9, commit `did/did.jsonl`, and store the new
`vta-mediator.sops.json` (and `secrets.sops.json`) in the private repository
and the offline copy. The VTA's state changes with every edit, so an old
archive cannot sign the next update.

Clients resolve `C` when they log in. After replacing the operating keys,
a client that still holds the old document seals its routed deposits to the
old key until it resolves again.

## Checking a change locally

Run this stack against `localhost` before deploying a change to the compose
file, the ACL or the DID handling: the same compose file plus an override
that publishes `127.0.0.1:7237` through a Caddy front with the same two
routes as the Traefik labels, `MEDIATOR_HOST=localhost:7237`,
`LOCAL_ENDPOINTS=http://localhost:7237`, and a DID made for
`http://localhost:7237` (4a with that `--public-url`, or 4c with that
`--did-url`). The probe then needs `MEDIATOR_ALLOW_INSECURE=1`, and Node must
reach `localhost` over IPv4 (`NODE_OPTIONS=--dns-result-order=ipv4first`).
`vti-didcomm-js` 0.13.0 resolves the mediator's DID without the net policy and
refuses a did:webvh on `localhost`; the probe's wire takes a resolver through
its `transport.resolve` seam, so a small `--import` hook that wraps
`createVtiWire` with `resolve(did, { netPolicy: { allowInsecure: true, allowPrivate: true } })`
is enough.

## Updates

The images are pinned by tag and digest, and all three containers carry
`com.centurylinklabs.watchtower.enable=false`. Watchtower on `timo` runs
without `--label-enable`, so without that label it would update this stack
like every other container.

To update:

1. Read the release notes from the current to the new version
   (`gh release list -R affinidi/affinidi-messaging-mediator`). Look for TSP
   wire changes, ACL or config renames, storage migrations, and whether
   `DID_WEB_SELF_HOSTED` accepts a multi-entry log (then `did-log` can go).
2. Get the digest:
   `docker buildx imagetools inspect ghcr.io/affinidi/messaging-mediator:vX.Y.Z`
   (the `Digest:` line of the index).
3. Change `image:` in `docker-compose.yml` (tag and digest), open a PR, run
   the live probe against a local stack ("Checking a change locally").
4. On the server: copy the new compose file, then
   `docker compose pull mediator && docker compose up -d mediator`, then
   step 8 and step 9.
5. Rollback: the previous `image:` line, `docker compose up -d mediator`.
   Redis migrations are forward-only; read the release notes before rolling
   back across a migration.

A change of the TSP version (as from Rev 3 to 1.0 in 0.45.0) has to ship
together with every client: binding, app and `port-experimente`.

Redis (`redis:7.4.11-alpine@sha256:…`) and Caddy
(`caddy:2.11.7-alpine@sha256:…`) are pinned the same way; update them for
security fixes within their minor version.

## Risks

- **Loss of the VTA state:** the log can no longer be changed. A compromised
  key cannot be replaced under the same `C`. The encrypted archive exists in
  the private repository and offline; with one age key it depends on that one
  key (step 3).
- **Loss of `secrets.json` alone:** recoverable from the VTA (operating keys)
  and a new wizard run (JWT key, admin credential).
- **Server compromise:** the attacker holds the operating keys and can read
  routing metadata and impersonate `C` until the keys are replaced (runbook).
  The operating key `#key-0` cannot sign a log update while pre-rotation is
  active, so the attacker cannot take over the DID.
- **Retention:** undelivered messages wait 7 days, then the expiry sweep
  deletes them. A recipient offline for longer loses them; the sender's
  deposit ends `failed` at its 72 h horizon anyway. Redis has a 1 GB cap with
  `noeviction`: when full, new deposits are refused rather than old messages
  dropped. Watch `readyz` and `docker stats mediator-redis`.
- **Rate limits:** the per-IP limit is shared by everyone behind one address.
  At a venue with one NAT (conference Wi-Fi) many devices share 20 req/s.
  Raise `RATE_LIMIT_AVERAGE`/`RATE_LIMIT_BURST` in `.env` if clients see 429.
  A determined client with many addresses is not stopped by it; the
  per-DID limit (`DID_RATE_LIMIT_PER_SECOND`) and the queue limits remain.
- **Open instance:** anyone can create accounts and deposit messages. Abuse
  costs storage and CPU; the levers are the rate limits, the queue limits
  (upstream defaults) and, if needed, `explicit_allow`, which would break
  fresh per-relationship DIDs.
- **Implicit relay:** with relay enabled, any mediator can deliver to our
  users anonymously. `PROCESSOR_FORWARDING_RELAY_TRUSTED_MEDIATORS` narrows
  that for routed hops if it becomes a problem.
- **Accounts stay:** every DID that logs in gets an account record in Redis
  (keyed by the SHA-256 of the DID, ACL flags and queue counters), without
  expiry. Per relationship that is two `did:key`s per side. The records are
  small, but they accumulate; deleting them needs the admin credential
  (`mediator-admin`, upstream `docs/acls.md` §8).
- **Domain:** `C` names the host `mediator.web-of-trust.de`. Losing the
  domain means losing `C`; the DID is portable, so a move to another domain
  is a log update signed by the VTA.

## Privacy notice (draft)

The mediator at mediator.web-of-trust.de is operated by Real Life Org. It
holds encrypted messages until the recipient collects and acknowledges them,
and deletes messages that are not collected after 7 days. It cannot read
message content. To deliver, it processes the connection identifiers (DIDs)
that the app creates for each relationship, which identifier sends to which,
message sizes and times, and the IP address of each connection. For each
identifier that logs in it keeps a small account record (a hash of the
identifier and its delivery settings) until it is deleted. Operational logs
are limited in size (at most 30 MB per service) and overwritten in turn; the
web server keeps no access log. Nothing is passed on to third parties or used
for any other purpose.
