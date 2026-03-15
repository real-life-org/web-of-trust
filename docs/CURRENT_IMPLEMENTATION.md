# Current Implementation

> **Note:** This is NOT a specification — it documents the current implementation status.
> The specification can be found in [docs/flows/](./flows/) and other spec documents.

## Last Updated

**Date:** 2026-03-15
**Phase:** Yjs Migration + CRDT Benchmarks
**Demo:** https://web-of-trust.de/demo/
**Relay:** wss://relay.utopia-lab.org
**Profiles:** https://profiles.utopia-lab.org
**Benchmark:** https://web-of-trust.de/demo/benchmark

---

## Architecture Overview

### 7-Adapter Architecture (v2)

```
┌─────────────────────────────────────────────────────────────┐
│                      Demo App (React)                        │
│  Hooks: useContacts, useProfile, useAttestations, ...       │
├─────────────────────────────────────────────────────────────┤
│                    StorageAdapter                             │
│  AutomergeStorageAdapter | YjsStorageAdapter                 │
├───────┬───────┬───────┬───────┬────────┬────────┬───────────┤
│Storage│Reactiv│Crypto │Discov.│Messag. │Replic. │ Authoriz. │
│       │Storage│       │       │        │        │           │
├───────┴───────┴───────┴───────┴────────┴────────┴───────────┤
│               Infrastructure (CRDT-agnostic)                 │
│   Relay (WebSocket)  │  Vault (HTTP)  │  Profiles (HTTP)    │
└─────────────────────────────────────────────────────────────┘
```

### CRDT Choice: Yjs (Default) + Automerge (Option)

**Yjs has been the default CRDT since 2026-03-15.** Automerge remains available via `VITE_CRDT=automerge`.

**Reason:** Automerge (Rust→WASM) blocks the main thread on mobile:
- `repo.import()`: ~5s for 163KB on Android
- `Automerge.from()` compaction: ~6.5s
- Total: 30s+ UI freeze

**Yjs (pure JavaScript)** solves the problem:
- 76x faster init on mobile (85ms vs 6.4s)
- 632x faster batch mutations (3ms vs 1.9s)
- 69KB bundle instead of 1.7MB
- Built-in garbage collection (no history-strip hack needed)
- In-browser benchmark: `/benchmark`

### Four-Way Architecture

| Component | Purpose | CRDT-agnostic? |
|---|---|---|
| **CompactStore** (IDB) | Local snapshots | Yes — stores bytes |
| **Relay** (WebSocket) | Real-time sync | Yes — forwards envelopes |
| **Vault** (HTTP) | Encrypted backup | Yes — stores encrypted bytes |
| **wot-profiles** (HTTP) | Discovery | Yes — profile server |

### Three Sharing Patterns

1. **Group Spaces** — CRDT-based collaboration (ReplicationAdapter)
2. **Selective Sharing** — Item-level encryption keys
3. **1:1 Delivery** — Attestations, verifications via Relay

---

## Identity System

### WotIdentity (`packages/wot-core/src/identity/WotIdentity.ts`)

- **BIP39 Mnemonic** — 12-word recovery phrase (128-bit), German wordlist (dys2p/wordlists-de)
- **HKDF Master Key** — Non-extractable CryptoKey, hardware isolation when available
- **Ed25519** — Signing (@noble/ed25519)
- **X25519** — Key agreement (ECDH, separate HKDF path)
- **did:key** — Standard W3C Decentralized Identifier
- **JWS Signing** — `signJws()` for profiles, capabilities
- **Encrypted Seed Storage** — PBKDF2 (600k) + AES-GCM in IndexedDB

```typescript
// API
create(passphrase, storeSeed): Promise<{ mnemonic, did }>
unlock(mnemonic, passphrase, storeSeed): Promise<void>
unlockFromStorage(passphrase): Promise<void>
sign(data): Promise<string>
signJws(payload): Promise<string>
getDid(): string
getPublicKeyMultibase(): Promise<string>
deriveFrameworkKey(info): Promise<Uint8Array>
```

### Multi-Device

Same BIP39 seed on all devices → same DID, same key. No login token, no server.

---

## Personal Document (PersonalDoc)

### Data Model

The PersonalDoc stores all private user data as a CRDT document:

