# @web.of.trust/adapter-automerge

Alternative CRDT adapter for Web of Trust — Rust compiled to WebAssembly.

Implements the `ReplicationAdapter` and personal document interfaces from `@web.of.trust/core` using [Automerge](https://automerge.org). Available as a drop-in alternative to `@web.of.trust/adapter-yjs`. The Yjs adapter is the default; use this one when Automerge semantics or tooling are specifically required.

> **Note:** Automerge's Rust→WASM runtime (1.7 MB) blocks the main thread on mobile devices. Measured: ~6.4 s initialisation on Android vs ~85 ms for Yjs. Only use this adapter on desktop-only deployments or when you need Automerge's specific merge semantics.

## Installation

```bash
pnpm add @web.of.trust/adapter-automerge
```

Requires `@web.of.trust/core` as a peer dependency.

## Key Features

- **AutomergeReplicationAdapter** — encrypted shared spaces using `automerge-repo` `DocHandle`s
- **PersonalDocManager** — personal data stored in an Automerge document with `Automerge.save()` snapshots
- **CompactionService** — two-phase compaction with yield points to reduce UI freeze on WASM-constrained devices
- **PersonalNetworkAdapter** — multi-device sync for the personal document via the Relay
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
} from '@web.of.trust/adapter-automerge'

// Initialise (loads snapshot from CompactStore / Vault)
await initPersonalDoc({ identity, compactStore, vaultClient })

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
import { AutomergeReplicationAdapter } from '@web.of.trust/adapter-automerge'

const replication = new AutomergeReplicationAdapter({
  identity,            // WotIdentity
  messaging,           // MessagingAdapter
  groupKeyService,     // GroupKeyService
  metadataStorage,     // SpaceMetadataStorage (optional)
  compactStore,        // CompactStore (optional, IDB-backed)
  vaultUrl,            // string (optional)
})

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
import { CompactionService } from '@web.of.trust/adapter-automerge'

const compaction = new CompactionService()
const compact = await compaction.compact(automergeDoc)
// compact is a fresh Automerge.Doc with history stripped
```

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
