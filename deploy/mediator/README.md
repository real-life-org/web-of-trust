# VTI mediator: mediator.web-of-trust.de

Our own instance of the Affinidi Messaging Mediator, the carrier `C` that the
Web of Trust app uses for VTI transport (TSP 1.0 over the mediator's routed
form). It runs on `timo` (h2980589.stratoserver.net, NixOS, Traefik with
Let's Encrypt) as two containers: the mediator and a Redis store.

| | |
|---|---|
| Image | `ghcr.io/affinidi/messaging-mediator:v0.45.0`, pinned by digest |
| Protocol | TSP 1.0 (`YTSP-BAA`) and DIDComm v2 |
| DID | `did:webvh:<SCID>:mediator.web-of-trust.de`, log served by the mediator at `/.well-known/did.jsonl` |
| Sign-up | open: any DID may authenticate (`explicit_deny`) |
| Default ACL | `DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES,SEND_FORWARDED` |
| Retention | undelivered messages 7 days, deleted on acknowledgement |
| Rate limit | Traefik, per client IP (20 req/s average, burst 60) |
| Updates | manual tag change; Watchtower is switched off for both containers |

Clients must speak TSP 1.0 (`@openvtc/vti-tsp-js` 0.4.0, `@openvtc/vti-didcomm-js`
0.13.0). Per the 0.45.0 release notes a TSP message addressed to the mediator
itself must be TSP 1.0, while Rev 3 messages between endpoints are still
routed: a Rev 3 client (`vti-tsp-js` 0.3.x) can deposit `direct`, but its
routed deposits (addressed to `C`) are refused.

Files in this directory:

| File | Purpose |
|---|---|
| `docker-compose.yml` | mediator + Redis, Traefik labels, configuration as environment |
| `.env.example` | every variable the compose file reads, without values |
| `.sops.yaml` | the two age recipients (Anton, Tillmann) for the secret files |
| `did/did.jsonl` | the mediator's DID log (public; added after the first setup) |
| `secrets/`, `setup/` | local only, git-ignored: plaintext and encrypted secrets, wizard output |

## Configuration

All settings are environment variables in `docker-compose.yml`; the image's
built-in container profile supplies the rest. The settings that make this an
open, routing-capable mediator:

| Variable | Value | Why |
|---|---|---|
| `MEDIATOR_ACL_MODE` | `explicit_deny` | Any DID may authenticate and is registered with the default ACL. Every relationship brings fresh `did:key`s, so a pre-registration list is not workable. |
| `GLOBAL_DEFAULT_ACL` | `DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES,SEND_FORWARDED` | `LOCAL`: own inbox, pickup and WebSocket. `SEND_MESSAGES`/`RECEIVE_MESSAGES`: direct delivery. `SEND_FORWARDED`: deposit a TSP Routed message addressed to the mediator (otherwise error 44 `authorization.send_forwarded`). Nothing else: no invites, no self-management, no admin. |
| `ENABLE_INTER_MEDIATOR_RELAY` | `true` | Accept anonymous relay hops from other mediators on `/inbound`. With `SEND_FORWARDED` in the default ACL the mediator does this anyway (deprecated implicit relay, warns at boot); the explicit flag keeps it working when upstream drops the implicit path. |
| `LOCAL_DIRECT_DELIVERY_ALLOWED` | `true` | A message for a local recipient is stored for pickup. |
| `FORCE_SESSION_DID_MATCH` | `true` | The envelope sender must be the authenticated DID. Our routed form satisfies it. |
| `CORS_ALLOW_ORIGIN` | `*` | Browser and Capacitor clients send an `Origin`; without it they are refused. Endpoints use bearer tokens, not cookies. |
| `LIMIT_MESSAGE_EXPIRY_SECONDS` | `604800` | 7 days; must stay above the 72 h give-up horizon of the VTI profile. |
| `LIMIT_DELIVERED_EXPIRY_SECONDS` | `0` | A collected but unacknowledged message is kept for the full 7 days. |
| `LIMIT_RATE_LIMIT_PER_IP` | `0` | Behind Traefik the mediator sees one address for everyone; the per-IP limit lives in Traefik. |

Upstream references for each: `crates/affinidi-messaging-mediator/conf/mediator.toml`
(the `Env:` lines), `docs/acls.md` §3, §6, §7, `docs/multi-mediator.md` §4–§6,
`docs/cors-and-origin.md` in
[affinidi/affinidi-messaging-mediator](https://github.com/affinidi/affinidi-messaging-mediator/tree/v0.45.0).

## First start

Who does what: steps 1–5 on a laptop with Docker, `sops` and `age`; steps 6–9
on the server as user `timo`. If you log in as `root`, run the server commands
as `timo` (`runuser -u timo -- …`), so files and containers belong to `timo`.

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

### 3. Age keys (once per person)

Anton and Tillmann each:

```bash
age-keygen -o ~/.config/sops/age/keys.txt   # keep this file private
age-keygen -y ~/.config/sops/age/keys.txt   # prints the public key age1…
```

Put both public keys into `.sops.yaml` in place of the placeholders and
commit that change. Each person keeps an offline copy of their own
`keys.txt` (paper or a USB stick in a safe). If both age keys are lost, the
encrypted backup is unreadable.

### 4. Generate the mediator identity

In a local checkout, in this directory (`deploy/mediator/`; `setup/` and
`secrets/` are git-ignored):

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

- `--public-url` must include `https://`. Without the scheme the wizard stops
  with `missing required variable(s): WS_URL`.
- stdout goes to `/dev/null` because the wizard prints the admin private key;
  the same key is stored in `setup/conf/secrets.json`.
- The wizard also writes a `Dockerfile`, `docker-compose.yml` and
  `conf/mediator.toml` into `setup/`. We do not use them; this directory's
  compose file and its environment replace them.

Output we use:

| File | Content | Goes to |
|---|---|---|
| `setup/conf/secrets.json` | JWT signing key, the mediator's operating keys (Ed25519 `#key-0`, X25519 `#key-1`), admin credential | encrypted backup, server `secrets/secrets.json` |
| `setup/conf/did.jsonl` | the did:webvh log (one entry) | git (`did/did.jsonl`), server `did/did.jsonl` |
| `setup/conf/mediator.toml` | only the line `admin_did` | `.env` (`ADMIN_DID`) |

The mediator DID is `state.id` of the log entry:

```bash
cp setup/conf/did.jsonl did/did.jsonl
tail -n 1 did/did.jsonl | jq -r .state.id
# did:webvh:<SCID>:mediator.web-of-trust.de   (about 75 characters)
grep '^admin_did' setup/conf/mediator.toml   # did://did:key:z6Mk…
```

The SCID is a hash over the first log entry, so every run of the wizard
yields a new DID. Run it once; the DID that goes live is `C` for every
relationship formed through this instance.

Check that the log carries the TSP endpoint:

```bash
tail -n 1 did/did.jsonl | jq '.state.service[] | select(.type | index("TSPTransport"))'
# { "id": "did:webvh:…#tsp", "serviceEndpoint": "https://mediator.web-of-trust.de/mediator/v1", "type": ["TSPTransport"] }
```

Also present: `#service` (`DIDCommMessaging`, https and `wss://…/mediator/v1/ws`)
and `#auth` (`Authentication`, `…/authenticate`).

### 5. Encrypt the secrets

```bash
cp setup/conf/secrets.json secrets/secrets.json
cat > secrets/mediator.env <<EOF
MEDIATOR_HOST=mediator.web-of-trust.de
MEDIATOR_DID=$(tail -n 1 did/did.jsonl | jq -r .state.id)
ADMIN_DID=$(sed -n 's/^admin_did = "did:\/\/\(.*\)"/\1/p' setup/conf/mediator.toml)
MEDIATOR_UID=
MEDIATOR_GID=
REDIS_PASSWORD=$(openssl rand -hex 32)
EOF
sops -e secrets/secrets.json > secrets/secrets.sops.json
sops -e --input-type dotenv --output-type dotenv secrets/mediator.env > secrets/mediator.sops.env
```

`MEDIATOR_UID`/`MEDIATOR_GID` are filled on the server (step 7). Store
`secrets/secrets.sops.json` and `secrets/mediator.sops.env` where both
Anton and Tillmann can reach them, not in a public repository, plus one
offline copy (see "Backup"). Then commit `did/did.jsonl` and remove the
plaintext: `rm -r setup secrets/secrets.json secrets/mediator.env`.

### 6. Copy files to the server

```bash
ssh timo@h2980589.stratoserver.net 'mkdir -p ~/apps/mediator/did ~/apps/mediator/secrets && chmod 700 ~/apps/mediator/secrets'
scp docker-compose.yml did/did.jsonl timo@h2980589.stratoserver.net:apps/mediator/
ssh timo@h2980589.stratoserver.net 'mv ~/apps/mediator/did.jsonl ~/apps/mediator/did/'
sops -d secrets/secrets.sops.json | ssh timo@h2980589.stratoserver.net 'umask 077; cat > ~/apps/mediator/secrets/secrets.json'
sops -d secrets/mediator.sops.env | ssh timo@h2980589.stratoserver.net 'umask 077; cat > ~/apps/mediator/.env'
```

The decrypted files exist only on the server, mode 0600, owned by `timo`.

### 7. Start

On the server:

```bash
cd ~/apps/mediator
sed -i "s/^MEDIATOR_UID=.*/MEDIATOR_UID=$(id -u)/; s/^MEDIATOR_GID=.*/MEDIATOR_GID=$(id -g)/" .env
docker compose config -q && docker compose up -d
docker compose ps          # both "healthy" after about 20 s
docker logs mediator 2>&1 | grep -E '"level":"(WARN|ERROR)"'
```

Expected warnings: plaintext `file://` secret backend, no TLS on the
container port (Traefik terminates TLS), Redis without TLS (internal network),
`trust_task_verification = "warn"`, the deprecated `functions_file` fallback
of the upstream image profile. Anything else, in particular a missing
`TSPTransport` service, needs a look.

If step 2 is not active yet: `docker network connect mediator-edge traefik`.

### 8. Check from outside

```bash
H=https://mediator.web-of-trust.de
curl -s $H/mediator/v1/healthchecker   # {"message":"… Version: 0.45.0, Started: …","status":"success"}
curl -s $H/mediator/v1/readyz | jq .status            # "ready"
curl -s $H/.well-known/did.jsonl | tail -n 1 | jq -r .state.id   # equals MEDIATOR_DID
curl -s $H/.well-known/did.jsonl | tail -n 1 | jq '.state.service[] | select(.type | index("TSPTransport")) | .serviceEndpoint'
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
```

Pass: `delivery-ack B→A: delivered=yes`, trias `accepted → delivered`.
Then `RLTP_WIRE_DEPOSIT=egress-session` for the fallback form.

## Backup

What must survive, and where it lives:

| What | Loss means | Kept |
|---|---|---|
| `secrets.json` (operating keys of `C`, JWT key, admin credential) | **New `C`.** Every relationship formed through this instance is no longer carried. | `secrets.sops.json` in a private place reachable by Anton and Tillmann, plus one offline copy |
| `.env` (Redis password, DIDs) | Recoverable: new Redis password, DIDs are public | `mediator.sops.env` next to it |
| `did/did.jsonl` | Recoverable from git or `/.well-known/did.jsonl` | this repository |
| age private keys | Both lost: the encrypted backup is unreadable | each person, offline |
| Redis volume `mediator-redis-data` | Waiting messages are gone; accounts are recreated at the next login; senders see their deposits end `failed` at the horizon | not backed up |

Check the backup after the first start: decrypt `secrets.sops.json` on the
second person's machine and compare its SHA-256 with the server file.

**The DID log cannot be updated.** `mediator-setup` creates the did:webvh
log with a fresh update key and a pre-rotation commitment, but stores
neither private key: `setup/conf/secrets.json` holds only the operating keys.
The log therefore stays at version 1 for good. A key rotation, a new
service endpoint or a recovery after compromise all mean a new `C`. To keep
the option of updating the log, the DID would have to be generated with a
tool that keeps the update keys (or through a VTA), and the operating keys
written into `secrets.json` by hand (upstream `docs/secrets-backend.md`,
"Provisioning without the wizard").

## Updates

The image is pinned by tag and digest, and both containers carry
`com.centurylinklabs.watchtower.enable=false`. Watchtower on `timo` runs
without `--label-enable`, so without that label it would update this stack
like every other container.

To update:

1. Read the release notes from the current to the new version
   (`gh release list -R affinidi/affinidi-messaging-mediator`). Look for TSP
   wire changes, ACL or config renames, and storage migrations.
2. Get the digest:
   `docker buildx imagetools inspect ghcr.io/affinidi/messaging-mediator:vX.Y.Z`
   (the `Digest:` line of the index).
3. Change `image:` in `docker-compose.yml` (tag and digest), open a PR, run
   the live probe against a local stack where possible.
4. On the server: copy the new compose file, then
   `docker compose pull mediator && docker compose up -d mediator`, then
   step 8 and step 9.
5. Rollback: the previous `image:` line, `docker compose up -d mediator`.
   Redis migrations are forward-only; read the release notes before rolling
   back across a migration.

A change of the TSP version (as from Rev 3 to 1.0 in 0.45.0) has to ship
together with every client: binding, app and `port-experimente`.

Redis is pinned the same way (`redis:7.4.11-alpine@sha256:…`); update it
for security fixes within 7.4.

## Risks

- **Loss of `secrets.json`:** the operating keys are `C`. Without them a new
  DID, and every relationship formed through this instance is no longer
  carried (relationship hints name `C` and are only read at first contact).
  Two encrypted copies and an offline copy; see "Backup".
- **No DID update path:** see "Backup". A compromised key cannot be rotated
  under the same `C`.
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
  domain means losing `C`.

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