```typescript
PersonalDoc {
  profile:             { did, name, bio, avatar, ... }
  contacts:            { [did]: ContactDoc }
  verifications:       { [id]: VerificationDoc }
  attestations:        { [id]: AttestationDoc }
  attestationMetadata: { [id]: { accepted, deliveryStatus } }
  outbox:              { [id]: OutboxEntryDoc }
  spaces:              { [id]: SpaceMetadataDoc }
  groupKeys:           { [spaceId:gen]: GroupKeyDoc }
}
```

### Two Implementations

#### YjsPersonalDocManager (Default)

`packages/wot-core/src/storage/YjsPersonalDocManager.ts`

- **Pure JavaScript** — no WASM, no worker needed
- **Y.Doc** with Y.Maps for each sub-collection
- **Proxy-based API** — `doc.contacts[did] = {...}` works as expected
- **Built-in GC** — `ydoc.gc = true`, no history-strip, no CompactionService
- **Serialization:** `Y.encodeStateAsUpdate()` → CompactStore (IDB)
- **Multi-device sync:** `YjsPersonalSyncAdapter` (encrypted updates via Relay)
- **Vault integration:** Snapshot push/restore

#### PersonalDocManager (Automerge, Option)

`packages/wot-core/src/storage/PersonalDocManager.ts`

- **Rust→WASM** — Automerge.load(), Automerge.save()
- **CompactionService** — Two-phase save with yields (reduces UI freeze)
- **Multi-device sync:** `PersonalNetworkAdapter` (automerge-repo sync)
- **Vault integration:** Snapshot push/restore

### Persistence Chain

```
App change → CRDT mutate → CompactStore (IDB, immediate)
                          → Relay (encrypted, immediate)
                          → Vault (encrypted, 5s debounce)
```

---

## Adapters

### 1. StorageAdapter + ReactiveStorageAdapter

Interface for CRUD on Identity, Contacts, Verifications, Attestations.

**Implementations:**
- `AutomergeStorageAdapter` (Demo App) — uses PersonalDocManager
- `YjsStorageAdapter` (Demo App) — uses YjsPersonalDocManager

### 2. CryptoAdapter

`WebCryptoAdapter` — Ed25519 sign/verify, X25519 ECDH, AES-256-GCM symmetric, HKDF.

### 3. DiscoveryAdapter

Find and publish public profiles.

- `HttpDiscoveryAdapter` — HTTP REST against wot-profiles server
- `OfflineFirstDiscoveryAdapter` — Cache wrapper with dirty flags

### 4. MessagingAdapter

Cross-user messaging via WebSocket Relay.

- `WebSocketMessagingAdapter` — WebSocket client, heartbeat (ping/pong), **message buffer** (CRDT-agnostic, buffers early messages before handlers are registered)
- `OutboxMessagingAdapter` — Decorator, queues messages until relay is reachable
- `InMemoryMessagingAdapter` — Shared bus for tests

### 5. ReplicationAdapter

CRDT-based group spaces with E2EE.

- `AutomergeReplicationAdapter` — Automerge + EncryptedSyncService + GroupKeyService
- `YjsReplicationAdapter` — Yjs + EncryptedSyncService + GroupKeyService

Interface: `SpaceHandle<T>` with `getDoc()`, `transact()`, `onRemoteUpdate()`, `close()`.

### 6. AuthorizationAdapter

UCAN-inspired capabilities.

- `InMemoryAuthorizationAdapter` — for tests/POC
- `crypto/capabilities.ts` — create, verify, delegate, extract. SignFn pattern (private key stays encapsulated).

### 7. SpaceMetadataStorage

Persistence for space info and group keys.

- `IndexedDBSpaceMetadataStorage` — CRDT-agnostic, own IDB
- `AutomergeSpaceMetadataStorage` — in PersonalDoc (legacy)

---

## Services

### ProfileService
Publish and verify JWS-signed profiles (`signProfile`, `verifyProfile`).

### EncryptedSyncService
Encrypt/decrypt CRDT changes with AES-256-GCM. CRDT-agnostic.

### GroupKeyService
Group key management — generation, rotation, generations. One key per space.

### GraphCacheService
Batch profile resolution for trust graph visualization.

### AttestationDeliveryService
Attestation → encrypt → send via messaging → track delivery status.

### VaultClient
HTTP client for wot-vault server (snapshots, changes, info, delete).

