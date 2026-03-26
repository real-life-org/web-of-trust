# @web.of.trust/adapter-yjs

Default CRDT adapter for Web of Trust — pure JavaScript, no WASM required.

Implements the `ReplicationAdapter` and personal document interfaces from `@web.of.trust/core` using [Yjs](https://yjs.dev). Chosen as the default CRDT after benchmarking showed 76x faster initialisation on Android compared to the Automerge/WASM alternative.

## Installation

```bash
pnpm add @web.of.trust/adapter-yjs
```

Requires `@web.of.trust/core` as a peer dependency.

## Key Features

- **Pure JavaScript** — no WASM, no worker, no WASM bundle (69 KB vs 1.7 MB)
- **YjsPersonalDocManager** — personal data (profile, contacts, attestations, group keys) stored in a `Y.Doc` with proxy-based mutation API
- **YjsReplicationAdapter** — encrypted shared spaces backed by `Y.Doc`, drop-in replacement for the Automerge adapter
- **YjsPersonalSyncAdapter** — multi-device sync for the personal document via the Relay
- **Built-in garbage collection** — `ydoc.gc = true`; no history-stripping hack needed
- **CRDT-agnostic persistence** — serialises to `Uint8Array` via `Y.encodeStateAsUpdate()`, stored in CompactStore (IndexedDB) and Vault

## API Overview

### Personal Document

```typescript
import {
  initYjsPersonalDoc,
  getYjsPersonalDoc,
  changeYjsPersonalDoc,
  onYjsPersonalDocChange,
  flushYjsPersonalDoc,
} from '@web.of.trust/adapter-yjs'

// Initialise (loads from CompactStore / Vault on first call)
await initYjsPersonalDoc({ identity, compactStore, vaultClient })

// Read
const doc = getYjsPersonalDoc()
const contact = doc.contacts['did:key:z6Mk...']

// Mutate (proxy-based — plain assignment works)
changeYjsPersonalDoc((doc) => {
  doc.profile.name = 'Alice'
  doc.contacts['did:key:z6Mk...'] = { did: '...', name: 'Bob', ... }
})

// Subscribe to changes
const unsub = onYjsPersonalDocChange(() => {
  const latest = getYjsPersonalDoc()
  // re-render
})

// Persist immediately (normally automatic)
await flushYjsPersonalDoc()
```

### Replication Adapter (Shared Spaces)

```typescript
import { YjsReplicationAdapter } from '@web.of.trust/adapter-yjs'

const replication = new YjsReplicationAdapter({
  identity,            // WotIdentity
  messaging,           // MessagingAdapter
  groupKeyService,     // GroupKeyService
  metadataStorage,     // SpaceMetadataStorage (optional)
  compactStore,        // YjsCompactStore (optional, IDB-backed)
  vaultUrl,            // string (optional)
})

// Open a space (creates Y.Doc if new, restores if known)
const handle = await replication.openSpace<{ notes: string }>(spaceInfo)

// Read current state
const doc = handle.getDoc()

// Mutate
await handle.transact((doc) => {
  doc.notes = 'Hello from Alice'
})

// React to remote updates
handle.onRemoteUpdate(() => {
  console.log('Remote change received:', handle.getDoc())
})

// Close when done
handle.close()
```

### Personal Sync (Multi-Device)

```typescript
import { YjsPersonalSyncAdapter } from '@web.of.trust/adapter-yjs'

const sync = new YjsPersonalSyncAdapter({ identity, messaging, compactStore })
await sync.start()
// Encrypted Y.Doc updates are now forwarded to / from other devices via the Relay
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

The demo app selects adapters via the `VITE_CRDT` environment variable:

```bash
# Default — uses adapter-yjs
pnpm dev:demo

# Switch to Automerge
VITE_CRDT=automerge pnpm dev:demo
```

Both adapters pass the same 7 end-to-end Playwright tests.

## Main Repo

[github.com/antontranelis/web-of-trust](https://github.com/antontranelis/web-of-trust)
