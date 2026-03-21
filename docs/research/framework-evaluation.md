# Framework Evaluation

> Analysis of Local-First, CRDT, P2P, and Messaging frameworks for the Web of Trust
>
> **Version 2** — Updated 2026-02-08 after recognizing that no single framework is sufficient.

---

> ## Update 2026-03-15: Yjs Migration Complete
>
> **Yjs is now the default CRDT.** Automerge remains available via `VITE_CRDT=automerge`.
>
> The original evaluation (below) recommended Automerge for the CRDT axis. This was correct at the time
> of writing. After implementation and mobile benchmarking, Automerge (Rust→WASM) proved untenable on
> mobile: 30+ seconds of UI freeze on Android for a 163KB document.
>
> **Yjs (pure JavaScript) solves the problem:**
>
> | Metric | Yjs | Automerge | Speedup |
> |--------|-----|-----------|---------|
> | Init Android (163KB) | 85ms | 6.4s | **76x** |
> | Mutate 100 items | 3ms | 1.9s | **632x** |
> | Serialize | 112ms | 819ms | 7x |
> | Bundle size | 69KB | 1.7MB | 25x |
>
> The adapter architecture described below made this migration straightforward — only the
> `ReplicationAdapter` and `StorageAdapter` implementations changed. All business logic, crypto,
> and messaging remained untouched.
>
> The evaluation history is preserved below because it documents the reasoning at each step.

---

## Motivation

The Web of Trust requires:

- **Offline-First**: All operations work without a connection
- **E2E Encryption**: Server sees only encrypted data
- **CRDTs**: Automatic, deterministic conflict resolution
- **DID Compatibility**: Interoperability with W3C standards (did:key, Ed25519)
- **Cross-User Messaging**: Deliver attestations, verifications, and items between DIDs
- **Group Collaboration**: Shared spaces (Kanban, calendar, map) with E2EE
- **Selective Visibility**: Share items with N of M contacts (item-key model)
- **Capability-based Authorization**: UCAN-like delegatable permissions
- **React Native**: Mobile-first development

### Key Insight (v2)