### VaultPushScheduler
5s-debounce push to vault. Dirty detection via injected `getHeadsFn`.

---

## Crypto

### Envelope Auth (`crypto/envelope-auth.ts`)
Ed25519-signed message envelopes. Sender authentication for all relay messages.

### Capabilities (`crypto/capabilities.ts`)
UCAN-inspired capability tokens:
- `createCapability(issuer, audience, permissions, signFn)`
- `verifyCapability(token, issuerPublicKey)`
- `delegateCapability(parent, audience, permissions, signFn)`
- Offline-verifiable, delegatable, attenuatable

### Encoding (`crypto/encoding.ts`)
Base58, Base64Url, Multibase, `toBuffer()` utility.

### DID (`crypto/did.ts`)
`createDid()`, `didToPublicKeyBytes()`, `isValidDid()`, `getDefaultDisplayName()`.

---

## Infrastructure

### wot-relay (`packages/wot-relay/`)

WebSocket Relay Server:
- **Message forwarding** — DID-based routing
- **Delivery ACK** — Persists messages until client ACK, redelivery on reconnect
- **Multi-device** — Multiple connections per DID
- **Heartbeat** — Ping/pong, detects dead connections
- **SQLite** — Message persistence
- **Live:** `wss://relay.utopia-lab.org`
- **Tests:** 24 tests

### wot-vault (`packages/wot-vault/`)

Encrypted Document Store:
- **Append-only change log** + snapshots
- **Auth via signed capability tokens**
- **HTTP REST:** POST/GET changes, PUT snapshot, GET info, DELETE doc
- **SQLite** — Persistence
- **Port:** 8789
- **Tests:** 27 tests

### wot-profiles (`packages/wot-profiles/`)

Public Profile Server:
- **HTTP REST:** GET/PUT `/p/{did}`, GET `/p/batch`
- **JWS verification** — Standalone, no wot-core dependency
- **SQLite** — Persistence
- **Live:** `https://profiles.utopia-lab.org`
- **Tests:** 25 tests

---

## Demo App (`apps/demo/`)

### CRDT Switch

```bash
pnpm dev:demo                    # Default: Yjs
VITE_CRDT=automerge pnpm dev:demo  # Automerge
```

Environment variable `VITE_CRDT` controls which StorageAdapter + PersonalDocManager is loaded.

### Features

- **Onboarding** — Create identity (Magic Words + passphrase)
- **Recovery** — Restore identity from seed
- **Unlock** — Passphrase-protected login
- **QR Verification** — In-person verification via camera
- **Contacts** — Manage verified contacts
- **Attestations** — Attest skills/properties, receive, publish
- **Spaces** — Encrypted group spaces (CRDT collaboration)
- **Profile Sync** — JWS-signed profiles published to wot-profiles
- **Public Profile** — Public profile page (viewable without login)
- **Multi-Device** — Sync via Relay + Vault
- **Offline-First** — Local data, offline banner, outbox
- **i18n** — German + English
- **Dark Mode** — Fully supported
- **Debug Panel** — Persistence metrics, relay status, CRDT info
- **Benchmark** — In-browser CRDT performance measurement (`/benchmark`)

### Routes

| Route | Page |
|---|---|
| `/` | Home (Stats, Quick Actions) |
| `/identity` | Identity Management |
| `/verify` | QR Verification |
| `/contacts` | Contact List |
| `/attestations` | Attestations |
| `/spaces` | Group Spaces |
| `/spaces/:id` | Space Detail |
| `/profile/:did` | Public Profile |
| `/benchmark` | CRDT Benchmark |

### E2E Tests (Playwright)

7 E2E tests, all passing with **both** CRDT adapters:

1. **Onboarding** — Generate → Verify → Profile → Protect → Complete
2. **Unlock** — Reload → Passphrase → Logged In
3. **Seed Restore** — Same DID on new device
4. **QR Verification** — Alice and Bob verify each other
5. **Attestation Flow** — Alice attests Bob → Bob publishes → visible on public profile
6. **Multi-Device Sync** — Alice on 2 devices + Bob: personal-doc sync, message routing, space sync
7. **Spaces** — Create space, invite member, shared notes with CRDT merge, remove member

---

## Tests

### Overview

