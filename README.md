# Web of Trust

[![CI](https://github.com/antontranelis/web-of-trust/actions/workflows/ci.yml/badge.svg)](https://github.com/antontranelis/web-of-trust/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@web_of_trust/core)](https://www.npmjs.com/package/@web_of_trust/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A decentralized trust infrastructure for real-life communities. People meet in person, verify each other's identity via QR code, and build reputation through attestations over time.

**No central server sees your data.** Everything is end-to-end encrypted and stored locally.

## How it works

```text
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     VERIFY      │ ──► │   COLLABORATE   │ ──► │     ATTEST      │
│                 │     │                 │     │                 │
│ Confirm identity│     │ Share encrypted │     │ Build reputation│
│ by meeting in   │     │ content (tasks, │     │ through real    │
│ person (QR scan)│     │ calendar, maps) │     │ actions         │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Verification ≠ Trust.** Verification only confirms: "This is really that person." Actual trust is built through attestations over time.

## Protocol Specification

The protocol is specified in the [WoT Spec](https://github.com/real-life-org/wot-spec) — an open, standards-based protocol combining W3C Verifiable Credentials, DIDComm v2.1, Ed25519, and ECIES for decentralized identity and trust.

- **[WoT Spec v0.1.0-draft](https://github.com/real-life-org/wot-spec/releases/tag/v0.1.0-draft)** — first published draft
- **License:** [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

## Live Demo

- **Demo App:** [web-of-trust.de/demo](https://web-of-trust.de/demo)
- **CRDT Benchmark:** [web-of-trust.de/benchmark](https://web-of-trust.de/benchmark) — measure Yjs vs Automerge on your device
- **Relay:** `wss://relay.utopia-lab.org`
- **Profiles:** `https://profiles.utopia-lab.org`

## Architecture

### 7-Adapter System

The system is built on swappable adapters — same interfaces, different implementations. This allows experimenting with different CRDT frameworks, messaging protocols, and storage backends without touching application code.

```text
                     ┌───────────────────┐
                     │  Your App / Demo  │
                     └─────────┬─────────┘
                               │
    ┌──────────────────────────┴──────────────────────────┐
    │  wot-core                                           │
    │  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐  │
    │  │ Storage │ │ Reactive │ │ Crypto │ │ Discovery │  │
    │  └─────────┘ └──────────┘ └────────┘ └───────────┘  │
    │   ┌───────────┐ ┌─────────────┐ ┌───────────────┐   │
    │   │ Messaging │ │ Replication │ │ Authorization │   │
    │   └───────────┘ └─────────────┘ └───────────────┘   │
    └──────────────────────────┬──────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │ adapter-yjs / adapter-automerge │
              └────────────────┬────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        ┌─────┴─────┐   ┌──────┴─────┐  ┌───────┴───────┐
        │ wot-relay │   │  wot-vault │  │ wot-profiles  │
        └───────────┘   └────────────┘  └───────────────┘
```

| Adapter | Purpose | Implementation |
| ------- | ------- | -------------- |
| [**StorageAdapter**](packages/wot-core/README.md#storageadapter) | Local persistence, CRUD | Yjs (default) or Automerge |
| [**ReactiveStorageAdapter**](packages/wot-core/README.md#reactivestorageadapter) | Live queries, subscriptions | Observables on CRDT changes |
| [**CryptoAdapter**](packages/wot-core/README.md#cryptoadapter) | Signing, encryption | WebCrypto (Ed25519, X25519, AES-256-GCM) |
| [**DiscoveryAdapter**](packages/wot-core/README.md#discoveryadapter) | Public profile lookup | HTTP + offline cache |
| [**MessagingAdapter**](packages/wot-core/README.md#messagingadapter) | 1:1 message delivery | WebSocket Relay (ACK + Outbox) |
| [**ReplicationAdapter**](packages/wot-core/README.md#replicationadapter) | Encrypted CRDT Spaces | Yjs or Automerge + E2EE + GroupKeys |
| [**AuthorizationAdapter**](packages/wot-core/README.md#authorizationadapter) | Capabilities / permissions | UCAN-inspired, offline-verifiable |

### Infrastructure

Three CRDT-agnostic services — they only see encrypted bytes, never plaintext:

| Service | Transport | Purpose |
| ------- | --------- | ------- |
| [**wot-relay**](packages/wot-relay/README.md) | WebSocket | Real-time sync + delivery ACK |
| [**wot-vault**](packages/wot-vault/README.md) | HTTP | Encrypted backup for new device restore |
| [**wot-profiles**](packages/wot-profiles/README.md) | HTTP | Public profile discovery (JWS-signed) |

Data is also persisted locally in IndexedDB (CompactStore) for offline access.

### CRDT Support

| Package | CRDT | Runtime | Notes |
| ------- | ---- | ------- | ----- |
| [**adapter-yjs**](packages/adapter-yjs/README.md) | Yjs | Pure JavaScript (69KB) | Default. Fast on all devices. |
| [**adapter-automerge**](packages/adapter-automerge/README.md) | Automerge | Rust → WASM (1.7MB) | Alternative. Heavier on mobile. |

Switch at startup with `VITE_CRDT=automerge`. Both pass the same 11 end-to-end tests. Try the [in-browser benchmark](https://web-of-trust.de/benchmark) to compare on your device.

### Identity

- **BIP39 Mnemonic** — 12-word recovery phrase (German wordlist)
- **Ed25519** — Signing (via @noble/ed25519)
- **X25519** — Key agreement (ECDH)
- **did:key** — W3C Decentralized Identifier
- **HKDF Master Key** — Non-extractable CryptoKey, hardware isolation when available
- **Encrypted seed storage** — PBKDF2 (600k iterations) + AES-GCM in IndexedDB

### End-to-End Encryption

All data is encrypted before it leaves the device. The relay server only sees ciphertext.

- **Symmetric:** AES-256-GCM (CRDT updates, group content)
- **Asymmetric:** X25519 ECIES (key exchange, 1:1 messages)
- **Envelope Auth:** Ed25519-signed message envelopes
- **Group Keys:** Per-space key with generation-based rotation

### Three Sharing Patterns

1. **Group Spaces** — CRDT-based collaboration (ReplicationAdapter)
2. **Selective Sharing** — Item-level encryption keys
3. **1:1 Delivery** — Attestations, verifications via Relay

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 9+

### Development

```bash
# Install dependencies
pnpm install

# Start demo app (default: Yjs)
pnpm dev:demo

# Start demo app with Automerge
VITE_CRDT=automerge pnpm dev:demo

# Start landing page
pnpm dev:landing

# Run tests
pnpm test              # all packages
pnpm test:e2e          # Playwright E2E tests

# Build
pnpm build:core
```

### Monorepo Structure

```text
web-of-trust/
├── packages/
│   ├── wot-core/            # @web_of_trust/core — Core library
│   ├── adapter-yjs/         # @web_of_trust/adapter-yjs — Yjs CRDT adapter (default)
│   ├── adapter-automerge/   # @web_of_trust/adapter-automerge — Automerge CRDT adapter
│   ├── wot-relay/           # WebSocket Relay Server (Node.js, SQLite)
│   ├── wot-vault/           # Encrypted Document Store (HTTP, SQLite)
│   └── wot-profiles/        # Public Profile Service (HTTP, SQLite, JWS)
├── apps/
│   ├── demo/                # Demo App (React 19, i18n, Dark Mode)
│   ├── benchmark/           # CRDT Benchmark (Yjs vs Automerge)
│   └── landing/             # Landing Page
└── docs/                    # Architecture docs & specifications
```

### Packages

| Package | Description | Links |
| ------- | ----------- | ----- |
| [`@web_of_trust/core`](packages/wot-core/) | Core library — identity, crypto, adapters, services | [npm](https://www.npmjs.com/package/@web_of_trust/core) |
| [`@web_of_trust/adapter-yjs`](packages/adapter-yjs/) | Yjs CRDT adapter (default) — pure JS, 76x faster on mobile | |
| [`@web_of_trust/adapter-automerge`](packages/adapter-automerge/) | Automerge CRDT adapter — Rust→WASM | |
| [`wot-relay`](packages/wot-relay/) | WebSocket Relay Server — message forwarding, delivery ACK, SQLite | |
| [`wot-vault`](packages/wot-vault/) | Encrypted Document Store — append-only, capability auth, SQLite | |
| [`wot-profiles`](packages/wot-profiles/) | Public Profile Service — JWS verification, REST API, SQLite | |

### Quick Start (Code)

```typescript
// Core — identity, crypto, messaging
import {
  WotIdentity,
  WebCryptoAdapter,
  HttpDiscoveryAdapter,
  WebSocketMessagingAdapter,
  OutboxMessagingAdapter,
  ProfileService,
  EncryptedSyncService,
  GroupKeyService,
} from '@web_of_trust/core'

// CRDT adapter — choose one
import { YjsReplicationAdapter } from '@web_of_trust/adapter-yjs'
// or: import { AutomergeReplicationAdapter } from '@web_of_trust/adapter-automerge'

// Create identity from 12 magic words
const identity = new WotIdentity()
await identity.create('my-passphrase', true)
console.log(identity.getDid()) // did:key:z6Mk...
```

## Tests

| Package | Tests | Framework |
|---|---|---|
| wot-core | 392 | Vitest 4.1.0 |
| wot-relay | 24 | Vitest 4.1.0 |
| wot-vault | 27 | Vitest 4.1.0 |
| wot-profiles | 25 | Vitest 4.1.0 |
| Demo (Unit) | 59 | Vitest 4.1.0 |
| Demo (E2E) | 7 | Playwright |
| **Total** | **534** | |

All 11 E2E tests pass with **both** CRDT adapters (Yjs and Automerge).

## Demo App Features

- **Onboarding** — Create identity with 12 Magic Words + passphrase
- **Recovery** — Restore identity from seed on any device
- **QR Verification** — In-person identity verification via camera
- **Contacts** — Manage verified contacts
- **Attestations** — Attest skills/properties, receive, publish
- **Spaces** — Encrypted group collaboration (CRDT)
- **Profile Sync** — JWS-signed profiles published to wot-profiles
- **Public Profile** — Viewable without login
- **Multi-Device** — Sync via Relay + Vault
- **Offline-First** — Local data, offline banner, outbox queue
- **i18n** — German + English
- **Dark Mode** — Fully supported
- **Debug Panel** — Persistence metrics, relay status, CRDT info

## Documentation

> **Note:** Most specification documents are in German. The implementation status is documented in English in [CURRENT_IMPLEMENTATION.md](docs/CURRENT_IMPLEMENTATION.md).

| Document | Description |
| -------- | ----------- |
| [Current Implementation](docs/CURRENT_IMPLEMENTATION.md) | What's built, what works, architecture decisions |
| [NLNet Application](docs/nlnet-application-2026.md) | Funding application (NGI Zero Commons Fund) |
| [Adapter Architecture v2](docs/architecture/adapters.md) | 7-adapter specification |
| [Framework Evaluation](docs/research/framework-evaluation.md) | 16 frameworks evaluated |
| [DID Methods Comparison](docs/concepts/did-methods.md) | 6 DID methods evaluated (did:key confirmed) |
| [Vault Sync Architecture](docs/concepts/vault-sync.md) | Three sync patterns |
| [Social Recovery](docs/concepts/social-recovery.md) | Shamir Secret Sharing concept |
| [Threat Model](docs/security/threat-model.md) | STRIDE analysis |
| [Encryption Protocol](docs/architecture/encryption.md) | E2E encryption design |

## Related Projects

- **[Real Life Stack](https://github.com/antontranelis/real-life-stack)** — Modular app toolkit for local communities, built on Web of Trust

## Contributing

We're looking for:

- Communities who want to try it
- Feedback on UX and concept
- Developers who want to build with us

## License

[MIT](LICENSE)
