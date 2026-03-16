# Roadmap

> What's built, what's next, and what's on the horizon.

**Last updated:** 2026-03-16

---

## Completed

### Identity & Crypto (Phase 1)

- [x] BIP39 mnemonic generation (German wordlist)
- [x] HKDF key derivation (Ed25519, non-extractable)
- [x] did:key identifiers (W3C standard)
- [x] Passphrase-protected seed storage (PBKDF2 + AES-256-GCM)
- [x] X25519 ECIES asymmetric encryption
- [x] JWS profile signing and verification

### Verification & Contacts (Phase 1)

- [x] In-person QR verification (mutual, challenge-response)
- [x] Contact management (add, update, remove)
- [x] Offline verification (sync later)
- [x] Receiver Principle (data stored at recipient)

### Attestations (Phase 2)

- [x] Create, sign, and deliver attestations
- [x] End-to-end encrypted delivery via Relay
- [x] Outbox with retry for offline delivery
- [x] Accept/reject with metadata tracking
- [x] AttestationDeliveryService (automatic background delivery)

### Infrastructure (Phase 2-3)

- [x] **wot-relay** — WebSocket relay with delivery ACK, SQLite persistence
- [x] **wot-vault** — Encrypted document backup, capability-token auth
- [x] **wot-profiles** — JWS-signed public profiles, HTTP REST
- [x] Envelope auth (Ed25519 signed, replay protection)

### CRDT & Sync (Phase 3)

- [x] Yjs adapter (default — pure JS, 10-76x faster on mobile)
- [x] Automerge adapter (option — Rust/WASM)
- [x] CompactStore (IndexedDB, single snapshot per doc)
- [x] VaultPushScheduler (5s debounce)
- [x] Multi-device sync via Relay
- [x] PersonalDoc (profile, contacts, verifications, attestations, outbox, spaces, group keys)
- [x] Encrypted group spaces with member management
- [x] CRDT-agnostic adapter architecture (swap backends)

### Authorization (Phase 3)

- [x] AuthorizationAdapter interface
- [x] InMemoryAuthorizationAdapter
- [x] Capability primitives (create, verify, delegate, extract)
- [x] SignFn pattern (private key stays encapsulated)

### Discovery (Phase 3)

- [x] DiscoveryAdapter interface
- [x] HttpDiscoveryAdapter (wot-profiles)
- [x] OfflineFirstDiscoveryAdapter (cache + dirty flags)

### Developer Experience

- [x] 534 tests across 6 packages
- [x] 7 end-to-end tests (Playwright)
- [x] In-browser benchmark page (`/benchmark`)
- [x] npm packages: `@real-life/wot-core`, `@real-life/adapter-yjs`, `@real-life/adapter-automerge`
- [x] English documentation
- [x] CRDT switch via environment variable (`VITE_CRDT=yjs|automerge`)

---

## Next Up

### Offline E2E Tests (Done)

Comprehensive end-to-end tests for offline scenarios:

- [x] App start without network (load from CompactStore)
- [x] Edit profile, create attestation while offline
- [x] Reconnect → sync to other devices
- [x] Incoming attestations/verifications while offline → appear after reconnect
- [x] Tab close without internet → reopen → data persisted
- [x] Seed restore offline → online → Vault merge (no data loss)
- [x] Cave verification (both peers completely offline, sync later)
- [x] Outbox behavior (queue → online → flush → delivered)

### Package Separation (Done)

- [x] `@real-life/adapter-automerge` — separate package
- [x] `@real-life/adapter-yjs` — separate package
- [x] Automerge not loaded when using Yjs adapter

### NLNet Application (Deadline: April 1, 2026)

- [ ] Finalize application text
- [ ] Fill in contact information
- [ ] Review budget allocation (WP1 partially done)
- [ ] Submit

---

## Planned (funded via NLNet if accepted)

### WP1: Authorization & Capability System

- [ ] Persistent capability storage (currently in-memory only)
- [ ] Full delegation chain verification
- [ ] Space-level and item-level access control
- [ ] Capability revocation
- [ ] Integration with Vault for capability backup

### WP2: Social Recovery

- [ ] Shamir Secret Sharing for BIP39 seed
- [ ] Recovery shard distribution over verified contacts
- [ ] Threshold configuration (e.g., 3-of-5)
- [ ] Recovery flow with verification checks
- [ ] Threat model update

### WP3: Federated Messaging

- [ ] Evaluate Matrix vs. Nostr as production transport
- [ ] Implement selected protocol as MessagingAdapter
- [ ] Federation support (run your own relay/homeserver)
- [ ] Migration path from custom WebSocket relay

### WP4: Security Audit

- [ ] External review of crypto implementations
- [ ] Penetration testing of relay and profile services
- [ ] Key derivation and seed storage review
- [ ] GDPR compliance assessment
- [ ] Publish audit results

### WP5: Community Pilot

- [ ] Deploy with 2-3 real community groups
- [ ] User onboarding materials (multilingual)
- [ ] Developer integration guides
- [ ] API documentation

---

## Future / Research

### Content Types

- [ ] Calendar entries (shared scheduling)
- [ ] Map markers (community resources)
- [ ] Offers & requests (local exchange)
- [ ] Project boards (collaborative planning)

### Encrypted Blob Store (IPFS)

- [ ] Self-hosted IPFS node (Kubo) alongside Relay/Vault/Profiles
- [ ] Move avatars out of PersonalDoc to IPFS (reduces doc size)
- [ ] Client-side encryption before upload (AES-256-GCM)
- [ ] Three visibility tiers: public, contacts, space
- [ ] Shared symmetric key per scope, distributed via ECIES
- [ ] Content-addressed (CID) — deduplication and portability built-in
- [ ] See [concept](concepts/encrypted-blob-store.md)

### Selective Sharing UI

- [ ] Item-Key model exists in code but has no user-facing feature
- [ ] Choose who sees what: contacts, groups, or specific people

### Advanced Encryption

- [ ] Keyhive/BeeKEM — CRDT-native group E2EE (earliest 2027)
- [ ] MLS (RFC 9420) — standard group encryption
- [ ] Subduction (Ink&Switch) — next-gen Automerge sync with built-in encryption

### Graph CRDT for Trust Relations

- [ ] Evaluate NextGraph's RDF Graph CRDT for trust relationships
- [ ] Attestations and verifications as RDF triples
- [ ] SPARQL queries over the trust graph
- [ ] Conversation with Niko (NextGraph maintainer) pending

### Mobile & Native

- [ ] React Native or Tauri app
- [ ] iOS Keychain / Android Keystore for seed protection
- [ ] Push notifications

### Governance

- [ ] Quorum-based group governance (alternative to admin model)
- [ ] Sociocratic decision-making for spaces

### Real Life Stack Integration

- [ ] WoT Connector for Real Life Stack apps
- [ ] Kanban board module
- [ ] Calendar module
- [ ] Map module

---

*This roadmap reflects the project state as of 2026-03-16. For implementation details, see [CURRENT_IMPLEMENTATION.md](CURRENT_IMPLEMENTATION.md).*