| Package | Tests | Vitest |
|---|---|---|
| wot-core | 392 | 4.1.0 |
| wot-relay | 24 | 4.1.0 |
| wot-vault | 27 | 4.1.0 |
| wot-profiles | 25 | 4.1.0 |
| Demo (Unit) | 59 | 4.1.0 |
| Demo (E2E) | 7 | Playwright |
| **Total** | **534** | |

### wot-core Test Files (29)

```
tests/
├── WotIdentity.test.ts                    # Identity, Signing, JWS
├── SeedStorage.test.ts                    # Encrypted Seed Persistence
├── VerificationIntegration.test.ts        # Challenge-Response E2E
├── VerificationRelay.test.ts              # Verification via Relay
├── VerificationStorage.test.ts            # Verification Persistence
├── OnboardingFlow.test.ts                 # Full Onboarding Flow
├── MessagingAdapter.test.ts               # WebSocket + InMemory
├── EncryptedMessagingNetworkAdapter.test.ts # Encrypted Peer Sync
├── OutboxMessagingAdapter.test.ts         # Offline Queue
├── ProfileService.test.ts                # JWS Profile Sign/Verify
├── SymmetricCrypto.test.ts               # AES-256-GCM
├── AsymmetricCrypto.test.ts              # X25519 ECIES
├── EncryptedSyncService.test.ts          # Encrypt/Decrypt CRDT Changes
├── GroupKeyService.test.ts               # Group Key Management
├── GraphCacheService.test.ts             # Batch Profile Resolution
├── AutomergeReplication.test.ts          # Automerge Spaces + E2EE
├── CompactStorageManager.test.ts         # IDB Snapshot Storage
├── SyncOnlyStorageAdapter.test.ts        # Sync State Storage
├── VaultIntegration.test.ts             # Vault Push/Restore
├── VaultPushScheduler.test.ts           # Debounced Vault Push
├── OfflineFirstDiscoveryAdapter.test.ts  # Offline Cache
├── Capabilities.test.ts                 # UCAN-like Capabilities
├── EnvelopeAuth.test.ts                 # Signed Envelopes
├── ResourceRef.test.ts                  # ResourceRef branded types
├── CrdtBenchmark.test.ts               # Automerge vs Yjs Performance
├── YjsPersonalDocManager.test.ts        # Yjs CRUD + Proxy + Persistence
├── YjsPersonalSync.test.ts             # Yjs Multi-Device Sync
├── YjsVaultIntegration.test.ts          # Yjs Vault Push/Restore
└── setup.ts                             # fake-indexeddb setup
```

---

## File Structure

### wot-core Package

