# wot-relay

WebSocket relay server for real-time message delivery in the Web of Trust.

Routes encrypted message envelopes between DIDs, persists undelivered messages in SQLite, and redelivers them when a recipient reconnects. The server is blind — it only sees sender and recipient DIDs, never message content.

## Key Features

- **DID-based routing** — clients register their `did:key` identifier; the relay routes by recipient DID
- **Delivery ACK protocol** — messages persist in SQLite until the recipient sends an explicit ACK; redelivered on reconnect
- **Multi-device** — multiple simultaneous connections per DID are supported
- **Heartbeat** — ping/pong keepalive detects and cleans up dead connections
- **Envelope auth** — Ed25519-signed envelopes; sender identity is verified before forwarding
- **CRDT-agnostic** — forwards any opaque bytes; works with Yjs, Automerge, or any future CRDT
- **SQLite** — lightweight message queue via `better-sqlite3`
- **Default port:** 9700
- **Deployed at:** `wss://relay.utopia-lab.org`

## WebSocket Protocol

All messages are JSON over a single persistent WebSocket connection.

```jsonc
// Step 1 — register (must be first message)
// Client → Relay
{ "type": "register", "did": "did:key:z6Mk..." }

// Relay → Client (queued + unacked messages are immediately delivered)
{ "type": "registered", "did": "did:key:z6Mk...", "peers": 0 }
{ "type": "message", "envelope": { "toDid": "...", "id": "uuid", ... } }

// Step 2 — send a message
// Client → Relay
{ "type": "send", "envelope": { "toDid": "did:key:z6Mk...", "id": "uuid", ... } }

// Relay → Sender (status: "delivered" if recipient online, "accepted" if queued)
{ "type": "receipt", "receipt": { "messageId": "uuid", "status": "delivered", "timestamp": "..." } }

// Relay → Recipient
{ "type": "message", "envelope": { ... } }

// Step 3 — acknowledge receipt (removes message from queue)
// Client → Relay
{ "type": "ack", "messageId": "uuid" }

// Keepalive
{ "type": "ping" }   // Client → Relay
{ "type": "pong" }   // Relay → Client
```

## Programmatic Usage (tests / embedding)

```typescript
import { RelayServer } from '@web.of.trust/relay'

const relay = new RelayServer({ port: 9700, dbPath: './relay.db' })
await relay.start()

console.log(relay.connectedDids) // currently registered DIDs

await relay.stop()
```

## How to Run

```bash
# Development (tsx, auto-restarts on change)
pnpm dev

# Build
pnpm build

# Start compiled server
pnpm start

# Run tests (24 tests)
pnpm test
```

Environment variables:

| Variable  | Default          | Description            |
|-----------|------------------|------------------------|
| `PORT`    | `9700`           | WebSocket listen port  |
| `DB_PATH` | `relay-queue.db` | SQLite database path   |

## Docker

```bash
cd packages/wot-relay
docker compose up -d
```

## Main Repo

[github.com/antontranelis/web-of-trust](https://github.com/antontranelis/web-of-trust)
