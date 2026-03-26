# Sync Architecture

> How data flows between devices, services, and users in Web of Trust.

**Status:** Implemented (incl. Multi-Device)
**Last updated:** 2026-03-19

---

## Four-Way Architecture

Web of Trust uses four complementary sync paths. Each serves a different purpose:

```mermaid
graph TD
    App[App / CRDT Engine]

    CS[CompactStore<br/>IndexedDB]
    R[Relay<br/>WebSocket]
    V[Vault<br/>HTTP]
    P[wot-profiles<br/>HTTP]

    App -->|immediate| CS
    App -->|immediate| R
    App -->|5s debounce| V
    App -->|on profile change| P

    CS -->|on app start| App
    R -->|real-time| App
    V -->|on new device| App
    P -->|on seed restore| App

    style CS stroke:#4caf50,stroke-width:2px
    style R stroke:#2196f3,stroke-width:2px
    style V stroke:#ff9800,stroke-width:2px
    style P stroke:#9c27b0,stroke-width:2px
```

| Path | Transport | Purpose | Latency | Encryption |
|------|-----------|---------|---------|------------|
| **CompactStore** | IndexedDB | Local persistence | Immediate | At-rest (passphrase) |
| **Relay** | WebSocket | Real-time device-to-device sync | ~100ms | E2EE (envelope auth) |
| **Vault** | HTTPS | Encrypted backup & new device restore | 5s debounce | E2EE (AES-256-GCM) |
| **wot-profiles** | HTTPS | Public profile discovery | On change | JWS-signed (public) |

---

## Data Flow: Write

When the user makes a change (e.g., edits profile, adds contact):

```mermaid
sequenceDiagram
    participant User
    participant App
    participant CRDT as CRDT Engine<br/>(Yjs / Automerge)
    participant CS as CompactStore<br/>(IndexedDB)
    participant Relay as Relay<br/>(WebSocket)
    participant Vault as Vault<br/>(HTTP)

    User->>App: Edit profile
    App->>CRDT: Mutate Y.Doc
    CRDT->>CS: Save snapshot (immediate)
    CRDT->>Relay: Send encrypted update (immediate)
    CRDT->>Vault: Push snapshot (5s debounce)
    App->>User: UI updates instantly

    Note over CS: Crash-safe baseline
    Note over Relay: Other devices get update in ~100ms
    Note over Vault: Backup for new device restore
```

**Key design decisions:**
- **No debounce on Relay** — real-time sync is critical for multi-device UX
- **5s debounce on Vault** — reduces HTTP requests, Vault is backup not real-time
- **Immediate CompactStore** — crash-safe, always has latest state

## Data Flow: Read (App Start)

When the app starts, it loads data from the fastest available source:

```mermaid
flowchart TD
    Start([App Start]) --> CS{CompactStore<br/>has data?}

    CS -->|Yes| Load[Load from CompactStore<br/>~4ms IDB read]
    CS -->|No| Vault{Vault<br/>reachable?}

    Vault -->|Yes| Restore[Restore from Vault<br/>decrypt + apply]
    Vault -->|No| Profiles{wot-profiles<br/>has profile?}

    Profiles -->|Yes| Bootstrap[Bootstrap from profile<br/>+ verified contacts]
    Profiles -->|No| New[Empty doc<br/>first-time user]

    Load --> Connect[Connect to Relay]
    Restore --> Connect
    Bootstrap --> Connect
    New --> Connect

    Connect --> Sync[Receive queued messages<br/>from Relay]
    Connect --> SE[Send full state to own DID<br/>Multi-Device State Exchange]
    Connect --> VP[Vault Pull<br/>if seq changed]

    style Load stroke:#4caf50,stroke-width:2px
    style Restore stroke:#ff9800,stroke-width:2px
    style Bootstrap stroke:#9c27b0,stroke-width:2px
    style New stroke:#9e9e9e,stroke-width:2px
```

**Fallback chain:** CompactStore → Vault → wot-profiles → empty doc

**After connect:** Relay queued messages + State Exchange (full state to own DID) + Vault Pull (if seq changed). All merge via CRDT — order doesn't matter.

---

## Offline-First Behavior

### Everything works offline

All mutations happen locally first. The CRDT engine (Yjs or Automerge) handles conflict resolution automatically — no vector clocks, no manual merge, no server-side logic.

```
User edits profile while offline
    → CRDT mutated locally
    → CompactStore updated
    → Relay message queued (Outbox)
    → Vault push deferred

User comes online
    → Outbox flushes to Relay
    → Relay delivers queued messages from other devices
    → CRDT merges automatically
    → Vault receives latest snapshot
```

### Outbox Pattern

Messages that can't be delivered (offline, relay down) are queued in the Outbox:

```mermaid
sequenceDiagram
    participant App
    participant Outbox as Outbox<br/>(PersonalDoc)
    participant Relay as Relay

    App->>Outbox: Enqueue message
    Note over Outbox: Persisted in CRDT

    loop Every reconnect
        Outbox->>Relay: Send pending messages
        Relay->>Outbox: ACK
        Outbox->>Outbox: Dequeue on ACK
    end
```

