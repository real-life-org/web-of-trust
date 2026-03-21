# Glossary

> Term definitions for the Web of Trust

---

## A

### Attestation

A **signed statement** made by one person about another person. Attestations document past events or capabilities.

**Example:** "Ben helped in the community garden for 3 hours"

**Receiver Principle:** The attestation is stored at the **receiver** (`to`), not at the creator (`from`).

**Properties:**

- Always created by a user (not a group)
- Stored at the receiver
- May be associated with a group context
- Immutable (content cannot be changed after creation)
- Receiver can hide (`hidden=true`) but not delete
- Cryptographically signed by the creator

See also: [Verification](#verification), [Receiver Principle](#receiver-principle)

### AuthorizationAdapter

One of the 7 core adapters. Manages UCAN-inspired capability tokens for access control.

**Implementation:** `InMemoryAuthorizationAdapter` (POC/tests). `crypto/capabilities.ts` provides the core primitives: create, verify, delegate, extract.

See also: [Capability](#capability), [UCAN](#ucan-user-controlled-authorization-networks)

---

## B

### BIP39

A standard for generating a mnemonic phrase (12 or 24 words) that deterministically derives a cryptographic seed. The Web of Trust uses a custom German wordlist (dys2p/wordlists-de) with 12 words.

See also: [Mnemonic / Recovery Phrase](#mnemonic--recovery-phrase)

---

## C

### Capability

A cryptographically signed token that grants a specific permission to a specific audience. Inspired by UCAN and Willow/Meadowcap.

**Properties:**

- Offline-verifiable (no server lookup needed)
- Delegatable (can be passed to a third party with equal or fewer permissions)
- Attenuatable (subset of permissions only)
- SignFn pattern — private key stays encapsulated in WotIdentity

See also: [AuthorizationAdapter](#authorizationadapter), [UCAN](#ucan-user-controlled-authorization-networks)

### Claim

The free-text content of an attestation. Describes what is being attested.

**Example:** "Helped with the move — extremely reliable!"

### CompactStore

A custom local persistence layer built on IndexedDB. Stores CRDT snapshots as binary blobs (CRDT-agnostic). Replaces `automerge-repo`'s chunked IDB storage, which caused WASM out-of-memory errors at 40+ chunks.

**API:** `CompactStorageManager` — save/load snapshots keyed by document ID.

See also: [Four-Way Architecture](#four-way-architecture), [Vault](#vault)

### Contact

A person that a user has verified. Contacts have a status:

| Status | Description |
| ------ | ----------- |
| pending | Verified one-sided, waiting for the other side |
| active | Mutually verified |

### Content

Encrypted data that users share with their contacts. Types:

- Calendar entries
- Map markers
- Projects
- Attestations

### CRDT (Conflict-free Replicated Data Type)

A data structure that can be merged from multiple devices or users without conflicts. Used for all shared and personal documents in the Web of Trust.

**Current default:** Yjs (pure JavaScript, 76x faster on mobile vs Automerge).
**Alternative:** Automerge (Rust→WASM, available via `VITE_CRDT=automerge`).

See also: [Yjs](#yjs), [Four-Way Architecture](#four-way-architecture)

### CryptoAdapter

One of the 7 core adapters. Provides all cryptographic operations.

**Implementation:** `WebCryptoAdapter` — Ed25519 sign/verify, X25519 ECDH, AES-256-GCM symmetric encryption, HKDF key derivation.

---

## D

### DID (Decentralized Identifier)

A globally unique identifier for an identity that works without a central registration authority.

**Format in the Web of Trust:**
```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
        │ └──────────────────────────────────────────────┘
        │                    Ed25519 Public Key
        └─ Multibase prefix (z = base58btc)
```

The public key is encoded directly in the DID — no server lookup required.

See also: [did:key Usage](architecture/did-key.md)

### DiscoveryAdapter

One of the 7 core adapters. Finds and publishes public profiles.

**Implementations:**

- `HttpDiscoveryAdapter` — HTTP REST against the wot-profiles server
- `OfflineFirstDiscoveryAdapter` — Cache wrapper with dirty flags for offline use

---

## E

### E2EE (End-to-End Encryption)

Encryption where only the sender and receiver can read the message. The relay server sees only encrypted blobs.

**Pattern used:** Encrypt-then-sync — CRDT updates are encrypted before being forwarded by the relay.

### Ed25519

An algorithm for digital signatures. Used in the Web of Trust for all signing operations (identity, attestations, profiles, capabilities). Provides high security with short key lengths (32 bytes).

### Encrypted Sync

The process of encrypting CRDT state updates before sending them to the relay or vault. Implemented by `EncryptedSyncService` using AES-256-GCM with the group key for the space.

See also: [EncryptedSyncService](#encryptedsyncservice), [GroupKey](#groupkey)

### EncryptedSyncService

A service that encrypts and decrypts CRDT update bytes using AES-256-GCM. CRDT-agnostic — works with both Yjs and Automerge updates.

### Envelope Auth

Ed25519-signed message envelopes used to authenticate the sender of every relay message. Implemented in `crypto/envelope-auth.ts`. Prevents relay message spoofing.

See also: [Relay](#relay)

---

## F

### Four-Way Architecture

The four infrastructure components that together provide complete offline-first sync:

| Component | Purpose | CRDT-agnostic? |
| --- | --- | --- |
| **CompactStore** (IDB) | Local snapshots | Yes — stores bytes |
| **Relay** (WebSocket) | Real-time sync | Yes — forwards envelopes |
| **Vault** (HTTP) | Encrypted backup | Yes — stores encrypted bytes |
| **wot-profiles** (HTTP) | Discovery | Yes — profile server |

---

## G

### GroupKey

A symmetric AES-256-GCM key used to encrypt CRDT changes for a group space. Managed by `GroupKeyService`. Keys are versioned by generation — when membership changes (member added or removed), the key is rotated and the new generation is distributed to current members only.

See also: [GroupKeyService](#groupkeyservice), [SpaceHandle](#spacehandle)

### GroupKeyService

A service that manages group key lifecycle: generation, rotation, and distribution. One key per space per generation. Keys are stored in the `PersonalDoc` (`groupKeys` field).

---

## H

### HKDF (HMAC-based Key Derivation Function)

A cryptographic function used to derive multiple specialized keys from a single master secret. The Web of Trust uses HKDF to derive framework keys (e.g., for the vault, for X25519 key agreement) from the BIP39 master key.

---

## I

### ID Check Value

A shortened, human-readable representation of a DID for offline comparison.

**Format:** `a7f3-82b1-c9d4-e5f6`

Used when no internet is available and a profile cannot be loaded.

### Item

A single unit of content (calendar entry, map marker, etc.). In the POC model, each item has its own symmetric encryption key (Item Key).

### Item Key

**POC model:** A symmetric AES-256-GCM key that encrypts a single item. The item key is then asymmetrically encrypted for each recipient's public key (X25519 ECIES). Simple but requires per-item key management.

**Production direction:** Group keys via `GroupKeyService` and the `ReplicationAdapter` are the current production approach for shared spaces. Item Keys as a per-item mechanism are a POC pattern; for group collaboration, the space's GroupKey is used instead.

See also: [GroupKey](#groupkey), [GroupKeyService](#groupkeyservice)

---

## K

### Keychain / Keystore

The operating system's secure storage for cryptographic keys:

| Platform | Storage |
| -------- | ------- |
| iOS | Keychain |
| Android | Keystore |
| Web | Web Crypto API + IndexedDB |

---

## M

### MessagingAdapter

One of the 7 core adapters. Handles cross-user message delivery via the WebSocket relay.

**Implementations:**

- `WebSocketMessagingAdapter` — WebSocket client with heartbeat (ping/pong) and a message buffer for early messages received before handlers are registered
- `OutboxMessagingAdapter` — Decorator that queues messages until the relay is reachable
- `InMemoryMessagingAdapter` — Shared in-memory bus for tests

### MLS (Messaging Layer Security)

A protocol for secure group messaging. **Future consideration — not currently implemented.** The Web of Trust uses its own group key rotation scheme via `GroupKeyService`.

### Mnemonic / Recovery Phrase

A list of 12 words (BIP39) from which the private key can be deterministically derived. Used to restore the identity on a new device.

**Important:** Shown only once during identity creation. The user must write it down.

See also: [BIP39](#bip39), [Recovery](#recovery)

### Multi-Device

All devices with the same BIP39 seed have the same DID and the same keys. No login token, no server coordination needed for key access. Personal document sync between devices is handled by `YjsPersonalSyncAdapter` (Yjs) or `PersonalNetworkAdapter` (Automerge) via the relay.

---

## O

### Onboarding

The process of adding a new person to the network:

1. Install the app
2. Create a profile
3. Generate identity (Magic Words + passphrase)
4. Secure the recovery phrase (quiz)
5. First verification

### Outbox

A persistent queue for messages that could not be delivered because the relay was unreachable. Implemented by `OutboxMessagingAdapter` as a decorator around any `MessagingAdapter`. Messages are replayed automatically when connectivity is restored.

See also: [MessagingAdapter](#messagingadapter), [Relay](#relay)

---

## P

### Pending

An intermediate contact state when only one side has verified. Becomes "active" once the other side also verifies.

### PersonalDoc

A CRDT document that stores all private user data: profile, contacts, verifications, attestations, outbox, spaces, and group keys. Persisted via CompactStore (IndexedDB), backed up to the Vault, and synced across devices via the Relay.

**Default implementation:** `YjsPersonalDocManager` (Yjs, pure JavaScript).
**Alternative:** `PersonalDocManager` (Automerge, Rust→WASM).

### Private Key

The secret key of a user. Stored locally only (IndexedDB, passphrase-encrypted). Never leaves the device.

### Profile

The public information of a user:

- Name (self-chosen)
- Photo (optional)
- Bio (optional)
- DID
- Public Key

Profiles are JWS-signed and published to the wot-profiles server.

### Proof

A cryptographic proof that a document was signed by a specific person. Consists of a signature and metadata.

### Public Key

The public key of a user. Shared via QR code. Allows others to encrypt data for this user (X25519) and verify their signatures (Ed25519).

---

## Q

### QR Code

A two-dimensional code for exchanging identity information. Variants:

| Type | Contents | Use |
| ---- | -------- | --- |
| Standard | DID + Public Key | Verification |
| Invite | DID + Public Key + App link | Onboarding new users |

---

## R

### ReactiveStorageAdapter

An extension of the StorageAdapter that emits change events. Used by React hooks to automatically re-render when underlying data changes (e.g., `watchIdentity()`).

### Receiver Principle

A core principle of the Web of Trust: **verifications and attestations are stored at the receiver (`to`)**, not at the creator (`from`).

**Benefits:**

- Receiver controls what is published about them
- No write conflicts (everyone writes only to their own data store)
- Attestations can be hidden (`hidden=true`)

**Example:**

- Anna verifies Ben → verification is stored at **Ben**
- Ben attests Anna → attestation is stored at **Anna**

See also: [Attestation](#attestation), [Verification](#verification)

### Recovery

The process of restoring an identity on a new device using the recovery phrase.

### Relay

The WebSocket server (`wot-relay`) that routes encrypted messages between users by DID. CRDT-agnostic — it forwards opaque envelopes and does not see plaintext.

**Features:**

- DID-based routing
- Delivery ACK — messages are persisted until the client acknowledges receipt; undelivered messages are replayed on reconnect
- Multi-device — multiple connections per DID
- Heartbeat — ping/pong, detects dead connections
- SQLite persistence
- Live: `wss://relay.utopia-lab.org`

See also: [Envelope Auth](#envelope-auth), [Outbox](#outbox)

### ReplicationAdapter

One of the 7 core adapters. Provides CRDT-based group spaces with E2EE.

**Implementations:**

- `AutomergeReplicationAdapter` — Automerge + EncryptedSyncService + GroupKeyService
- `YjsReplicationAdapter` — Yjs + EncryptedSyncService + GroupKeyService

Interface exposes `SpaceHandle<T>`.

See also: [SpaceHandle](#spacehandle)

---

## S

### Self-Attestation

An attestation that a user creates about themselves.

**Example:** "I can repair bicycles"

### Signature

Cryptographic proof that a document was created by a specific person. The Web of Trust uses Ed25519 signatures.

### Space

An encrypted collaborative workspace shared between a group of members. Each space has its own CRDT document, its own group key (versioned by generation), and a membership list. Implemented via the `ReplicationAdapter`.

See also: [SpaceHandle](#spacehandle), [GroupKey](#groupkey)

### SpaceHandle

The interface returned by `ReplicationAdapter` when opening or creating a space. Provides:

- `getDoc()` — current CRDT document state
- `transact(fn)` — apply a mutation
- `onRemoteUpdate(cb)` — subscribe to remote changes
- `close()` — release resources

### StorageAdapter

One of the 7 core adapters. Provides CRUD operations for Identity, Contacts, Verifications, and Attestations on the local PersonalDoc.

**Implementations:**

- `YjsStorageAdapter` — uses YjsPersonalDocManager (default)
- `AutomergeStorageAdapter` — uses PersonalDocManager (option)

### Sybil Attack

An attack in which an attacker creates many fake identities. The Web of Trust prevents this by requiring in-person verification as the root of trust.

### Sync

The process of reconciling data between devices and servers. Works even after periods of offline use due to the CRDT merge semantics.

---

## T

### Tag

A keyword attached to an attestation to make it categorizable and filterable.

**Examples:** Garden, Help, Craft, Transport

---

## U

### UCAN (User Controlled Authorization Networks)

A standard for capability tokens that are self-certifying and delegatable without a central authority. The Web of Trust's `AuthorizationAdapter` and `crypto/capabilities.ts` are inspired by UCAN.

See also: [Capability](#capability), [AuthorizationAdapter](#authorizationadapter)

---

## V

### Vault

The encrypted backup server (`wot-vault`) that stores CRDT snapshots and change logs. Each document is stored as encrypted bytes — the vault has no access to plaintext.

**Features:**

- Append-only change log + snapshots
- Auth via signed capability tokens
- HTTP REST: `POST/GET changes`, `PUT snapshot`, `GET info`, `DELETE doc`
- SQLite persistence
- Port: 8789

**Push strategy:** `VaultPushScheduler` uses a 5-second debounce to avoid excessive writes. Vault is used for cross-device restore when the relay is unavailable or a fresh install needs historical data.

See also: [CompactStore](#compactstore), [Four-Way Architecture](#four-way-architecture)

### Verification

The mutual confirmation of identity through an in-person meeting. Confirms only "This is really this person" — nothing more.

**Receiver Principle:** The verification is stored at the **receiver** (`to`), not at the creator (`from`).

**Difference from Attestation:**

| Verification | Attestation |
| ------------ | ----------- |
| "I have met this person" | "This person did X" |
| Identity confirmation | Trust building |
| Once per contact | Any number possible |
| Cannot be hidden | Receiver can hide |

See also: [Attestation](#attestation), [Receiver Principle](#receiver-principle)

---

## W

### Web Crypto API

Browser API for cryptographic operations. Enables secure key generation and storage in the browser with `extractable: false`.

### WotIdentity

The core identity class (`packages/wot-core/src/identity/WotIdentity.ts`). Holds the non-extractable HKDF master key and provides all identity operations: signing, JWS signing, DID access, key derivation.

The private key never leaves the WotIdentity instance — all external callers use the `SignFn` pattern (pass a signing function, not the key).

See also: [DID](#did-decentralized-identifier), [Mnemonic / Recovery Phrase](#mnemonic--recovery-phrase)

---

## X

### X25519

An elliptic-curve Diffie-Hellman key agreement algorithm. Used in the Web of Trust for asymmetric encryption (ECIES pattern): the sender encrypts a symmetric key to the recipient's X25519 public key, derived from the same BIP39 seed as the Ed25519 signing key.

---

## Y

### Yjs

A pure-JavaScript CRDT library. The default CRDT in the Web of Trust since 2026-03-15.

**Why Yjs over Automerge:**

- 76x faster initialization on Android (85ms vs 6.4s for 163KB)
- 632x faster batch mutations (3ms vs 1.9s)
- 69KB bundle instead of 1.7MB
- No WASM, no main-thread blocking
- Built-in garbage collection (no history-stripping hack needed)

Automerge remains available as an alternative via `VITE_CRDT=automerge`.

See also: [CRDT](#crdt-conflict-free-replicated-data-type)

---

## See also

- [README](../README.md) — Vision and overview
- [Current Implementation](CURRENT_IMPLEMENTATION.md) — Implementation status
- [Flows](flows/README.md) — Detailed process descriptions
- [Architecture: Entities](architecture/entities.md) — Technical data structures
- [Architecture: did:key](architecture/did-key.md) — DID method rationale
- [Architecture: Encryption](architecture/encryption.md) — Encryption architecture
- [Concepts: Vault & Persistence](concepts/vault-and-persistence.md) — Vault sync patterns
- [Concepts: Social Recovery](concepts/social-recovery.md) — Seed backup via contacts
- [Research: Framework Evaluation](research/framework-evaluation.md) — 16 frameworks compared
- [Research: Decisions](research/decisions.md) — Architecture decision records