> **No single framework can satisfy our requirements.**
>
> During the Evolu integration it became clear: Evolu only synchronizes within the same owner
> (single-user, multi-device). There is no concept for cross-user messaging.
> The SharedOwner API exists but is not functional (as of Feb 2026, Discussion #558).
>
> **The solution: Two orthogonal axes:**
>
> | Axis | Function | Example Implementation |
> |------|----------|-----------------------|
> | **CRDT/Sync** | State convergence, multi-device/multi-user | Automerge, Evolu, Yjs |
> | **Messaging** | Delivery between DIDs, delivery receipts | Matrix, Nostr, WebSocket |
>
> A message does NOT carry state — it carries only the trigger/pointer.
> State lives in the CRDT and converges independently.

This evaluation examines candidates for both axes and defines a 6-adapter architecture.

---

## Evaluated Frameworks

### Overview

#### CRDT/Sync Axis (State Convergence)

| Framework | E2EE | CRDT | Cross-User | React/Web | Maturity |
|-----------|------|------|------------|-----------|----------|
| [Evolu](#evolu) | Native | SQLite + LWW | Single-Owner only | First-class | Production |
| [NextGraph](#nextgraph) | Native | Yjs + Automerge + Graph | Overlays | SDK coming | Alpha |
| [Jazz](#jazz) | Native | CoJSON | Groups | Documented | Beta |
| [DXOS](#dxos) | Native | Automerge | Spaces | Web only | Production |
| [p2panda](#p2panda) | Double Ratchet | Any (BYOC) | Groups | No JS SDK | Pre-1.0 |
| [Automerge](#automerge--yjs) | Self-built | Own | Self-built | WASM | Production |
| [Yjs](#automerge--yjs) | Self-built | Own | Self-built | Yes | Production |
| [Loro](#loro) | Self-built | Own | Self-built | WASM + Swift | Production |

#### Messaging Axis (Cross-User Delivery)

| Framework | E2EE | DID | Offline Queue | Groups | Maturity |
|-----------|------|-----|---------------|--------|----------|
| [Nostr](#nostr) | NIP-44 | secp256k1 only | Relays | Channels | Production |
| [Matrix](#matrix) | Megolm/Vodozemac | No native | Homeserver | Rooms | Production |
| [DIDComm](#didcomm) | Native | did:key | Mediator needed | No | Spec done, libs stale |
| [ActivityPub](#activitypub) | No | No | Inbox | Partial | Production |
| [Iroh](#iroh) | QUIC | No | No (direct) | No | Beta |

#### Other (not categorized)

| Framework | Role | Maturity |
|-----------|------|----------|
| [Willow/Earthstar](#willow--earthstar) | Protocol + Capabilities (Meadowcap) | Beta/Stagnating |
| [Secsync](#secsync) | Architecture reference for E2EE CRDTs | Beta |
| [Keyhive](#keyhive) | Group key management (BeeKEM) | Pre-Alpha |
| [Subduction](#subduction) | Encrypted P2P sync (Sedimentree) | Pre-Alpha |

### Categorization (updated v2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              Local-First + E2EE + Messaging Landscape                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  AXIS 1: CRDT/SYNC (State Convergence)                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Evolu         │ SQLite, LWW, React, Custom Keys, Single-Owner      │   │
│  │ Automerge     │ JSON-like, Ink & Switch, WASM                      │   │
│  │ Yjs           │ Largest community, many bindings                    │   │
│  │ Loro          │ High-Performance, Rust + WASM + Swift               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  AXIS 2: MESSAGING (Cross-User Delivery)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Matrix        │ E2EE Rooms, Homeserver, Federation, Bridges        │   │
│  │ Nostr         │ Relays, Pubkeys, NIPs, large ecosystem              │   │
│  │ DIDComm       │ DID-native, spec done, JS libs stale               │   │
│  │ Custom WS     │ Minimal WebSocket relay for POC                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  FULL-STACK (both axes, but with constraints):                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ NextGraph     │ DID, RDF, 3 CRDTs, Broker — but Alpha              │   │
│  │ Jazz          │ CoJSON, Groups — but proprietary                    │   │
│  │ DXOS          │ Spaces, HALO — but P-256 keys, Web-only            │   │
│  │ p2panda       │ True P2P, Double Ratchet — but no JS SDK           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  BUILDING BLOCKS (supplementary):                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Willow        │ Meadowcap capabilities, Earthstar TS                │   │
│  │ Keyhive       │ BeeKEM group keys                                   │   │
│  │ Secsync       │ E2EE CRDT architecture reference                    │   │
│  │ Iroh          │ QUIC networking layer (n0-computer)                  │   │
│  │ Subduction    │ Encrypted P2P sync (Sedimentree), Ink & Switch      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Analysis

### NextGraph

> Decentralized, encrypted and local-first platform

**Website:** https://nextgraph.org/
**Gitea:** https://git.nextgraph.org/NextGraph/nextgraph-rs
**GitHub Mirror:** https://github.com/nextgraph-org/nextgraph-rs (~73 stars)
**Status:** Alpha (v0.1.2-alpha.1)
**Maintainer:** ~3 (Niko Bonnieure primary)
**Funding:** EU NLnet/NGI Grants + Donations

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | `did:ng` for users and documents, multiple personas per wallet |
| **E2EE** | Yes, capability-based (not Signal/Matrix) |
| **CRDTs** | 3 models: Graph CRDT (RDF, custom) + Automerge + Yjs |
| **Data model** | RDF triples + SPARQL, JSON, rich text, Markdown |
| **Groups** | Cryptographic capabilities (Editor/Reader/Signer roles) |
| **Sync** | 2-tier broker network, P2P pub/sub, DAG of commits |
| **Transport** | WebSocket + Noise Protocol (no TLS/DNS required) |
| **Languages** | Rust (76%), TypeScript (14%), Svelte (6%) |
| **SDKs** | Rust (crates.io), JS/TS (WASM, still Alpha), Node.js, Deno planned |
| **Platforms** | Linux, macOS, Windows, Android, iOS (TestFlight), Web |
| **Storage** | RocksDB (encrypted at rest) |

#### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    NextGraph                         │
│                                                      │
│  Tier 1: Core Brokers (server, 24/7, relay)         │
│     ↕ WebSocket + Noise Protocol                    │
│  Tier 2: Edge/Local Brokers (client-side daemon)    │
│     ↕                                                │
│  Documents: DAG of commits                           │
│     ├── Graph Part (RDF, mandatory)                  │
│     ├── Discrete Part (Yjs/Automerge, optional)      │
│     └── Binary Files (optional)                      │
│                                                      │
│  Overlays per repo:                                  │
│     ├── Inner Overlay (write access, peers know      │
│     │   each other)                                  │
│     └── Outer Overlay (read-only, anonymous)         │
└─────────────────────────────────────────────────────┘
```

#### Unique Features

- **3 CRDTs combined:** Graph CRDT (RDF) + Automerge + Yjs mixable at branch level
- **SPARQL on encrypted local-first data** — unique
- **Social queries:** Federated SPARQL over encrypted P2P data of other users
- **Pazzle auth:** 9 images as password alternative (mental narrative)
- **Smart contracts without blockchain:** FSM + WASM verifier
- **Nuri (NextGraph URI):** Permanent cryptographic document IDs with embedded capabilities
- **ShEx → TypeScript:** RDF schemas become typed TS objects with proxy reactivity

#### Assessment for Web of Trust (updated 2026-02-07)

```
Advantages:
+ DID support built in (only framework with did:ng!)
+ RDF graph = natural model for a trust network
+ Capability-based crypto = fits WoT permissions
+ E2EE + encryption at rest mandatory
+ No DNS, no TLS, no single point of failure
+ SPARQL enables powerful graph queries over trust relationships
+ Consumer app + developer framework (social network built in)

Disadvantages:
- Alpha — NOT production-ready (v0.1.2-alpha)
- JS/React SDK not yet released (coming early 2026)
- No custom key import — wallet generates its own keys
  → Integration with existing BIP39 seed problematic
- Very small community (~73 stars, ~3 contributors)
- Grant-dependent funding (sustainability?)
- Extremely complex (3 CRDTs, RDF, SPARQL, Noise Protocol, broker network)
- Rust-based → WASM for web, integration more expensive
- Single-point-of-knowledge risk (Niko Bonnieure)
```

**Recommendation:** Philosophically closest to our vision. Monitor and evaluate once the JS SDK is available. Not suitable for POC due to missing custom key integration and alpha status. Longest-term most interesting candidate.

---

### Evolu

> Local-first platform with E2EE and SQLite

**Website:** https://evolu.dev/
**GitHub:** https://github.com/evoluhq/evolu (~1.8k stars)
**Status:** Production (v7/v8, major rewrite in progress)
**Maintainer:** 1 primary (Daniel Steigerwald), few others
**License:** MIT

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | SLIP-21 key derivation from 16 bytes entropy, BIP39 mnemonic |
| **E2EE** | Yes, symmetric (quantum-safe) + PADME padding |
| **CRDTs** | LWW (last-write-wins) per cell (table/row/column) |
| **Data model** | SQLite with branded TypeScript types (Kysely query builder) |
| **Sync** | Range-based set reconciliation, hybrid logical clocks, binary protocol |
| **Transport** | WebSocket to relay server (self-hostable) |
| **Languages** | TypeScript |
| **Platforms** | Web (OPFS), React Native, Expo, Electron, Svelte, Vue |
| **Custom keys** | Yes — `ownerId`, `writeKey`, `encryptionKey` passed directly (since Nov 2025, Issue #537) |

#### Architecture

```
Browser/App (SQLite local, OPFS)
    ↕ WebSocket (E2E encrypted, binary)
Relay Server (stateless, sees only encrypted blobs)
    ↕ WebSocket
Other Device (SQLite local)

Relay CANNOT:
- Read data (E2E encrypted)
- Detect patterns (PADME padding)
- Correlate users

Relay IS:
- Self-hostable (Docker, Render, AWS Lambda)
- Free relay available: free.evoluhq.com
- Recommended: 2 relays (local + geo-distant backup)
```

#### Owner Models

- **AppOwner** — Single-user (default, our use case)
- **SharedOwner** — Collaborative multi-user
- **SharedReadonlyOwner** — Read-only collaboration
- **ShardOwner** — Logical data partitioning (partial sync)

#### Custom Key Integration (critical for us)

```typescript
// Initialize Evolu with WotIdentity keys:
const evolKey = await identity.deriveFrameworkKey('evolu-storage-v1')

const evolu = createEvolu(evoluReactWebDeps)(Schema, {
  ownerId: identity.getDid(),
  writeKey: deriveWriteKey(evolKey),
  encryptionKey: deriveEncryptionKey(evolKey),
  transports: [{ type: "WebSocket", url: "wss://our-relay.example.com" }],
})
```

This feature was requested by the Trezor team and implemented in Issue #537.

#### Assessment for Web of Trust (updated 2026-02-07)

```
Advantages:
+ Custom keys! → direct integration with WotIdentity.deriveFrameworkKey()
+ BIP39 mnemonic as basis (same philosophy as us)
+ React/Svelte/Vue first-class support
+ React Native + Expo fully supported
+ SQLite = familiar queries with Kysely (type-safe)
+ E2EE mandatory, relay blind
+ Near-production, active development
+ Self-hostable relay (Docker, one click on Render)
+ Partial sync (temporal + logical) for scaling
+ PADME padding against traffic analysis

Disadvantages:
- Single-maintainer risk (steida = 99% of commits)
- Major rewrite in progress (Effect removed, new sync)
- No DID support (must be built ourselves → we already have it)
- LWW CRDT is simple (no rich-text merging like Yjs)
- Relay required for sync (no true P2P, but on roadmap)
- SQL paradigm vs. graph data model
```

**Recommendation:** Primary candidate for POC. Pragmatic, stable, custom key support is the game changer. DID layer we already have (WotIdentity).

---

### Jazz

> Primitives for building local-first apps

**Website:** https://jazz.tools/
**GitHub:** https://github.com/garden-co/jazz
**Status:** Beta

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | Account keys (passphrase-based) |
| **E2EE** | Yes, with signatures |
| **CRDTs** | CoJSON (own format) |
| **Data model** | Collaborative JSON ("CoValues") |
| **Groups** | Built-in with permissions |
| **Languages** | TypeScript |
| **Platforms** | Web, React Native (documented) |

#### Assessment for Web of Trust

```
Advantages:
+ Elegant API ("feels like reactive local JSON")
+ Groups with permissions built in
+ React Native documented
+ Passphrase recovery (similar to mnemonic)
+ Active development

Disadvantages:
- No DID support
- Still Beta
- CoJSON is proprietary
- Less control over crypto
```

**Recommendation:** Alternative to Evolu. More elegant, but less mature.

---

### Secsync

> Architecture for E2E encrypted CRDTs

**Website:** https://secsync.com/
**GitHub:** https://github.com/nikgraf/secsync (225 stars)
**Status:** Beta

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | Ed25519 keys (externally managed) |
| **E2EE** | XChaCha20-Poly1305-IETF |
| **CRDTs** | Agnostic (Yjs, Automerge examples) |
| **Concept** | Snapshots + updates + ephemeral messages |
| **Key exchange** | External (Signal Protocol or PKI) |
| **Languages** | TypeScript |

#### Assessment for Web of Trust

```
Advantages:
+ Framework-agnostic (Yjs or Automerge)
+ Clean E2EE architecture documented
+ Server sees only encrypted blobs
+ Snapshot + update model is efficient

Disadvantages:
- Key exchange must be built yourself
- React Native support unclear
- Still Beta
- Smaller community
```

**Recommendation:** Good architecture reference. Adopt the concepts if we build ourselves.

---

### p2panda

> Modular toolkit for local-first P2P applications

**Website:** https://p2panda.org/
**GitHub:** https://github.com/p2panda/p2panda (~394 stars)
**Status:** Pre-1.0 (v0.5.0, Jan 2026) — active development
**Maintainers:** 4 (adzialocha, sandreae, mycognosist, cafca)
**Funding:** EU NLnet/NGI Grants (POINTER, ASSURE, ENTRUST, Commons Fund)
**License:** Apache 2.0 / MIT

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | Ed25519 per device, KeyGroups for multi-device |
| **E2EE** | Data: XChaCha20-Poly1305 + PCS. Messages: Double Ratchet (Signal-like) |
| **CRDTs** | BYOC — Bring Your Own (Automerge, Yjs, Loro, custom) |
| **Data model** | Append-only logs (Namakemono spec), data-type-agnostic |
| **Sync** | Bidirectional push + PlumTree/HyParView gossip |
| **Transport** | QUIC (iroh), mDNS, bootstrap nodes |
| **Languages** | Rust (9 modular crates) |
| **Platforms** | Desktop (GTK/Tauri), mobile (Flutter FFI), IoT |
| **JS SDK** | Outdated — `p2panda-js` v0.8.1 (~2 years old, pre-rewrite) |

#### Modular Crates

| Crate | Function |
|-------|----------|
| **p2panda-core** | Extensible data types (operations, headers, bodies) |
| **p2panda-net** | P2P networking, discovery, gossip |
| **p2panda-discovery** | Confidential peer/topic discovery |
| **p2panda-sync** | Append-only log synchronization |
| **p2panda-blobs** | Large file transfer |
| **p2panda-store** | SQLite, memory, filesystem persistence |
| **p2panda-stream** | Stream processing middleware |
| **p2panda-encryption** | Group encryption (2 schemes) |
| **p2panda-auth** | Decentralized access control |

#### Encryption (2 Schemes)

**Data Encryption** (for persistent group data):
- Symmetric key for all group members
- Post-compromise security (key rotation on member removal)
- XChaCha20-Poly1305

**Message Encryption** (for ephemeral messages):
- Double Ratchet algorithm (like Signal)
- Each message gets its own key → strong forward secrecy
- AES-256-GCM

#### Real-World Apps

- **Reflection** — Collaborative local-first GTK text editor (224 stars)
- **Meli** — Android app for bee species categorization (Brazil, Flutter)
- **Toolkitty** — Coordination app for collectives

#### Assessment for Web of Trust (updated 2026-02-07)

```
Advantages:
+ True P2P (no server/relay needed!)
+ Works over LoRa, Bluetooth, shortwave, USB stick
+ Modular approach (pick what you need)
+ Double Ratchet = Signal-level forward secrecy
+ Post-compromise security for groups
+ Confidential discovery (peers find each other without revealing interests)
+ EU-funded (NLnet), security audit planned
+ 4 active contributors (better than single-maintainer)
+ Ed25519 keys (like us), custom keys possible

Disadvantages:
- NO current JavaScript/Web SDK (knockout for React-based app!)
- Pre-1.0 — not production-ready
- Rust-based → WASM or FFI needed for web
- No DID support
- No BIP39/mnemonic support built in
- Repeated architectural rewrites (Bamboo→Namakemono, aquadoggo→modular)
- Documentation scattered (blog posts, old handbook, Rust docs)
```

**Recommendation:** Philosophically very close (true P2P, radically offline-first). Not usable for a web app right now due to missing JS SDK. Watch for: (1) long-term vision with LoRa/BLE for offline communities, (2) individual crates (p2panda-encryption, p2panda-auth) as inspiration. FOSDEM 2026 talk shows growing GNOME/Linux desktop interest.

---

### DXOS

> Decentralized developer platform

**Website:** https://dxos.org/
**GitHub:** https://github.com/dxos/dxos (483 stars)
**Status:** Production

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | HALO protocol (ECDSA P-256 keyring) |
| **E2EE** | Yes, via ECHO protocol |
| **CRDTs** | Yjs / Automerge via adapter |
| **Data model** | Graph-based (spaces, objects) |
| **Sync** | P2P via WebRTC |
| **Languages** | TypeScript |
| **Keys** | ECDSA P-256 (Web Crypto standard) — NOT Ed25519 |

#### Assessment for Web of Trust (updated 2026-02-08)

```
Advantages:
+ Graph model fits Web of Trust
+ Spaces concept similar to our groups
+ Production-ready
+ Good TypeScript types
+ Composer = complete app as reference

Disadvantages:
- ECDSA P-256 keyring — incompatible with our Ed25519/did:key!
- No React Native support (Web-only)
- Custom DID format (DXOS-specific, not W3C-compatible)
- No BIP39/mnemonic support
- Complex own protocol (HALO + ECHO)
- Large bundle (~2MB)
```

**Recommendation:** Eliminated. P-256 vs. Ed25519 is a fundamental crypto mismatch. No React Native. Concepts (spaces, HALO) interesting as inspiration.

---

### Keyhive

> Decentralized group key management

**Website:** https://www.inkandswitch.com/keyhive/
**GitHub:** https://github.com/inkandswitch/keyhive (177 stars)
**Status:** Pre-Alpha (research)

#### Properties

| Aspect | Details |
|--------|---------|
| **Focus** | Group key management for local-first |
| **Protocol** | BeeKEM (based on TreeKEM) |
| **Features** | Forward secrecy, post-compromise security |
| **Scaling** | Logarithmic (thousands of members) |
| **Languages** | Rust + WASM |

#### Assessment for Web of Trust

```
Advantages:
+ Solves exactly the group key problem
+ From Ink & Switch (makers of Automerge)
+ Capability-based access control
+ Designed for CRDTs

Disadvantages:
- Pre-Alpha, not audited
- No React Native
- Key management only, not a complete framework
- API still unstable
```

**Recommendation:** Monitor for group encryption. Could complement Evolu/Jazz once stable.

---

### Loro

> High-performance CRDT library

**Website:** https://loro.dev/
**GitHub:** https://github.com/loro-dev/loro
**Status:** Production

#### Properties

| Aspect | Details |
|--------|---------|
| **Focus** | Performance-optimized CRDTs |
| **Data types** | Map, List, Text, MovableTree |
| **Features** | Time travel, undo/redo |
| **Languages** | Rust, WASM, Swift |
| **E2EE** | Not built in |

#### Assessment for Web of Trust

```
Advantages:
+ Best performance (memory, CPU, loading)
+ MovableTree for hierarchical data
+ Swift bindings for iOS
+ Active development

Disadvantages:
- No E2EE (build yourself)
- No DID
- CRDT engine only, no sync
```

**Recommendation:** If we choose the CRDT engine ourselves, Loro is the performance champion.

---

### Automerge + Yjs

Classic CRDT libraries, well-documented. No E2EE, no DID.

| Aspect | Yjs | Automerge |
|--------|-----|-----------|
| **Performance** | Very fast | Good |
| **Bundle size** | ~69KB | ~1.7MB (WASM) |
| **Community** | Very large | Large |
| **Bindings** | Many (ProseMirror, Monaco) | Fewer |
| **React Native** | Yes | WASM required |
| **Mobile init** | ~85ms (163KB doc) | ~6.4s (163KB doc) |

**Current decision (2026-03-15):** Yjs is the default CRDT. See the update note at the top of this document.

**Recommendation:** Good basis when building E2EE ourselves. The adapter architecture allows swapping between the two without touching business logic.

---

### Nostr

> Notes and Other Stuff Transmitted by Relays

**Website:** https://nostr.com/
**GitHub:** https://github.com/nostr-protocol/nips (~2.8k stars)
**Status:** Production (large ecosystem)
**Evaluated:** 2026-02-08

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | secp256k1 keypairs (like Bitcoin), npub/nsec encoding |
| **E2EE** | NIP-44: XChaCha20 + HMAC-SHA256 (DM encryption) |
| **Data model** | Events (JSON): kind, content, tags, sig |
| **Relay** | Dumb relays store events, client has the logic |
| **Transport** | WebSocket to relays (not P2P) |
| **Languages** | JS/TS (nostr-tools), Rust, Go, Python, Swift |
| **Ecosystem** | 30+ clients, 100+ relays, Zaps (Lightning), marketplace |

#### Architecture

```
Client A ─── WebSocket ──→ Relay 1 ←── WebSocket ─── Client B
                           Relay 2
                           Relay 3

Events are:
- Signed (secp256k1)
- Public or NIP-44 encrypted (DMs)
- Filtered via subscriptions (REQ/EVENT/CLOSE)
- Broadcast (not targeted delivery)
```

#### Assessment for Web of Trust (2026-02-08)

```
Advantages:
+ Large, active ecosystem (clients, relays, tools)
+ Simple protocol (JSON events + WebSocket)
+ Self-hostable relays (strfry, nostream)
+ Offline queue via relays (events are stored)
+ NIP-44 encryption for DMs
+ Community-driven, no single point of failure

Disadvantages:
- secp256k1 — NOT Ed25519! Fundamental crypto mismatch
- No item-key concept (per-recipient encryption missing)
- Recipient principle not representable (events belong to sender)
- Broadcast model vs. selective visibility (N of M)
- No DID support (own npub format)
- No CRDT support (events are append-only, no merging)
- Groups (NIP-29) are simple channels, no cryptographic group key
- Relay trust problematic (relay can censor/delete events)
```

**Recommendation:** Eliminated for WoT core. secp256k1 vs. Ed25519 is unbridgeable without a key translation layer. The broadcast model fundamentally contradicts our recipient principle. A Nostr bridge as optional export is conceivable, but not as messaging backend.

---

### Matrix

> Open standard for decentralised, real-time communication

**Website:** https://matrix.org/
**Spec:** https://spec.matrix.org/
**Status:** Production (Element, Beeper, Bundeswehr)
**Evaluated:** 2026-02-08

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | @user:homeserver.org (federated) |
| **E2EE** | Megolm (groups) + Olm/Vodozemac (1:1), Curve25519 + Ed25519 |
| **Data model** | Rooms with DAG of events |
| **Sync** | Federation between homeservers |
| **Transport** | HTTPS + optional WebSocket |
| **Languages** | JS (matrix-js-sdk), Rust (matrix-rust-sdk/vodozemac) |
| **Platforms** | Web, iOS, Android, desktop |
| **Keys** | Curve25519 + Ed25519 (compatible!) |

#### Architecture

```
Client A ──→ Homeserver A ←──Federation──→ Homeserver B ←── Client B
                  │                              │
                  └──── Room (DAG of Events) ────┘

E2EE:
- Olm: 1:1 Double Ratchet (Signal-like)
- Megolm: Group encryption (efficient for N recipients)
- Vodozemac: Rust implementation of Olm/Megolm
- Key verification: Emoji/QR code cross-signing
```

#### Assessment for Web of Trust (2026-02-08)

```
Advantages:
+ Ed25519 + Curve25519 — compatible with our crypto stack!
+ Proven E2EE (Megolm for groups, audited)
+ Rooms = natural model for groups/spaces
+ Federation = no single point of failure
+ Offline queue via homeserver (messages wait for recipient)
+ Bridges to other protocols (IRC, Slack, Signal, XMPP)
+ Huge ecosystem (Element, Beeper, 100M+ users)
+ Self-hostable (Synapse, Conduit, Dendrite)
+ matrix-rust-sdk + vodozemac = performant and audited

Disadvantages:
- Homeserver required (not true P2P, but self-hostable)
- No native DID support (Matrix IDs are @user:server)
- Matrix IDs are server-bound (migration complex)
- Overhead for simple messages (room creation, sync)
- Federation protocol complex (server-to-server)
- matrix-js-sdk is large (~500KB+)
```

**Recommendation:** Strongest candidate for the messaging axis. Ed25519 compatibility, proven group E2EE (Megolm), and offline queue via homeserver. For POC potentially overkill — minimal WebSocket relay as a stepping stone, with Matrix as the production target.

---

### DIDComm

> DID-based secure messaging

**Spec:** https://identity.foundation/didcomm-messaging/spec/v2.1/
**Status:** Spec v2.1 done (DIF), JS libs stale
**Evaluated:** 2026-02-08

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | did:key, did:web, did:peer (DID-native!) |
| **E2EE** | JWE (JSON Web Encryption), ECDH-ES+A256KW |
| **Data model** | Structured messages with protocols |
| **Transport** | Agnostic (HTTP, WebSocket, Bluetooth, QR code) |
| **Mediator** | Optional: message relay for offline delivery |
| **Languages** | Rust (didcomm-rs), JS (didcomm-node), Kotlin, Swift |
| **JS SDK** | `didcomm` npm — last updates 2023, TypeScript but stale |

#### Assessment for Web of Trust (2026-02-08)

```
Advantages:
+ DID-native! Exactly our identity model (did:key + Ed25519)
+ Transport-agnostic (HTTP, WS, BLE, QR — fits our offline vision)
+ Spec is mature (v2.1, DIF standard)
+ Structured protocols (Trust Ping, Issue Credential, Present Proof)
+ Perfect fit for verification/attestation delivery

Disadvantages:
- JS libraries are stale (npm didcomm: 2023, few downloads)
- Mediator infrastructure barely exists (would have to build ourselves)
- No group concepts in the spec
- No ecosystem for "simple" messaging use cases
- JWE overhead for simple messages
- DID resolver dependency (did:peer is complex)
```

**Recommendation:** Eliminated as messaging backend due to stale JS libs and missing mediator ecosystem. BUT: DIDComm message format as inspiration for our own messaging protocol — the structured protocols (Issue Credential, Present Proof) are directly relevant for attestation delivery.

---

### ActivityPub

> W3C standard for decentralized social networking

**Spec:** https://www.w3.org/TR/activitypub/
**Status:** W3C Recommendation (Mastodon, Pixelfed, Lemmy)
**Evaluated:** 2026-02-08

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | @user@server.org (federated, WebFinger) |
| **E2EE** | Not built in |
| **Data model** | ActivityStreams 2.0 (JSON-LD) |
| **Sync** | Server-to-server federation (inbox/outbox) |
| **Transport** | HTTPS (server required!) |
| **Offline** | Server-dependent |
| **Languages** | Various (server implementations) |

#### Assessment for Web of Trust (2026-02-08)

```
Advantages:
+ W3C standard (stable, widely adopted)
+ Huge ecosystem (Mastodon, 10M+ users)
+ Inbox/outbox model similar to our recipient principle
+ ActivityStreams 2.0 = well-defined vocabulary

Disadvantages:
- NO E2E encryption (knockout criterion!)
- Server required (no offline-first, no local-first)
- No DID support (WebFinger + HTTP signatures)
- No CRDT (server-authoritative)
- JSON-LD overhead (complex, hard to debug)
```

**Recommendation:** Eliminated. No E2EE and server requirement contradict our core principles. ActivityStreams 2.0 vocabulary as inspiration for our data model is conceivable, but not as a protocol.

---

### Iroh

> Build on a more open internet (n0-computer)

**Website:** https://iroh.computer/
**GitHub:** https://github.com/n0-computer/iroh (~2.5k stars)
**Status:** Beta (active development)
**Evaluated:** 2026-02-08

#### Properties

| Aspect | Details |
|--------|---------|
| **Focus** | Networking layer (connections + data transfer) |
| **Transport** | QUIC + NAT traversal (hole punching) |
| **Identity** | Ed25519 node IDs |
| **E2EE** | QUIC = mandatory TLS 1.3 |
| **Data model** | Blobs + hash-verified content (IPFS-inspired) |
| **CRDTs** | Not built in |
| **Messaging** | Not built in |
| **Languages** | Rust, with FFI bindings (Python, Swift, Kotlin) |
| **JS SDK** | No native JS support (WASM theoretically possible) |

#### Assessment for Web of Trust (2026-02-08)

```
Advantages:
+ Excellent NAT traversal (hole punching works reliably)
+ Ed25519 node IDs (compatible)
+ QUIC = performant and secure
+ Content-addressed blobs (good for file sharing)
+ Active development, good documentation

Disadvantages:
- ONLY a networking layer — not an app framework!
- No JS/Web SDK
- No CRDT, no messaging, no storage
- Would have to build everything on top of it ourselves
- Rust-only (FFI for mobile possible, but not for web)
```

**Recommendation:** Eliminated as a standalone solution — Iroh is a networking layer, not an app framework. Could serve as a transport layer under a CRDT framework (p2panda uses Iroh internally), but not directly usable in our TypeScript stack.

---

### Willow / Earthstar

> Willow: Data protocol for peer-to-peer data stores
> Earthstar: TypeScript implementation of Willow concepts

**Website:** https://willowprotocol.org/
**Earthstar GitHub:** https://github.com/earthstar-project/earthstar (~640 stars)
**Status:** Willow = spec beta, Earthstar = TypeScript (stagnating)
**Evaluated:** 2026-02-08

#### Properties

| Aspect | Details |
|--------|---------|
| **Identity** | Ed25519 keypairs (Willow namespaces) |
| **E2EE** | Meadowcap (capability-based!) |
| **Data model** | 3D entries: (namespace, subspace, path) + payload |
| **Sync** | WGPS (Willow General Purpose Sync) — Private Area Intersection |
| **Capabilities** | Meadowcap: delegatable, attenuatable capabilities (like UCAN!) |
| **Languages** | Willow: Rust (Aljoscha Meyer). Earthstar: TypeScript (gwil) |
| **Platforms** | Earthstar: Deno + Node + Browser |

#### Meadowcap Capabilities

```
Meadowcap is the capability system of Willow:

- Capabilities = signed tokens granting access to a 3D region
- Delegation: Alice passes Bob a restricted token
- Restriction: each delegation can ONLY restrict the region, never expand it
- Read + Write capabilities separate
- Similar to UCAN, but integrated into the sync engine

Example:
Alice has: write(namespace=group1, path=/*, subspace=*)
Alice delegates: write(namespace=group1, path=/events/*, subspace=bob)
  → Bob can only write events in his subspace
```

#### Assessment for Web of Trust (2026-02-08)

```
Advantages:
+ Meadowcap = exactly the capability model we need!
+ Ed25519 keys (compatible)
+ 3D data model ideal for spaces/modules (namespace=group, path=module)
+ Private area intersection = privacy-friendly sync
+ Architecturally the most elegant approach
+ Earthstar exists as a TypeScript implementation

Disadvantages:
- Earthstar stagnating (last commits months ago, gwil only dev)
- Willow Rust implementation not yet feature-complete
- Tiny community (~640 stars Earthstar, barely any users)
- No React integration, no UI bindings
- No E2EE for payload content (only access control via Meadowcap)
- No group encryption (Meadowcap ≠ encryption)
- Sync protocol complex and not yet battle-tested
```

**Recommendation:** Architecturally the most elegant (Meadowcap ≈ UCAN + sync). But too immature and too small a community for production. Meadowcap as inspiration for our AuthorizationAdapter. Monitor long-term — if the Willow Rust implementation matures and gets WASM bindings, it is the most natural fit.

---

### Subduction

> P2P sync protocol for efficient synchronization of encrypted, partitioned data

**GitHub:** https://github.com/inkandswitch/subduction (~35 stars)
**Developer:** Ink & Switch (makers of Automerge)
**Status:** Pre-Alpha — "DO NOT use for production use cases"
**Evaluated:** 2026-03-07

#### Properties

| Aspect | Details |
|--------|---------|
| **Core concept** | Sedimentree: hierarchical data structure for encrypted partitions |
| **Sync** | Hash-based diff on encrypted data (server never decrypts) |
| **Automerge** | Direct integration via `automerge_sedimentree` crate |
| **Transports** | WebSocket, HTTP long-poll, Iroh (QUIC) |
| **Language** | Rust (93.6%) + WASM bindings for browser/Node.js |
| **E2EE** | Native — sync operates at ciphertext level |
| **Crypto** | `subduction_crypto` crate (signed payloads) |

#### Comparison with Our Approach

| Aspect | WoT (current) | Subduction |
|--------|---------------|------------|
| Server sees plaintext? | No (AES-256-GCM) | No (Sedimentree) |
| Encryption where? | Client | Client |
| Merge where? | Client (CRDT) | Client (Automerge) |
| Sync efficiency | Full doc snapshot on requestSync | Hash-based diff on ciphertext |
| Language | TypeScript | Rust + WASM |

The key difference: **Sedimentree** allows the sync process itself to operate on encrypted data. The server can efficiently compute which partitions a peer needs without decrypting anything. With our approach the requesting client has to fetch the entire snapshot and merge locally.

#### Assessment for Web of Trust (2026-03-07)

Advantages:

- From Ink & Switch (Automerge makers) — deepest understanding of CRDTs + E2EE
- Sedimentree approach: more efficient sync than full doc snapshot
- Direct Automerge integration
- Server remains oblivious (zero-knowledge sync)

Disadvantages:

- Very early (v0.6.0, 35 stars, "DO NOT use for production")
- Rust + WASM — integration into our TypeScript ecosystem expensive
- Unstable API
- Small community, little documentation

**Recommendation:** Monitor. Subduction solves the same problem as our EncryptedSyncService + requestSync, but more efficiently. For our current scale (small docs, few users) our DIY approach is sufficient. If Subduction matures and offers stable WASM bindings, it could replace our sync layer — as a drop-in under the ReplicationAdapter.

---

## Why Do These Frameworks Lack DID Support?

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  1. Different design philosophies                           │
│     • Local-first: closed ecosystem                        │
│     • DIDs: universal interoperability                     │
│                                                             │
│  2. DIDs are "too much" for their use case                 │
│     • They only need a public key for crypto               │
│     • DID document is overhead                              │
│                                                             │
│  3. Resolver problem                                        │
│     • did:web requires HTTP (not offline-first!)           │
│     • did:key is self-describing, but why a DID string?    │
│                                                             │
│  4. Historical development                                  │
│     • CRDTs and DIDs evolved in parallel                   │
│     • The worlds are only meeting now                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Our Solution: DID Layer Over Framework

```typescript
// Framework stores bytes, we interpret as DID

class WotIdentity {
  private keyPair: KeyPair;

  // For external systems: DID
  get did(): string {
    return publicKeyToDid(this.keyPair.publicKey);
  }

  // For framework-internal use
  get publicKey(): Uint8Array {
    return this.keyPair.publicKey;
  }
}
```

---

## Framework-Agnostic Architecture (v2)

> See [adapter-architecture-v2.md](adapter-architecture-v2.md) for the complete adapter specification.

### Layer Model (updated 2026-02-08)

The v1 architecture had 2 adapters (Storage + Crypto). After recognizing that Messaging
and CRDT Replication are two orthogonal axes, we expanded to 6 adapters:

```
┌─────────────────────────────────────────────────────────────┐
│                     WoT Application                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              WoT Domain Layer                        │   │
│  │  • Identity, Contact, Verification, Attestation     │   │
│  │  • Item, Group, AutoGroup                           │   │
│  │  • Business Logic (Recipient Principle)             │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           6 WoT Adapter Interfaces                  │   │
│  │                                                     │   │
│  │  Existing (v1, implemented):                        │   │
│  │  • StorageAdapter       (local persistence)         │   │
│  │  • ReactiveStorageAdapter (live queries)            │   │
│  │  • CryptoAdapter        (signing/encryption/DID)    │   │
│  │                                                     │   │
│  │  New (v2):                                          │   │
│  │  • MessagingAdapter     (cross-user delivery)       │   │
│  │  • ReplicationAdapter   (CRDT sync + spaces)        │   │
│  │  • AuthorizationAdapter (UCAN-like capabilities)    │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│     ┌─────────┬───────────┼───────────┬─────────┐         │
│     ▼         ▼           ▼           ▼         ▼         │
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐      │
│  │ Yjs   │ │WebSock│ │Auto-  │ │Matrix │ │Custom │      │
│  │Storage│ │Relay  │ │merge  │ │Client │ │UCAN   │      │
│  └───────┘ └───────┘ └───────┘ └───────┘ └───────┘      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Three Sharing Patterns

The architecture must support three fundamentally different sharing patterns:

```
1. GROUP SPACES (Kanban, calendar, map)
   ├── Mechanism: ReplicationAdapter (CRDT sync)
   ├── Encryption: Group key (rotated on member change)
   ├── All members see all data in the space
   └── Example: Kanban board for a flat share → everyone sees all tasks

2. SELECTIVE SHARING (event for 3 of 10 contacts)
   ├── Mechanism: MessagingAdapter (item-key delivery)
   ├── Encryption: Item key per item, encrypted per recipient
   ├── Only selected recipients can decrypt
   └── Example: Calendar event only for Anna, Bob, Carl

3. 1:1 DELIVERY (attestation, verification)
   ├── Mechanism: MessagingAdapter (fire-and-forget)
   ├── Encryption: E2EE with recipient public key
   ├── Recipient principle: stored at the recipient
   └── Example: "Anton attests Bob: reliable"
```

### Adapter Interfaces (Overview)

The existing v1 interfaces (StorageAdapter, ReactiveStorageAdapter, CryptoAdapter)
remain unchanged. The three new v2 interfaces are specified in detail in
[adapter-architecture-v2.md](adapter-architecture-v2.md).

---

## Requirements Matrix (v2)

Mapping of WoT requirements against all evaluated candidates:

### CRDT/Sync Axis

| Requirement | Evolu | Automerge | Yjs | Jazz | p2panda |
|-------------|-------|-----------|-----|------|---------|
| Custom keys (BIP39 → Ed25519) | Yes | Self-build | Self-build | No | Yes |
| E2EE mandatory | Yes | Self-build | Self-build | Yes | Yes |
| React/React Native | Yes | WASM | Yes | Yes | No |
| Multi-device sync | Yes | Yes | Yes | Yes | Yes |
| Cross-user sync (spaces) | No | Yes | Yes | Yes (groups) | Yes |
| Offline-first | Yes | Yes | Yes | Yes | Yes |
| Production maturity | Yes | Yes | Yes | Beta | No |

### Messaging Axis

| Requirement | Matrix | Nostr | DIDComm | Custom WS |
|-------------|--------|-------|---------|-----------|
| Ed25519-compatible | Yes | No (secp256k1) | Yes (did:key) | Yes |
| E2EE (1:1) | Yes (Olm) | Yes (NIP-44) | Yes (JWE) | Yes (self-built) |
| E2EE (groups) | Yes (Megolm) | No | No | No (self-built) |
| Offline queue | Yes (homeserver) | Yes (relays) | Mediator | Yes (server) |
| DID addressing | No (@user:server) | No (npub) | Yes | Yes |
| Item-key delivery | Self-built | No | No | Yes |
| Recipient principle | Room model | Sender events | Yes | Yes |
| Self-hostable | Yes | Yes | Partial | Yes |
| JS SDK quality | Large | Good (nostr-tools) | Stale | Yes |

### WoT-Specific Requirements

| Requirement | Best candidate | Note |
|-------------|----------------|------|
| Recipient principle | Custom WS / DIDComm | No framework natively represents this |
| Item-key model (AES per item, encrypted per recipient) | Own implementation | CryptoAdapter has the primitives |
| Selective visibility (N of M) | Own implementation | Item key + MessagingAdapter |
| UCAN-like capabilities | Willow/Meadowcap (inspiration) | Own implementation, inspired by Meadowcap |
| Groups with admin + quorum | Own implementation | No framework has democratic groups |
| Social recovery (Shamir) | Own implementation | Planned in WotIdentity |

---

## Recommendations (updated 2026-02-08, v2)

### Core Insight

> **No single framework satisfies our requirements.**
>
> The WoT-specific requirements (recipient principle, item-key model, selective
> visibility, UCAN capabilities, democratic groups) are unique enough
> that they always require custom implementation — regardless of the chosen framework.
>
> **The right strategy: adapter architecture with swappable implementations.**

### Eliminated Candidates

| Candidate | Reason | Details |
|-----------|--------|---------|
| **ActivityPub** | No E2EE, server required | Contradicts local-first and privacy principles |
| **Nostr** | secp256k1 ≠ Ed25519 | Fundamental crypto mismatch, no item-key concept |
| **DXOS** | ECDSA P-256 ≠ Ed25519 | Crypto mismatch, no React Native |
| **DIDComm** | JS libs stale | Good spec, but ecosystem unusable (2023) |
| **Iroh** | Networking layer only | No JS SDK, no app framework |
| **p2panda** | No JS SDK | Architecturally ideal, but not usable for web |

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  CRDT/SYNC AXIS:                                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  POC:        Automerge (cross-user spaces)          │   │
│  │  Current:    Yjs (default since 2026-03-15)         │   │
│  │  Rationale:  76x faster on mobile, 25x smaller      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  MESSAGING AXIS:                                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  POC:    Custom WebSocket relay (minimal, DID-based)│   │
│  │  Target: Matrix (group E2EE, federation, audited)   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  AUTHORIZATION:                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Own implementation, inspired by Meadowcap           │   │
│  │  and UCAN (signed, delegatable capabilities)         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Tier Classification (v2)

**Tier 1: Current Implementation**

| Adapter | Implementation | Rationale |
|---------|----------------|-----------|
| StorageAdapter | YjsStorageAdapter | 76x faster on mobile, pure JS |
| ReactiveStorageAdapter | Yjs | Live queries via Subscribable |
| CryptoAdapter | WebCrypto + noble | Already implemented and tested |
| MessagingAdapter | Custom WebSocket relay | Minimal, DID-based, full control |

**Tier 2: Medium-term (after POC)**

| Adapter | Implementation | When |
|---------|----------------|------|
| ReplicationAdapter | YjsReplicationAdapter (default) | Done |
| AuthorizationAdapter | Custom UCAN-like | Done |
| MessagingAdapter | Matrix | When federation and group E2EE are needed |

**Tier 3: Long-term (monitor)**

| Framework | When relevant | Rationale |
|-----------|---------------|-----------|
| **NextGraph** | When JS SDK + custom keys available | Philosophically closest, RDF graph ideal |
| **p2panda** | When WASM bindings available | True P2P, LoRa/BLE for offline communities |
| **Willow/Earthstar** | When Earthstar is further developed | Meadowcap = most elegant capability model |
| **Keyhive** | When stable | BeeKEM for group key rotation |

**Tier 4: Building Blocks & Inspiration**

| Source | What we use |
|--------|-------------|
| **Meadowcap** (Willow) | Capability model for AuthorizationAdapter |
| **DIDComm** (spec) | Message format inspiration for MessagingAdapter |
| **Secsync** | Architecture reference for E2EE over CRDTs |
| **p2panda-encryption** | Group key rotation design |
| **Megolm** (Matrix) | Group encryption reference |

### Strategy (v2)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Phase 1: Foundation (done)                                │
│  • 6 adapter interfaces defined                            │
│  • Yjs for storage (76x faster on mobile)                 │
│  • Custom WebSocket relay for messaging                    │
│  • Attestation/verification delivery functional            │
│                                                             │
│  Phase 2: Selective Sharing (done)                         │
│  • Item-key model implemented (CryptoAdapter)              │
│  • MessagingAdapter: item-key delivery to N recipients     │
│  • AuthorizationAdapter: basic capabilities                │
│                                                             │
│  Phase 3: Groups (done)                                    │
│  • ReplicationAdapter: Yjs for shared spaces               │
│  • Group key management (Keyhive-inspired)                 │
│  • Calendar, Kanban, map modules                           │
│                                                             │
│  Phase 4: Scaling (future)                                 │
│  • MessagingAdapter: migration to Matrix                   │
│  • Federation for cross-server messaging                   │
│  • UCAN delegation chains                                  │
│  • Possibly p2panda/NextGraph when mature enough           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Why the Adapter Architecture is Critical

1. **No framework fits 100%** — custom implementation inevitable
2. **Technology landscape moves fast** — NextGraph, p2panda, Willow could be mature in 12 months
3. **Different axes, different solutions** — CRDT/sync and messaging are orthogonal problems
4. **Interfaces are cheap, implementations are expensive** — defining interfaces now forces requirements clarity
5. **Phased migration possible** — Custom WS → Matrix, Automerge → Yjs without touching business logic

---

## Sources

- [NextGraph](https://nextgraph.org/) — Decentralized, encrypted, local-first platform
- [Evolu](https://evolu.dev/) — Local-first platform with E2EE
- [Jazz](https://jazz.tools/) — Primitives for local-first apps
- [Secsync](https://github.com/nikgraf/secsync) — E2EE CRDT architecture
- [p2panda](https://p2panda.org/) — Modular P2P framework
- [DXOS](https://dxos.org/) — Decentralized developer platform
- [Keyhive](https://www.inkandswitch.com/keyhive/) — Group key management
- [Loro](https://loro.dev/) — High-performance CRDT library
- [Yjs](https://yjs.dev/) — Shared data types for collaboration
- [Automerge](https://automerge.org/) — JSON-like data structures that sync
- [Nostr](https://nostr.com/) — Notes and Other Stuff Transmitted by Relays
- [Matrix](https://matrix.org/) — Open standard for decentralised communication
- [DIDComm](https://identity.foundation/didcomm-messaging/spec/v2.1/) — DID-based secure messaging
- [ActivityPub](https://www.w3.org/TR/activitypub/) — W3C decentralized social networking
- [Iroh](https://iroh.computer/) — QUIC networking layer (n0-computer)
- [Willow Protocol](https://willowprotocol.org/) — Peer-to-peer data protocol
- [Earthstar](https://github.com/earthstar-project/earthstar) — TypeScript Willow implementation
- [UCAN](https://ucan.xyz/) — User Controlled Authorization Networks
- [awesome-local-first](https://github.com/alexanderop/awesome-local-first) — Curated list