```
packages/wot-core/src/
├── identity/
│   ├── WotIdentity.ts              # Ed25519 + X25519 + JWS + HKDF
│   └── SeedStorage.ts              # Encrypted seed in IndexedDB
├── verification/
│   └── VerificationHelper.ts       # Challenge-response protocol
├── crypto/
│   ├── did.ts                      # DID utilities
│   ├── encoding.ts                 # Base64/Multibase
│   ├── jws.ts                      # JWS signing/verification
│   ├── capabilities.ts             # UCAN-inspired capabilities
│   └── envelope-auth.ts            # Signed message envelopes
├── adapters/
│   ├── interfaces/                 # 12 Adapter Interfaces
│   │   ├── StorageAdapter.ts
│   │   ├── ReactiveStorageAdapter.ts
│   │   ├── CryptoAdapter.ts
│   │   ├── MessagingAdapter.ts
│   │   ├── DiscoveryAdapter.ts
│   │   ├── ReplicationAdapter.ts   # SpaceHandle<T>
│   │   ├── AuthorizationAdapter.ts
│   │   ├── OutboxStore.ts
│   │   ├── SpaceMetadataStorage.ts
│   │   ├── GraphCacheStore.ts
│   │   ├── PublishStateStore.ts
│   │   └── Subscribable.ts
│   ├── crypto/
│   │   └── WebCryptoAdapter.ts     # Ed25519 + X25519 + AES-256-GCM
│   ├── messaging/
│   │   ├── WebSocketMessagingAdapter.ts  # + Heartbeat + Message Buffer
│   │   ├── OutboxMessagingAdapter.ts     # Offline-Queue Decorator
│   │   ├── AutomergeOutboxStore.ts
│   │   ├── InMemoryMessagingAdapter.ts
│   │   └── InMemoryOutboxStore.ts
│   ├── discovery/
│   │   ├── HttpDiscoveryAdapter.ts
│   │   ├── OfflineFirstDiscoveryAdapter.ts
│   │   ├── InMemoryGraphCacheStore.ts
│   │   └── InMemoryPublishStateStore.ts
│   ├── replication/
│   │   ├── AutomergeReplicationAdapter.ts
│   │   ├── YjsReplicationAdapter.ts
│   │   ├── YjsPersonalSyncAdapter.ts
│   │   ├── PersonalNetworkAdapter.ts
│   │   └── EncryptedMessagingNetworkAdapter.ts
│   ├── storage/
│   │   ├── IndexedDBSpaceMetadataStorage.ts
│   │   ├── AutomergeSpaceMetadataStorage.ts
│   │   ├── InMemorySpaceMetadataStorage.ts
│   │   ├── InMemoryCompactStore.ts
│   │   ├── InMemoryRepoStorageAdapter.ts
│   │   └── LocalStorageAdapter.ts
│   └── authorization/
│       └── InMemoryAuthorizationAdapter.ts
├── services/
│   ├── ProfileService.ts           # JWS Profile Sign/Verify
│   ├── EncryptedSyncService.ts     # Encrypt/Decrypt CRDT Changes
│   ├── GroupKeyService.ts          # Group Key Management
│   ├── GraphCacheService.ts        # Batch Profile Resolution
│   ├── AttestationDeliveryService.ts
│   ├── VaultClient.ts             # HTTP Client for wot-vault
│   └── VaultPushScheduler.ts      # Debounced Vault Push
├── storage/
│   ├── YjsPersonalDocManager.ts    # Yjs CRDT (Default)
│   ├── PersonalDocManager.ts       # Automerge CRDT (Option)
│   ├── CompactStorageManager.ts    # IDB Snapshot Storage
│   ├── CompactionService.ts        # Automerge History-Strip (Yields)
│   ├── SyncOnlyStorageAdapter.ts   # Automerge Sync States
│   └── PersistenceMetrics.ts       # Debug Metrics
├── types/                          # Domain Types
│   ├── identity.ts, contact.ts, verification.ts
│   ├── attestation.ts, proof.ts, messaging.ts
│   ├── space.ts, resource-ref.ts
│   └── index.ts
├── wordlists/
│   └── german-positive.ts          # 2048 German BIP39 words
└── index.ts                        # 100+ exports
```

### Demo App

```
apps/demo/src/
├── adapters/
│   ├── AutomergeStorageAdapter.ts   # Automerge PersonalDoc Adapter
│   ├── YjsStorageAdapter.ts        # Yjs PersonalDoc Adapter
│   ├── AutomergeGraphCacheStore.ts
│   ├── AutomergeOutboxStore.ts
│   ├── AutomergePublishStateStore.ts
│   ├── AutomergeSpaceMetadataStorage.ts
│   ├── LocalCacheStore.ts
│   └── PersonalNetworkAdapter.ts
├── context/
│   ├── AdapterContext.tsx           # CRDT Switch + all adapter init
│   ├── IdentityContext.tsx
│   └── PendingVerificationContext.tsx
├── hooks/                          # 14 React Hooks
├── pages/                          # 9 pages + Benchmark
├── components/                     # UI Components
│   ├── identity/                   # Onboarding, Recovery, Unlock
│   ├── verification/               # QR Code, Confetti
│   ├── contacts/                   # ContactCard, ContactList
│   ├── attestation/                # AttestationCard, Create, Import
│   ├── debug/                      # DebugPanel
│   ├── shared/                     # Avatar, Tooltip, etc.
│   └── layout/                     # AppShell, Navigation
├── services/                       # Verification, Contact, Attestation
├── i18n/                           # German + English
├── personalDocManager.ts           # CRDT switch shim
├── App.tsx
└── main.tsx
```

---

## Technical Decisions

### DID: did:key (confirmed)

After evaluating 6 methods (did:key, did:peer, did:web, did:webvh, did:dht, did:plc). No infrastructure needed, offline-capable, BIP39→deterministic DID.

### CRDT: Yjs Default, Automerge Option

**Decision (2026-03-15):** Yjs is default after extensive evaluation.

