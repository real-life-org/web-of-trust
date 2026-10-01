# @web_of_trust/adapter-automerge

Alternative CRDT adapter for Web of Trust — Rust compiled to WebAssembly.

Implements the `ReplicationAdapter` and personal document interfaces from `@web_of_trust/core` using [Automerge](https://automerge.org). Available as a drop-in alternative to `@web_of_trust/adapter-yjs`. The Yjs adapter is the default; use this one when Automerge semantics or tooling are specifically required.

> **Note:** Automerge's Rust→WASM runtime (1.7 MB) blocks the main thread on mobile devices. Measured: ~6.4 s initialisation on Android vs ~85 ms for Yjs. Only use this adapter on desktop-only deployments or when you need Automerge's specific merge semantics.

## Installation

```bash
pnpm add @web_of_trust/adapter-automerge
```

Requires `@web_of_trust/core` as a peer dependency.

## Key Features

- **AutomergeReplicationAdapter** — encrypted shared spaces using `automerge-repo` `DocHandle`s
- **PersonalDocManager** — personal data stored in an Automerge document with `Automerge.save()` snapshots
- **CompactionService** — two-phase compaction with yield points to reduce UI freeze on WASM-constrained devices
- **AutomergePersonalLogSyncAdapter** — multi-device sync for the personal document over the Sync 002/003 log path
- **SyncOnlyStorageAdapter** — stores automerge-repo sync states without the full document binary

## API Overview

### Personal Document

```typescript
import {
  initPersonalDoc,
  getPersonalDoc,
  changePersonalDoc,
  onPersonalDocChange,
  flushPersonalDoc,
} from '@web_of_trust/adapter-automerge'

// Initialise (loads snapshot from IndexedDB / Vault). The fourth argument
// enables multi-device sync over the Sync 002/003 log path; `messaging` must
// support control frames (`sendControlFrame`, e.g. WebSocket → Outbox).
await initPersonalDoc(identity, messaging, vaultUrl, { docLogStore, deviceId })

// Read
const doc = getPersonalDoc()
const contact = doc.contacts['did:key:z6Mk...']

// Mutate
changePersonalDoc((doc) => {
  doc.profile.name = 'Alice'
})

// Subscribe to changes
const unsub = onPersonalDocChange(() => {
  const latest = getPersonalDoc()
})

// Persist immediately (normally automatic)
await flushPersonalDoc()
```

### Replication Adapter (Shared Spaces)

```typescript
import { AutomergeReplicationAdapter } from '@web_of_trust/adapter-automerge'

const replication = new AutomergeReplicationAdapter({
  identity,            // PublicIdentitySession
  messaging,           // MessagingAdapter with sendControlFrame (e.g. WebSocket → Outbox)
  brokerUrls,          // string[] — home relay(s)
  docLogStore,         // DocLogStore — durable per-device log; enables replication
  deviceId,            // string — the deviceId the store is bound to
  keyManagement,       // KeyManagementPort (optional, defaults to InMemoryKeyManagementAdapter)
  metadataStorage,     // SpaceMetadataStorage (optional)
  compactStore,        // CompactStore (optional, IDB-backed)
  vaultUrl,            // string (optional)
})
// Replication runs over the Sync 002/003 log path; the automerge-repo Repo has
// no network adapter. Without `docLogStore` the adapter is local-only.

// Open a space
const handle = await replication.openSpace<{ notes: string }>(spaceInfo)

// Read
const doc = handle.getDoc()

// Mutate
await handle.transact((doc) => {
  doc.notes = 'Hello from Alice'
})

// React to remote updates
handle.onRemoteUpdate(() => {
  console.log('Remote change:', handle.getDoc())
})

handle.close()
```

### Compaction Service

The `CompactionService` strips Automerge history to keep snapshots small. It runs in the background with `yield` points to avoid long WASM freezes:

```typescript
import { CompactionService } from '@web_of_trust/adapter-automerge'

const compaction = new CompactionService()
const compact = await compaction.compact(automergeDoc)
// compact is a fresh Automerge.Doc with history stripped
```

## Migration to 0.3

0.3 removes the Old-World channel (wot#386); the relay never accepted it.

- `enableLogSync` is gone — drop it from the `AutomergeReplicationAdapter` config.
- `EncryptedMessagingNetworkAdapter` and `PersonalNetworkAdapter` are removed (no longer exported).
- Personal-doc sync across own devices: instead of `PersonalNetworkAdapter`, pass the log-sync options as the fourth argument — `initPersonalDoc(identity, messaging, vaultUrl, { docLogStore, deviceId })` — with a control-frame-capable `messaging` adapter.

## How to Run

```bash
# Build (watch mode during development)
pnpm dev

# Build once
pnpm build

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch
```

## CRDT Switch

```bash
# Use Automerge in the demo app
VITE_CRDT=automerge pnpm dev:demo

# Default is Yjs (no variable needed)
pnpm dev:demo
```

Vite config must mark `@automerge/automerge` as external to avoid bundling the WASM twice:

```typescript
// vite.config.ts
build: {
  rollupOptions: {
    external: ['@automerge/automerge'],
  },
}
```

## Main Repo

[github.com/antontranelis/web-of-trust](https://github.com/antontranelis/web-of-trust)