### Relay ACK Protocol

The Relay persists messages until the recipient ACKs them. If a device disconnects before ACK, messages are redelivered on reconnect:

```mermaid
sequenceDiagram
    participant Alice
    participant Relay
    participant Bob

    Alice->>Relay: Send message to Bob
    Relay->>Relay: Persist in SQLite

    alt Bob is online
        Relay->>Bob: Deliver message
        Bob->>Relay: ACK (message_id)
        Relay->>Relay: Delete from queue
    else Bob is offline
        Note over Relay: Message stays in queue
        Note over Bob: Later...
        Bob->>Relay: Connect + register
        Relay->>Bob: Redeliver queued messages
        Bob->>Relay: ACK
    end
```

---

## Multi-Device Sync (Same Identity, Multiple Devices)

When the same identity (same BIP39 seed) is used on multiple devices, all data must stay in sync — personal data, spaces, items, and group keys.

### Sync Paths for Multi-Device

```mermaid
sequenceDiagram
    participant D1 as Device 1
    participant Relay
    participant Vault
    participant D2 as Device 2

    Note over D1,D2: Both devices share the same DID

    D1->>Relay: Content update (toDid: own DID)
    Relay->>D1: Echo (filtered by sentMessageIds)
    Relay->>D2: Delivered
    D2->>D2: Decrypt + Y.applyUpdate

    Note over D1,D2: On connect: full state exchange
    D1->>Relay: Full Y.Doc state (toDid: own DID)
    Relay->>D2: Full state
    D2->>D2: CRDT merge
```

### Three Sync Layers

| Layer | When | What | Handles |
|-------|------|------|---------|
| **Live Updates** | On every local change | Encrypted CRDT delta | Real-time sync when both online |
| **State Exchange** | On connect/reconnect | Full `Y.encodeStateAsUpdate(doc)` | Catch-up after offline period |
| **Vault Pull** | On start (if seq changed) | Encrypted snapshot from Vault | Safety net when relay queue lost |

All three layers feed into `Y.applyUpdate()` — CRDT merge is idempotent and order-independent.

### Key Design Decisions

- **Content updates include own DID** — `sendEncryptedUpdate` sends to ALL members including self. `sentMessageIds` prevents the sending device from processing its own echo. Other devices of the same DID receive and process normally.

- **State Exchange on every connect** — `_sendFullStateAllSpaces()` runs at start and on every reconnect. Sends full Y.Doc state for each space to own DID. Works even if the other device is offline (Relay queues).

- **Vault Pull with Seq comparison** — `_pullFromVault()` first calls `getDocInfo()` to check if `snapshotSeq` has changed. Skips full download if unchanged (saves bandwidth for single-device users).

- **Key Rotation reaches all devices** — `removeMember()` sends `group-key-rotation` to own DID (not just other members). Own encryption key is registered in `memberEncryptionKeys` at space creation. Rotated key is also saved to PersonalDoc for discovery on fresh start.

- **GroupKeyService reloads on requestSync** — `restoreSpacesFromMetadata()` re-imports group keys from PersonalDoc. This covers the edge case where the key-rotation message was lost but the key arrived via PersonalDoc sync.

### Personal Doc vs. Space Doc Sync

| Aspect | Personal Doc | Space Docs |
|--------|-------------|------------|
| Encrypted with | Personal key (HKDF from seed) | Group key (per space) |
| Sync to | Own DID only | All members + own DID |
| State Exchange | `YjsPersonalSyncAdapter.sendFullState()` | `YjsReplicationAdapter._sendFullStateAllSpaces()` |
| Vault backup | Automatic (5s debounce) | Automatic (5s debounce) |
| Contains | Profile, contacts, verifications, space metadata, group keys | Items, _meta (name, image, modules) |

### Future Optimizations

- **y-protocols** — Replace full state exchange with State Vector + Delta exchange (bytes instead of KB)
- **Stateless Multicast** — Single message to Relay with recipient list instead of N unicast messages

---

## Vault: Snapshot-Replace Pattern

The Vault uses **snapshot-replace** — each push replaces the previous snapshot entirely. We deliberately do not use incremental pushes:

1. **E2EE constraint** — Incremental push requires tracking which heads have already been sent. With encrypted data, the server cannot assist with head reconciliation.
2. **Small docs** — Our documents are 2–50 KB. A full snapshot push costs ~200–700ms (HTTP round-trip) and is negligible.
3. **Idempotency** — No ordering problems, no gaps, no need to track previous push state. Concurrent pushes from two devices result in last-write-wins, which is acceptable because the Relay keeps both devices in sync in real time.

### CRDT Serialization

| Operation | Yjs | Automerge |
|-----------|-----|-----------|
| Serialize for Vault | `Y.encodeStateAsUpdate(ydoc)` | `Automerge.save(doc)` |
| Restore from Vault | `Y.applyUpdate(ydoc, bytes)` | `Automerge.load(bytes)` |
| History overhead | Minimal (GC built-in) | <10% for additive changes |

---

## Invite Sync (Initial Space Join)