**History:**
1. Evolu (SQLite WASM) — first iteration, removed due to limitations
2. Automerge (Rust WASM) — second iteration, WASM performance on mobile untenable
3. Yjs (pure JavaScript) — current solution, 76x faster on mobile

**Benchmark results (Large: 500 contacts, 1000 attestations):**

| Metric | Yjs | Automerge | Speedup |
|---|---|---|---|
| Init (Android) | 85ms | 6.4s | 76x |
| Mutate 100 | 3ms | 1.9s | 632x |
| Serialize | 112ms | 819ms | 7x |
| Bundle | 69KB | 1.7MB | 25x |

### Crypto: WebCrypto API + @noble/ed25519

Native WebCrypto for HKDF, PBKDF2, AES-GCM, X25519 ECDH. @noble/ed25519 for signing (WebCrypto Ed25519 has browser compatibility issues).

### Storage: IndexedDB via CompactStorageManager

Custom CompactStorageManager instead of automerge-repo (which caused WASM OOM at 40+ IDB chunks).

### Encryption: Encrypt-then-sync

CRDT updates are encrypted **before** sync. The relay only sees ciphertext. Inspired by Keyhive/NextGraph.

---

## Deviations from Specification

| Aspect | Specification | Implemented | Reason |
|---|---|---|---|
| DID format | `did:wot:...` | `did:key:z6Mk...` | W3C standard, no custom infra |
| Master key | BIP39→PBKDF2→Ed25519 | BIP39→HKDF (non-extractable) | Hardware isolation, framework key derivation |
| Wordlist | English | German (dys2p) | German-speaking target audience |
| Mnemonic | 24 words | 12 words | 128-bit sufficient, better UX |
| Storage | Not specified | Passphrase + IndexedDB | Browser has no OS keychain |

---

## Next Steps

### Priority 1: Offline E2E Tests

19 planned scenarios:
- Offline start, offline actions (profile, attestation, space, verification)
- Reconnect sync, incoming messages while offline
- Close tab + return later, vault fallback
- Verification in a cave (both offline, QR scan)
- Seed restore offline → vault merge on reconnect

### Priority 2: WoT Connector for Real Life Stack

`real-life-stack/packages/wot-connector/` — Integration with Yjs adapter, CompactStore, new architecture.

### Priority 3: CRDT Adapter Library

Swappable CRDT packages for external developers:
```
@real-life/wot-core           → Interfaces, Crypto, Identity
@real-life/adapter-yjs        → YjsReplicationAdapter (Default)
@real-life/adapter-automerge  → AutomergeReplicationAdapter (Option)
```

### Deferred

- **Matrix Integration** — Only when federation is needed
- **Social Recovery (Shamir)** — Seed backup via verified contacts
- **NextGraph Evaluation** — Call with Nicos (maintainer) pending
- **Keyhive/BeeKEM** — Earliest production-ready end of 2027

---

## Architecture Decisions (Research)

### Framework Evaluation v2 (2026-02-08)

16 frameworks evaluated, 6 eliminated:
- Eliminated: ActivityPub (no E2EE), Nostr (secp256k1), DXOS (P-256), DIDComm (stale), Iroh (networking only), p2panda (no JS)
- Best CRDT: Yjs (chosen after Automerge performance issues)
- Best Messaging: Matrix (Ed25519, Megolm, Federation) — for production
- Best Capabilities: Willow/Meadowcap (inspiration)

### CRDT Evaluation (2026-03-15)

| CRDT | Language | Bundle | Mobile Init (163KB) | E2EE | Status |
|---|---|---|---|---|---|
| **Yjs** | Pure JS | 69KB | ~85ms | Self-built | **Default** |
| Automerge | Rust→WASM | 1.7MB | ~6.4s | Keyhive (2027?) | Option |
| NextGraph | Rust→WASM | ~7.9MB | ? | Built-in | Alpha |
| Loro | Rust→WASM | ~500KB | ? | No | New |

### Vault Sync Patterns

Three patterns documented (`docs/concepts/vault-sync-architektur.md`):
1. **Peer Sync** — Incremental via Relay
2. **Vault** — Snapshot replace, 5s debounce
3. **Invite** — Snapshot on space invitation

---

*This document is updated on significant changes.*
*Last change: Yjs Migration (2026-03-15)*
