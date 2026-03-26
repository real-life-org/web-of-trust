# wot-vault

HTTP service for encrypted document backup in the Web of Trust.

Stores opaque encrypted blobs on behalf of clients. The server never decrypts anything — it only persists bytes and returns them. Clients use it to restore their personal document on a new device, with a 5-second debounce on pushes to avoid excessive writes.

## Key Features

- **Snapshot-replace pattern** — each push replaces the previous snapshot; no incremental merge on the server side
- **Auth via signed capability tokens** — UCAN-inspired, offline-verifiable; no account system needed
- **Append-only change log** — `POST /docs/{docId}/changes` for incremental updates alongside snapshots
- **CRDT-agnostic** — stores any encrypted `Uint8Array`; works with Yjs, Automerge, or any CRDT
- **SQLite** — persistence via `better-sqlite3`
- **Default port:** 8789
- **Health check:** `GET /health`

## REST API

All endpoints require two headers:

- `Authorization: <identity JWS>` — proves who you are (your DID)
- `X-Capability: <signed capability token>` — proves you are allowed to access this document

All request/response bodies are binary (base64-encoded in JSON where applicable).

### Endpoints

| Method   | Path                        | Description                          |
|----------|-----------------------------|--------------------------------------|
| `POST`   | `/docs/{docId}/changes`     | Append an encrypted change           |
| `GET`    | `/docs/{docId}/changes`     | Fetch changes (optional `?since=N`)  |
| `PUT`    | `/docs/{docId}/snapshot`    | Replace snapshot                     |
| `GET`    | `/docs/{docId}/info`        | Document metadata (seq, size, dates) |
| `DELETE` | `/docs/{docId}`             | Delete document and all changes      |
| `GET`    | `/health`                   | Health check                         |

### Push a snapshot

```http
PUT /docs/personal-doc-alice HTTP/1.1
Authorization: <identity JWS>
X-Capability: <capability token>
Content-Type: application/json

{ "data": "<base64-encoded encrypted bytes>", "upToSeq": 42 }
```

Response `200`:
```json
{ "docId": "personal-doc-alice", "upToSeq": 42 }
```

### Restore from snapshot

```http
GET /docs/personal-doc-alice/changes HTTP/1.1
Authorization: <identity JWS>
X-Capability: <capability token>
```

Response `200`:
```json
{
  "docId": "personal-doc-alice",
  "snapshot": { "data": "<base64>", "upToSeq": 42 },
  "changes": []
}
```

### Using VaultClient from wot-core

The `VaultClient` service in `@web.of.trust/core` wraps these endpoints:

```typescript
import { VaultClient } from '@web.of.trust/core'

const vault = new VaultClient({
  baseUrl: 'https://vault.example.org',
  identity,        // WotIdentity — used to sign auth headers
  getCapability,   // () => Promise<string> — signed capability token
})

// Push snapshot (called by VaultPushScheduler with 5s debounce)
await vault.putSnapshot(docId, encryptedBytes, upToSeq)

// Restore
const result = await vault.getChanges(docId)
// result.snapshot.data — Uint8Array, decrypt on client

// Delete
await vault.deleteDoc(docId)
```

## How to Run

```bash
# Development (tsx, auto-restarts on change)
pnpm dev

# Build
pnpm build

# Start compiled server
pnpm start

# Run tests (27 tests)
pnpm test
```

Environment variables:

| Variable  | Default    | Description          |
|-----------|------------|----------------------|
| `PORT`    | `8789`     | HTTP listen port     |
| `DB_PATH` | `vault.db` | SQLite database path |

## Docker

```bash
cd packages/wot-vault
docker compose up -d
```

## Main Repo

[github.com/antontranelis/web-of-trust](https://github.com/antontranelis/web-of-trust)