When a new member joins a space and no peers are online, the inviting peer sends a full snapshot:

```mermaid
sequenceDiagram
    participant Alice
    participant R as wot-relay
    participant Carla as Carla (new member)

    Alice->>Alice: Serialize full space doc
    Alice->>Alice: Encrypt with group key
    Alice->>R: Send snapshot to Carla
    R->>Carla: Forward
    Carla->>Carla: Decrypt + CRDT load
    Note over Carla: Has full space state without Alice staying online
```

After the invite, the Vault takes over as the persistent fallback.

---

## Encryption Layers

### Personal Doc (Multi-Device)

Same user, multiple devices. Encrypted with the user's personal key derived from BIP39 seed:

```
CRDT update → AES-256-GCM encrypt (personal key) → Relay → decrypt on other device
```

### Shared Spaces (Multi-User)

Multiple users collaborating. Encrypted with a shared group key:

```
CRDT update → AES-256-GCM encrypt (group key) → Relay → decrypt by group members
```

Group keys are managed by `GroupKeyService` with generation tracking for key rotation.

### Attestations (1:1 Delivery)

One sender, one recipient. Encrypted with recipient's public key (X25519 ECIES):

```
Attestation → ECIES encrypt (recipient public key) → Relay → decrypt by recipient
```

### Public Profiles

Not encrypted — intentionally public. Signed with Ed25519 (JWS) for authenticity:

```
Profile → JWS sign (private key) → wot-profiles server → anyone can verify
```

---

## CRDT Conflict Resolution

We use **Yjs** (default) or **Automerge** (option) for conflict-free merging. No manual conflict resolution needed.

| Data type | CRDT type | Conflict behavior |
|-----------|-----------|-------------------|
| Profile fields | Y.Map | Last writer wins (Lamport timestamp) |
| Contacts | Y.Map | Last writer wins per field |
| Attestations | Y.Map | Add-only (recipient stores) |
| Verifications | Y.Map | Add-only (immutable once created) |
| Outbox | Y.Map | Add/remove (dequeue on ACK) |
| Space metadata | Y.Map | Last writer wins |

### Why no Vector Clocks?

Yjs and Automerge use internal logical clocks (Lamport timestamps) for ordering. The CRDT handles merge semantics automatically. We don't implement external vector clocks — the CRDT is the source of truth.

---

## Services

### Relay Server (`wss://relay.utopia-lab.org`)

- **Package:** `@web.of.trust/relay`
- **Role:** Real-time message forwarding with delivery guarantee
- **Storage:** SQLite (message queue until ACK)
- **Auth:** Envelope auth (Ed25519 signed envelopes)
- **Sees:** Encrypted bytes, sender/recipient DIDs, timestamps
- **Cannot see:** Message content (E2EE)

### Vault Server (`https://vault.utopia-lab.org`)

- **Package:** `@web.of.trust/vault`
- **Role:** Encrypted document backup for new device restore
- **Storage:** SQLite (encrypted snapshots)
- **Auth:** Signed capability tokens
- **Pattern:** Snapshot-replace (not incremental)

### Profile Server (`https://profiles.utopia-lab.org`)

- **Package:** `@web.of.trust/profiles`
- **Role:** Public profile discovery (name, bio, avatar, verified contacts)
- **Storage:** SQLite (JWS-signed profiles)
- **Auth:** JWS verification (DID → public key → verify signature)

---

## Performance

### Yjs vs Automerge on Mobile

| Metric (Large doc, 500 contacts) | Yjs | Automerge |
|----------------------------------|-----|-----------|
| **Init (load from IDB)** | 85ms | 6.4s |
| **Mutate 100 contacts** | 3ms | 1.9s |
| **Serialize (snapshot)** | 112ms | 819ms |
| **Bundle size** | 69KB | 1.7MB (WASM) |

Yjs is the default since 2026-03-15 due to 10-76x better performance on mobile. See `/benchmark` page for live measurements on any device.

### Why Automerge is slow on mobile

Automerge compiles Rust to WASM. On mobile ARM chips (especially hardened browsers like Vanadium/GrapheneOS), WASM execution is significantly slower than native JavaScript. Yjs is pure JavaScript — no WASM, no compilation overhead.

---

---

## Future: Subduction

[Subduction](https://www.inkandswitch.com/) (Ink & Switch, pre-alpha) is the next-generation sync protocol that could replace both the Relay sync and the Vault backup pattern:

| Aspect | Current | Subduction |
| --- | --- | --- |
| Storage | Snapshot replace (HTTP) | Sedimentree (depth-indexed) |
| Sync | WebSocket push | Push + pull (WebSocket / QUIC) |
| Encryption | AES-256-GCM (EncryptedSyncService) | Keyhive (BeeKEM CGKA) |
| Key management | GroupKeyService (manual rotation) | Convergent capabilities |

The current architecture was designed as a **bridge to Subduction** — the server remains a blind blob store in both models. Earliest production-ready estimate: **end of 2026 / 2027**.

---

*Replaces: sync-protocol.md, 05-sync-technical.md, vault-and-persistence.md*
