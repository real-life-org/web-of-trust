# wot-profiles

HTTP service for public profile discovery in the Web of Trust.

Stores and serves JWS-signed public profiles, verified contacts, and published attestations. Implements the server side of the `HttpDiscoveryAdapter` — the answer to "who is this DID?" before you are in direct contact with someone.

All data is Ed25519-signed by the profile owner. The server verifies the signature on write and rejects mismatches between the URL DID and the payload DID. Clients re-verify signatures on read. No account system — the cryptographic signature is the authorisation.

## Key Features

- **JWS-signed profiles** — Ed25519, `did:key` based; server validates on every PUT
- **Standalone JWS verification** — `jws-verify.ts` implements Ed25519 + `did:key` resolution using only the Web Crypto API; no `wot-core` runtime dependency
- **Three resource types** per DID: profile, verifications, attestations (separate endpoints)
- **Batch summary endpoint** — resolve up to 100 DIDs in a single request
- **SQLite** — three tables (`profiles`, `verifications`, `attestations`) via `better-sqlite3`
- **Default port:** 8788
- **Deployed at:** `https://profiles.utopia-lab.org`

## REST API

All endpoints support CORS (`*`). Bodies are compact JWS strings (`application/jws`).

### Endpoints

| Method | Path           | Description                        |
|--------|----------------|------------------------------------|
| `GET`  | `/p/{did}`     | Fetch signed profile               |
| `PUT`  | `/p/{did}`     | Publish signed profile             |
| `GET`  | `/p/{did}/v`   | Fetch signed verifications list    |
| `PUT`  | `/p/{did}/v`   | Publish signed verifications list  |
| `GET`  | `/p/{did}/a`   | Fetch signed attestations list     |
| `PUT`  | `/p/{did}/a`   | Publish signed attestations list   |
| `GET`  | `/s?dids=...`  | Batch summaries (comma-separated)  |

### Publish a profile

```http
PUT /p/did:key:z6Mk... HTTP/1.1
Content-Type: application/jws

eyJhbGciOiJFZERTQSJ9.eyJkaWQiOiJkaWQ6a2V5Oi4uLiIsIm5hbWUiOiJBbGljZSJ9.<sig>
```

The server checks: body non-empty → valid JWS → `payload.did` matches URL DID → Ed25519 signature valid → `200 OK`.

### Fetch a profile

```http
GET /p/did:key:z6Mk... HTTP/1.1
```

Response `200` with `Content-Type: application/jws` — the raw JWS string, or `404` if not found.

### Batch summaries

```http
GET /s?dids=did:key:z6MkA...,did:key:z6MkB... HTTP/1.1
```

Response `200`:
```json
[
  { "did": "did:key:z6MkA...", "name": "Alice", "avatar": "data:image/..." },
  { "did": "did:key:z6MkB...", "name": "Bob",   "avatar": null             }
]
```

### Using HttpDiscoveryAdapter from wot-core

```typescript
import { HttpDiscoveryAdapter, OfflineFirstDiscoveryAdapter } from '@real-life/wot-core'

const http = new HttpDiscoveryAdapter({
  baseUrl: 'https://profiles.utopia-lab.org',
  identity,      // WotIdentity — used to sign profile JWS on publish
})

// Wrap with offline cache (recommended)
const discovery = new OfflineFirstDiscoveryAdapter(http, cacheStore)

// Publish own profile
await discovery.publishProfile({ name: 'Alice', bio: '...' })

// Look up another DID
const profile = await discovery.lookupProfile('did:key:z6Mk...')
```

### JWS Payload Formats

**Profile:**
```json
{
  "did": "did:key:z6Mk...",
  "name": "Alice",
  "bio": "Short bio",
  "avatar": "data:image/png;base64,...",
  "updatedAt": "2026-03-15T12:00:00Z"
}
```

**Verifications / Attestations** follow the same wrapper with a `verifications` or `attestations` array.

## How to Run

```bash
# Development (tsx, auto-restarts on change)
pnpm dev

# Build
pnpm build

# Start compiled server
pnpm start

# Run tests (25 tests)
pnpm test
```

Environment variables:

| Variable  | Default        | Description          |
|-----------|----------------|----------------------|
| `PORT`    | `8788`         | HTTP listen port     |
| `DB_PATH` | `profiles.db`  | SQLite database path |

## Docker

```bash
cd packages/wot-profiles
docker compose up -d
```

Persistence via Docker volume mounted at `/data/profiles.db`.

## Main Repo

[github.com/antontranelis/web-of-trust](https://github.com/antontranelis/web-of-trust)
